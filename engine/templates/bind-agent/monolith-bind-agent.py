#!/usr/bin/env python3
"""Monolith bind agent (KTD10), baked into the golden template.

A pooled guest starts unbound. At claim time the control plane posts one
per-claim payload (agent identity, tenant, generation) together with a
credential it minted for this guest only. The first bind wins; every later
bind is refused. Every other endpoint answers only with that credential.

After the bind, the control plane delivers the runtime through this agent
(U8): it uploads the runtime bundle, then starts the runtime, which runs as
the unprivileged user MONOLITH_RUNTIME_USER under this agent's supervision.

Credentials never enter an agent guest. An agent's runtime reaches its model
provider only through its tenant's credential proxy, which runs in a
separate, long-lived proxy guest (one per tenant): the runtime's
HTTP(S)_PROXY names that guest's address and port, with a per-agent proxy
credential. The egress lock (nftables) lets the runtime user connect to
that one address and port and to its own loopback port, and rejects
everything else, so a client that ignores the proxy variables fails instead
of leaking.

A proxy guest is bound with the payload role "proxy". Only such a guest may
start its runtime with the "upstream" egress mode, which lets the runtime
user (the tenant proxy) reach the internet but no private, link-local or
loopback-adjacent network except DNS.

The template carries no CA, key, secret or tenant data. The claim is kept in
/run (tmpfs), so it never reaches the template or a clone's disk.

Endpoints (port MONOLITH_BIND_PORT, default 7070); B = Bearer credential:
  GET  /health          -> {"state", "hostname", "template_version", "api": 3}
  POST /bind            -> {"state": "bound", "claim_id", "hostname"} | 409
  GET  /status       B  -> the bound claim
  PUT  /runtime/bundle B -> unpack a tar.gz runtime bundle (409 while running)
  POST /runtime/start  B -> lock egress (mode "proxy" or "upstream"), run the
                           runtime
  GET  /runtime      B  -> supervisor state (pid, restarts, last exit)
  GET  /runtime/log  B  -> the last 256 KiB of the runtime's output
  POST /probe/egress B  -> try a direct connection as the runtime user
  GET  /inspect      B  -> tar of the guest's writable state and every
                           process's environment, for audits
  GET  /processes    B  -> every process's pid, uid and command line (no
                           environment)

API 3 replaced API 2's loopback egress port and GET /tunnel (the relay to a
proxy on the control plane) with the direct path to the tenant proxy guest.
"""
import hashlib
import hmac
import io
import ipaddress
import json
import os
import pwd
import shutil
import socket
import subprocess
import sys
import tarfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

API_VERSION = 3
PORT = int(os.environ.get("MONOLITH_BIND_PORT", "7070"))
STATE_DIR = os.environ.get("MONOLITH_BIND_STATE_DIR", "/run/monolith")
SRV_DIR = os.environ.get("MONOLITH_SRV_DIR", "/srv/monolith")
RUNTIME_USER = os.environ.get("MONOLITH_RUNTIME_USER", "monolith-agent")
CLAIM_PATH = os.path.join(STATE_DIR, "claim.json")
RUNTIME_STATE = os.path.join(STATE_DIR, "runtime.json")
RUNTIME_DIR = os.path.join(SRV_DIR, "runtime")
RUNTIME_LOG = os.path.join(SRV_DIR, "runtime.log")
BUNDLE_PATH = os.path.join(SRV_DIR, "bundle.tgz")
VERSION_PATH = "/etc/monolith/template-version"
MAX_BODY = 64 * 1024
MAX_BUNDLE = 512 * 1024 * 1024
LOG_TAIL = 256 * 1024
INSPECT_PATHS = [SRV_DIR, STATE_DIR, "/etc/monolith", "/etc/environment", "/etc/profile.d",
                 "/tmp", "/var/tmp", "/root", "/home", "/var/log", "/dev/shm"]
INSPECT_FILE_CAP = 64 * 1024 * 1024
INSPECT_TOTAL_CAP = 512 * 1024 * 1024


def template_version():
    try:
        with open(VERSION_PATH, encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError:
        return None


def load_json(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def load_claim():
    return load_json(CLAIM_PATH)


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def runtime_ids():
    """uid, gid of the runtime user; None when not running as root."""
    if os.geteuid() != 0:
        return None
    entry = pwd.getpwnam(RUNTIME_USER)
    return entry.pw_uid, entry.pw_gid


def as_runtime_user():
    ids = runtime_ids()
    if ids is None:
        return {}
    return {"user": ids[0], "group": ids[1], "extra_groups": []}


# ---------------------------------------------------------------- egress


def egress_ruleset(uid, port, egress):
    """The runtime user's output policy. Every other user is untouched;
    replies on connections the runtime accepted are allowed."""
    head = (
        "table inet monolith_egress\n"
        "delete table inet monolith_egress\n"
        "table inet monolith_egress {\n"
        "  chain output {\n"
        "    type filter hook output priority 0; policy accept;\n"
        f"    meta skuid != {uid} accept\n"
        "    ct state established,related accept\n"
    )
    if egress["mode"] == "proxy":
        body = (
            f"    oifname \"lo\" tcp dport {port} accept\n"
            f"    ip daddr {egress['address']} tcp dport {egress['port']} accept\n"
            "    counter reject\n"
        )
    else:
        deny = ", ".join(egress["deny_cidrs"])
        body = (
            "    oifname \"lo\" accept\n"
            "    udp dport 53 accept\n"
            "    tcp dport 53 accept\n"
            "    meta nfproto ipv6 counter reject\n"
            + (f"    ip daddr {{ {deny} }} counter reject\n" if deny else "")
            + "    accept\n"
        )
    return head + body + "  }\n}\n"


def lock_egress(spec):
    """Install the runtime user's egress policy. In "proxy" mode (an agent
    guest) it may connect only to its tenant proxy and its own loopback
    port; in "upstream" mode (a proxy guest) it may reach public addresses
    and DNS, never a denied range."""
    ids = runtime_ids()
    if ids is None:
        raise RuntimeError("the egress lock needs root")
    nft = shutil.which("nft") or "/usr/sbin/nft"
    rules = egress_ruleset(ids[0], spec["port"], spec["egress"])
    result = subprocess.run([nft, "-f", "-"], input=rules.encode(), capture_output=True, timeout=10)
    if result.returncode != 0:
        raise RuntimeError("nft failed: " + result.stderr.decode(errors="replace").strip()[:400])


# ---------------------------------------------------------------- runtime


class Supervisor:
    def __init__(self):
        self.lock = threading.Lock()
        self.spec = None
        self.proc = None
        self.restarts = 0
        self.last_exit = None
        self.started_at = None

    def running(self):
        return self.spec is not None

    def start(self, spec):
        with self.lock:
            if self.spec is not None:
                return False
            self.spec = spec
        threading.Thread(target=self.loop, daemon=True).start()
        return True

    def launch(self):
        spec = self.spec
        log = open(RUNTIME_LOG, "ab")
        try:
            return subprocess.Popen(
                [spec["program"]] + spec["args"],
                env=spec["env"],
                cwd=spec["cwd"],
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                close_fds=True,
                **as_runtime_user(),
            )
        finally:
            log.close()

    def note(self, text):
        with open(RUNTIME_LOG, "ab") as log:
            log.write(("[monolith-bind-agent] " + text + "\n").encode())

    def loop(self):
        backoff = 1
        while True:
            try:
                proc = self.launch()
            except (OSError, subprocess.SubprocessError) as error:
                self.last_exit = "launch failed: %s" % error
                self.note(self.last_exit)
                time.sleep(backoff)
                backoff = min(backoff * 2, 10)
                continue
            self.proc = proc
            self.started_at = time.time()
            began = time.monotonic()
            code = proc.wait()
            self.last_exit = code
            self.restarts += 1
            self.note("runtime exited with %s; restarting" % code)
            if time.monotonic() - began > 30:
                backoff = 1
            time.sleep(backoff)
            backoff = min(backoff * 2, 10)

    def status(self):
        proc = self.proc
        return {
            "state": "running" if proc is not None and proc.poll() is None else
                     ("starting" if self.spec is not None else "none"),
            "pid": proc.pid if proc is not None else None,
            "restarts": self.restarts,
            "last_exit": self.last_exit,
            "started_at": self.started_at,
            "port": self.spec.get("port") if self.spec else None,
            "egress": self.spec.get("egress") if self.spec else None,
        }


SUPERVISOR = Supervisor()


def validate_egress(egress, claim):
    if not isinstance(egress, dict):
        return None, "egress must be an object: {\"mode\": \"proxy\", \"address\", \"port\"} or {\"mode\": \"upstream\", \"deny_cidrs\"}"
    mode = egress.get("mode")
    if mode == "proxy":
        try:
            address = ipaddress.IPv4Address(egress.get("address"))
        except (ipaddress.AddressValueError, ValueError, TypeError):
            return None, "egress.address must be an IPv4 address"
        port = egress.get("port")
        if address.is_loopback or address.is_unspecified or address.is_multicast:
            return None, "egress.address must be the tenant proxy guest's address"
        if not isinstance(port, int) or not 1 <= port <= 65535:
            return None, "egress.port must be a port number"
        return {"mode": "proxy", "address": str(address), "port": port}, None
    if mode == "upstream":
        payload = (claim or {}).get("payload") or {}
        if payload.get("role") != "proxy":
            return None, "only a guest bound as a proxy guest (payload role \"proxy\") may use upstream egress"
        cidrs = egress.get("deny_cidrs")
        if not isinstance(cidrs, list):
            return None, "egress.deny_cidrs must be a list of IPv4 CIDRs"
        clean = []
        for cidr in cidrs:
            try:
                network = ipaddress.ip_network(cidr, strict=False)
            except (ValueError, TypeError):
                return None, "egress.deny_cidrs holds an invalid CIDR"
            if network.version == 4:
                clean.append(str(network))
        return {"mode": "upstream", "deny_cidrs": clean}, None
    return None, "egress.mode must be \"proxy\" or \"upstream\""


def validate_start(body, claim):
    if not isinstance(body, dict):
        return None, "body must be a JSON object"
    program = body.get("program")
    args = body.get("args", [])
    env = body.get("env", {})
    cwd = body.get("cwd")
    port = body.get("port")
    if not isinstance(program, str) or not program.startswith("/"):
        return None, "program must be an absolute path"
    if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        return None, "args must be a list of strings"
    if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
        return None, "env must map strings to strings"
    real_cwd = os.path.realpath(cwd) if isinstance(cwd, str) else ""
    if real_cwd != RUNTIME_DIR and not real_cwd.startswith(RUNTIME_DIR + "/"):
        return None, "cwd must be inside " + RUNTIME_DIR
    if not os.path.isdir(real_cwd):
        return None, "cwd %s does not exist; upload the bundle first" % cwd
    if not isinstance(port, int) or not 1024 <= port <= 65535 or port == PORT:
        return None, "port must be a free port between 1024 and 65535"
    if "egress_port" in body and "egress" not in body:
        return None, "egress_port is API 2 (the control-plane relay); API 3 takes egress {mode, ...}"
    egress, error = validate_egress(body.get("egress"), claim)
    if error:
        return None, error
    if not os.path.isfile(program):
        return None, "program %s is not installed in this guest (rebuild the template)" % program
    return {
        "program": program,
        "args": args,
        "env": env,
        "cwd": cwd,
        "port": port,
        "egress": egress,
        "require_egress_lock": body.get("require_egress_lock", True) is not False,
    }, None


def run_runtime(spec):
    """Lock egress and start supervising. Raises on a
    failure that must keep the runtime from starting."""
    try:
        lock_egress(spec)
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        if spec["require_egress_lock"]:
            raise RuntimeError("could not lock the runtime's egress: %s" % error)
    return SUPERVISOR.start(spec)


def chown_tree(root):
    ids = runtime_ids()
    if ids is None:
        return
    for dirpath, dirnames, filenames in os.walk(root):
        os.lchown(dirpath, ids[0], ids[1])
        for name in dirnames + filenames:
            os.lchown(os.path.join(dirpath, name), ids[0], ids[1])


# ---------------------------------------------------------------- inspect


def write_inspect(out):
    """Stream a tar of the guest's writable state plus every process's
    environment and command line. Large files are skipped and listed."""
    manifest = {"skipped": [], "paths": INSPECT_PATHS, "processes": []}
    total = 0
    with tarfile.open(fileobj=out, mode="w|") as tar:
        def add_bytes(name, data):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mtime = int(time.time())
            tar.addfile(info, io.BytesIO(data))

        for top in INSPECT_PATHS:
            if not os.path.lexists(top):
                continue
            walker = [(os.path.dirname(top), [], [os.path.basename(top)])] if not os.path.isdir(top) \
                else os.walk(top)
            for dirpath, _dirs, files in walker:
                for name in files:
                    path = os.path.join(dirpath, name)
                    try:
                        if os.path.islink(path) or not os.path.isfile(path):
                            continue
                        size = os.path.getsize(path)
                        if size > INSPECT_FILE_CAP or total + size > INSPECT_TOTAL_CAP:
                            manifest["skipped"].append({"path": path, "size": size})
                            continue
                        with open(path, "rb") as handle:
                            data = handle.read(INSPECT_FILE_CAP)
                    except OSError as error:
                        manifest["skipped"].append({"path": path, "error": str(error)})
                        continue
                    total += len(data)
                    add_bytes("fs" + path, data)
        pids = sorted(p for p in os.listdir("/proc") if p.isdigit()) if os.path.isdir("/proc") else []
        for pid in pids:
            entry = {"pid": int(pid)}
            for part in ("environ", "cmdline"):
                try:
                    with open("/proc/%s/%s" % (pid, part), "rb") as handle:
                        data = handle.read(1024 * 1024)
                except OSError as error:
                    entry[part + "_error"] = str(error)
                    continue
                add_bytes("proc/%s/%s" % (pid, part), data)
            manifest["processes"].append(entry)
        add_bytes("inspect-manifest.json", json.dumps(manifest, indent=1).encode())


def list_processes():
    out = []
    for pid in sorted((p for p in os.listdir("/proc") if p.isdigit()), key=int) if os.path.isdir("/proc") else []:
        try:
            with open("/proc/%s/cmdline" % pid, "rb") as handle:
                cmdline = [part.decode(errors="replace") for part in handle.read(4096).split(b"\0") if part]
            uid = os.stat("/proc/%s" % pid).st_uid
        except OSError:
            continue
        out.append({"pid": int(pid), "uid": uid, "cmdline": cmdline})
    return out


PROBE_SCRIPT = (
    "import json, socket, sys\n"
    "try:\n"
    "    socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=5).close()\n"
    "    print(json.dumps({'connected': True}))\n"
    "except OSError as error:\n"
    "    print(json.dumps({'connected': False, 'error': str(error)}))\n"
)


# ---------------------------------------------------------------- HTTP


class Handler(BaseHTTPRequestHandler):
    server_version = "monolith-bind/3"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet: no payload in the journal
        pass

    def reply(self, code, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def not_here(self):
        self.reply(404, {"error": "unknown endpoint", "api": API_VERSION})

    def authorized(self):
        claim = load_claim()
        header = self.headers.get("Authorization", "")
        token = header[7:] if header.startswith("Bearer ") else ""
        if not claim or not token or not hmac.compare_digest(digest(token), claim["credential_sha256"]):
            self.reply(401, {"error": "unauthorized"})
            return None
        return claim

    def body_length(self, cap):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length <= 0 or length > cap:
            return None
        return length

    def json_body(self):
        length = self.body_length(MAX_BODY)
        if length is None:
            self.reply(400, {"error": "a JSON body up to 64 KiB is required"})
            return None
        try:
            return json.loads(self.rfile.read(length))
        except ValueError:
            self.reply(400, {"error": "body is not JSON"})
            return None

    def do_GET(self):
        if self.path == "/health":
            claim = load_claim()
            self.reply(200, {
                "state": "bound" if claim else "unbound",
                "hostname": socket.gethostname(),
                "template_version": template_version(),
                "api": API_VERSION,
            })
            return
        if self.path not in ("/status", "/runtime", "/runtime/log", "/inspect", "/processes"):
            self.not_here()
            return
        claim = self.authorized()
        if claim is None:
            return
        if self.path == "/status":
            self.reply(200, {
                "state": "bound",
                "claim_id": claim["claim_id"],
                "hostname": socket.gethostname(),
                "payload": claim["payload"],
                "api": API_VERSION,
            })
        elif self.path == "/runtime":
            self.reply(200, SUPERVISOR.status())
        elif self.path == "/runtime/log":
            try:
                with open(RUNTIME_LOG, "rb") as handle:
                    handle.seek(0, os.SEEK_END)
                    size = handle.tell()
                    handle.seek(max(0, size - LOG_TAIL))
                    data = handle.read()
            except OSError:
                data = b""
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        elif self.path == "/processes":
            self.reply(200, {"processes": list_processes()})
        elif self.path == "/inspect":
            self.close_connection = True
            self.send_response(200)
            self.send_header("Content-Type", "application/x-tar")
            self.send_header("Connection", "close")
            self.end_headers()
            write_inspect(self.wfile)
            self.wfile.flush()

    def do_PUT(self):
        if self.path != "/runtime/bundle":
            self.not_here()
            return
        if self.authorized() is None:
            return
        if SUPERVISOR.running():
            self.reply(409, {"error": "a runtime is already running in this guest"})
            return
        length = self.body_length(MAX_BUNDLE)
        if length is None:
            self.reply(400, {"error": "a tar.gz body up to 512 MiB is required"})
            return
        os.makedirs(SRV_DIR, exist_ok=True)
        with open(BUNDLE_PATH, "wb") as handle:
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(remaining, 1024 * 1024))
                if not chunk:
                    break
                handle.write(chunk)
                remaining -= len(chunk)
        if remaining:
            os.unlink(BUNDLE_PATH)
            self.reply(400, {"error": "the bundle upload was cut short"})
            return
        shutil.rmtree(RUNTIME_DIR, ignore_errors=True)
        os.makedirs(RUNTIME_DIR, mode=0o750)
        try:
            with tarfile.open(BUNDLE_PATH, "r:gz") as tar:
                tar.extractall(RUNTIME_DIR, filter="data")
        except (tarfile.TarError, OSError, ValueError) as error:
            shutil.rmtree(RUNTIME_DIR, ignore_errors=True)
            self.reply(400, {"error": "could not unpack the bundle: %s" % error})
            return
        finally:
            try:
                os.unlink(BUNDLE_PATH)
            except OSError:
                pass
        chown_tree(RUNTIME_DIR)
        self.reply(200, {"state": "unpacked", "bytes": length})

    def do_POST(self):
        if self.path == "/bind":
            self.bind()
            return
        if self.path not in ("/runtime/start", "/probe/egress"):
            self.not_here()
            return
        claim = self.authorized()
        if claim is None:
            return
        body = self.json_body()
        if body is None:
            return
        if self.path == "/runtime/start":
            spec, error = validate_start(body, claim)
            if error:
                self.reply(400, {"error": error})
                return
            if SUPERVISOR.running():
                self.reply(409, {"error": "a runtime is already running in this guest"})
                return
            try:
                record = json.dumps(spec).encode("utf-8")
                fd = os.open(RUNTIME_STATE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "wb") as handle:
                    handle.write(record)
                run_runtime(spec)
            except (RuntimeError, OSError) as error:
                try:
                    os.unlink(RUNTIME_STATE)
                except OSError:
                    pass
                self.reply(500, {"error": str(error)})
                return
            self.reply(200, SUPERVISOR.status())
        else:
            host = body.get("host")
            port = body.get("port")
            if not isinstance(host, str) or not isinstance(port, int):
                self.reply(400, {"error": "host and port are required"})
                return
            result = subprocess.run([sys.executable, "-c", PROBE_SCRIPT, host, str(port)],
                                    capture_output=True, timeout=15, env={"PATH": "/usr/bin:/bin"},
                                    **as_runtime_user())
            try:
                answer = json.loads(result.stdout)
            except ValueError:
                answer = {"connected": False, "error": result.stderr.decode(errors="replace")[:400]}
            self.reply(200, answer)

    def bind(self):
        body = self.json_body()
        if body is None:
            return
        claim_id = body.get("claim_id")
        credential = body.get("credential")
        payload = body.get("payload")
        if not isinstance(claim_id, str) or not isinstance(credential, str) or len(credential) < 32 \
                or not isinstance(payload, dict):
            self.reply(400, {"error": "claim_id, credential (>= 32 chars) and payload are required"})
            return
        record = json.dumps({
            "claim_id": claim_id,
            "credential_sha256": digest(credential),
            "payload": payload,
        }).encode("utf-8")
        os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
        try:
            # O_EXCL: the first bind wins, even under concurrent requests.
            fd = os.open(CLAIM_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            self.reply(409, {"error": "this guest is already bound"})
            return
        with os.fdopen(fd, "wb") as handle:
            handle.write(record)
            handle.flush()
            os.fsync(handle.fileno())
        self.reply(200, {"state": "bound", "claim_id": claim_id, "hostname": socket.gethostname()})


def resume():
    """After a bind-agent restart, bring the runtime back up."""
    spec = load_json(RUNTIME_STATE)
    if spec and load_claim():
        try:
            run_runtime(spec)
        except (RuntimeError, OSError) as error:
            SUPERVISOR.last_exit = str(error)


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):  # a dropped peer is not news
        pass


def main():
    server = Server(("0.0.0.0", PORT), Handler)
    resume()
    server.serve_forever()


if __name__ == "__main__":
    main()
