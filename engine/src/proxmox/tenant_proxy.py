#!/usr/bin/env python3
"""Monolith tenant proxy supervisor (U7, stage 2).

Runs in a tenant's long-lived proxy guest, started by the guest's bind agent
as the unprivileged runtime user under the "upstream" egress lock. It holds
one iron-proxy instance per agent generation of that tenant (a "route"),
each with that agent's CA, secrets and allowlist, and puts one
authenticated front listener in front of them all.

Agents reach the front listener at <guest>:FRONT_PORT with the per-route
credential in their proxy URL (http://<route>:<token>@<guest>:<port>), which
every common client sends as Proxy-Authorization: Basic. The front refuses
(407) a request without it, with an unknown route, with a wrong token or
from an address other than the route's agent guest, and logs the refusal.
An accepted connection is spliced to that route's iron-proxy on loopback
with the credential removed. Routes are created by the control plane only,
so an agent of another tenant has no route here and no credential.

Everything secret lives in STATE (tmpfs, /dev/shm): the route directories
with the CA key, the management key and the secret files (0600 in 0700
directories), wiped when the supervisor starts. A guest restart empties it,
and the control plane then sees a new boot id: the routes are gone and the
agents that used them fail closed until they are applied again.

Control API (CONTROL_PORT, Bearer token whose SHA-256 the bind agent passed
in the environment; the token itself never reaches the guest's disk):
  GET    /health                 -> {"state", "boot_id", "api"} (no auth)
  GET    /status                 -> boot id and every route's state
  PUT    /routes/<id>            -> start (or replace) a route
  GET    /routes/<id>            -> one route's state
  POST   /routes/<id>/secrets    -> rewrite secret files, reload iron-proxy
  GET    /routes/<id>/audit      -> the route's iron-proxy JSON log (tail)
  DELETE /routes/<id>            -> stop the route and remove its files
"""
import base64
import ctypes
import hashlib
import hmac
import json
import os
import queue
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

API = 1
CONTROL_PORT = int(os.environ.get("MONOLITH_PROXY_CONTROL_PORT", "8080"))
FRONT_PORT = int(os.environ.get("MONOLITH_PROXY_FRONT_PORT", "3128"))
CONTROL_SHA256 = os.environ.get("MONOLITH_PROXY_CONTROL_SHA256", "")
IRON_PROXY = os.environ.get("MONOLITH_IRON_PROXY", "")
STATE = os.environ.get("MONOLITH_PROXY_STATE", "/dev/shm/monolith-proxy")
ROUTES_DIR = os.path.join(STATE, "routes")
LOGS_DIR = os.path.join(STATE, "logs")
REFUSALS = os.path.join(LOGS_DIR, "refusals.jsonl")
BOOT_ID = secrets.token_hex(8)
ROUTE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
FILE_NAME = re.compile(r"^(ca\.crt|ca\.key|management\.key|secrets/[A-Za-z_][A-Za-z0-9_]{0,127}\.secret)$")
PORT_NAMES = ("tunnel", "http", "https", "management", "metrics")
MAX_BODY = 1024 * 1024
MAX_HEAD = 64 * 1024
AUDIT_TAIL = 4 * 1024 * 1024
START_WAIT_S = 15


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def write_private(path, text):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    partial = path + ".tmp"
    fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.replace(partial, path)


def refuse_log(peer, route, reason):
    record = {"ts": time.time(), "peer": peer, "route": route, "reason": reason}
    try:
        with open(REFUSALS, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record) + "\n")
    except OSError:
        pass


def die_with_parent():
    """The iron-proxy children go when the supervisor goes. The death signal
    follows the thread that forked, so every child is forked by the one
    long-lived spawner thread below."""
    try:
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
    except OSError:
        pass


SPAWN = queue.Queue()


def spawner():
    while True:
        work, box = SPAWN.get()
        try:
            box["value"] = work()
        except Exception as error:  # handed back to the caller
            box["error"] = error
        box["done"].set()


def spawn(work):
    box = {"done": threading.Event()}
    SPAWN.put((work, box))
    box["done"].wait()
    if "error" in box:
        raise box["error"]
    return box["value"]


def kill_stale():
    """Stop iron-proxy processes a previous supervisor left (their files are
    about to be wiped, but they would keep the secrets in memory)."""
    me = os.getuid()
    try:
        pids = [p for p in os.listdir("/proc") if p.isdigit()]
    except OSError:  # no procfs (not Linux): nothing to find
        pids = []
    for pid in pids:
        try:
            if os.stat("/proc/" + pid).st_uid != me:
                continue
            with open("/proc/%s/cmdline" % pid, "rb") as handle:
                program = handle.read().split(b"\0", 1)[0].decode(errors="replace")
        except OSError:
            continue
        if program == IRON_PROXY and int(pid) != os.getpid():
            try:
                os.kill(int(pid), signal.SIGKILL)
            except OSError:
                pass


def port_free(port):
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    # As iron-proxy binds: a port in TIME_WAIT is free.
    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        probe.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        probe.close()


class Route:
    def __init__(self, route_id, token_sha256, source, ports):
        self.id = route_id
        self.token_sha256 = token_sha256
        self.source = source
        self.ports = ports
        self.dir = os.path.join(ROUTES_DIR, route_id)
        self.log = os.path.join(LOGS_DIR, route_id + ".jsonl")
        self.proc = None
        self.restarts = 0
        self.last_exit = None
        self.stopping = False
        self.lock = threading.Lock()

    def launch(self):
        with open(os.path.join(self.dir, "management.key"), encoding="utf-8") as handle:
            key = handle.read().strip()
        log = open(self.log, "ab")
        try:
            self.proc = spawn(lambda: subprocess.Popen(
                [IRON_PROXY, "-config", os.path.join(self.dir, "iron-proxy.yaml")],
                env={"IRON_MANAGEMENT_API_KEY": key, "HOME": self.dir, "PATH": "/usr/bin:/bin"},
                cwd=self.dir,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                close_fds=True,
                preexec_fn=die_with_parent,
            ))
        finally:
            log.close()

    def wait_listening(self, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                return False
            try:
                socket.create_connection(("127.0.0.1", self.ports["tunnel"]), timeout=0.5).close()
                return True
            except OSError:
                time.sleep(0.02)
        return False

    def stop(self):
        self.stopping = True
        proc = self.proc
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(3)

    def state(self):
        proc = self.proc
        running = proc is not None and proc.poll() is None
        return {
            "state": "running" if running else "restarting",
            "pid": proc.pid if proc is not None else None,
            "restarts": self.restarts,
            "last_exit": self.last_exit,
            "source": self.source,
            "tunnel_port": self.ports["tunnel"],
        }


ROUTES = {}
ROUTES_LOCK = threading.Lock()


def watch():
    """Restart a route's iron-proxy that exited, with backoff."""
    backoff = {}
    while True:
        time.sleep(1)
        with ROUTES_LOCK:
            routes = list(ROUTES.values())
        for route in routes:
            with route.lock:
                if route.stopping or route.proc is None or route.proc.poll() is None:
                    continue
                route.last_exit = route.proc.returncode
                wait_until = backoff.get(route.id, 0)
                if time.monotonic() < wait_until:
                    continue
                route.restarts += 1
                delay = min(2 ** min(route.restarts, 4), 10)
                backoff[route.id] = time.monotonic() + delay
                try:
                    route.launch()
                except OSError as error:
                    route.last_exit = "launch failed: %s" % error


# ---------------------------------------------------------------- front


def read_head(sock):
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(8192)
        if not chunk:
            return None, b""
        data += chunk
        if len(data) > MAX_HEAD:
            return None, b""
    head, rest = data.split(b"\r\n\r\n", 1)
    return head, rest


def answer(sock, status, reason, body, extra=""):
    data = json.dumps(body).encode()
    try:
        sock.sendall(
            ("HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\n%sConnection: close\r\n\r\n"
             % (status, reason, len(data), extra)).encode() + data
        )
    except OSError:
        pass


def credentials(lines):
    for line in lines[1:]:
        name, _, value = line.partition(":")
        if name.strip().lower() != "proxy-authorization":
            continue
        scheme, _, encoded = value.strip().partition(" ")
        if scheme.lower() != "basic":
            return None
        try:
            user, _, password = base64.b64decode(encoded.strip(), validate=True).decode("utf-8").partition(":")
        except (ValueError, UnicodeDecodeError):
            return None
        return user, password
    return None


def pipe(source, sink):
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            sink.sendall(data)
    except OSError:
        pass
    try:
        sink.shutdown(socket.SHUT_WR)
    except OSError:
        pass


def handle_front(client, peer):
    client.settimeout(30)
    try:
        head, rest = read_head(client)
    except OSError:
        client.close()
        return
    if head is None:
        client.close()
        return
    lines = head.decode("latin-1").split("\r\n")
    method = lines[0].split(" ", 1)[0].upper()
    pair = credentials(lines)
    if pair is None:
        refuse_log(peer, None, "no proxy credential")
        answer(client, 407, "Proxy Authentication Required", {"error": "proxy credential required"},
               'Proxy-Authenticate: Basic realm="monolith"\r\n')
        client.close()
        return
    route_id, token = pair
    with ROUTES_LOCK:
        route = ROUTES.get(route_id)
    if route is None or not hmac.compare_digest(digest(token), route.token_sha256):
        refuse_log(peer, route_id if ROUTE_ID.match(route_id or "") else None,
                   "unknown route" if route is None else "wrong token")
        answer(client, 407, "Proxy Authentication Required", {"error": "proxy credential refused"},
               'Proxy-Authenticate: Basic realm="monolith"\r\n')
        client.close()
        return
    if route.source and route.source != peer:
        refuse_log(peer, route_id, "wrong source address")
        answer(client, 407, "Proxy Authentication Required", {"error": "proxy credential refused"},
               'Proxy-Authenticate: Basic realm="monolith"\r\n')
        client.close()
        return
    kept = [lines[0]]
    for line in lines[1:]:
        name = line.partition(":")[0].strip().lower()
        if name == "proxy-authorization":
            continue
        if method != "CONNECT" and name in ("connection", "proxy-connection", "keep-alive"):
            continue
        kept.append(line)
    if method != "CONNECT":
        # One request per connection, so every request is authenticated.
        kept.append("Connection: close")
    try:
        upstream = socket.create_connection(("127.0.0.1", route.ports["tunnel"]), timeout=10)
    except OSError:
        answer(client, 503, "Service Unavailable", {"error": "the route's proxy is not running"})
        client.close()
        return
    client.settimeout(None)
    upstream.settimeout(None)
    try:
        upstream.sendall(("\r\n".join(kept) + "\r\n\r\n").encode("latin-1") + rest)
    except OSError:
        client.close()
        upstream.close()
        return
    worker = threading.Thread(target=pipe, args=(client, upstream), daemon=True)
    worker.start()
    pipe(upstream, client)
    worker.join(30)
    client.close()
    upstream.close()


def serve_front():
    listener = socket.create_server(("0.0.0.0", FRONT_PORT), backlog=256)
    while True:
        client, address = listener.accept()
        threading.Thread(target=handle_front, args=(client, address[0]), daemon=True).start()


# ---------------------------------------------------------------- control


class Handler(BaseHTTPRequestHandler):
    server_version = "monolith-tenant-proxy/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # nothing about requests reaches a log
        pass

    def reply(self, code, body, text=None):
        data = text if text is not None else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8" if text is not None else "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        header = self.headers.get("Authorization", "")
        token = header[7:] if header.startswith("Bearer ") else ""
        if not token or not CONTROL_SHA256 or not hmac.compare_digest(digest(token), CONTROL_SHA256):
            self.reply(401, {"error": "unauthorized"})
            return False
        return True

    def body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length <= 0 or length > MAX_BODY:
            self.reply(400, {"error": "a JSON body up to 1 MiB is required"})
            return None
        try:
            value = json.loads(self.rfile.read(length))
        except ValueError:
            self.reply(400, {"error": "body is not JSON"})
            return None
        if not isinstance(value, dict):
            self.reply(400, {"error": "body must be a JSON object"})
            return None
        return value

    def route_path(self):
        parts = self.path.split("/")
        # ['', 'routes', id] or ['', 'routes', id, action]
        if len(parts) in (3, 4) and parts[1] == "routes" and ROUTE_ID.match(parts[2]):
            return parts[2], (parts[3] if len(parts) == 4 else "")
        return None, None

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"state": "ready", "boot_id": BOOT_ID, "api": API})
            return
        if not self.authorized():
            return
        if self.path == "/status":
            with ROUTES_LOCK:
                routes = {rid: route.state() for rid, route in ROUTES.items()}
            self.reply(200, {"state": "ready", "boot_id": BOOT_ID, "api": API, "front_port": FRONT_PORT,
                             "routes": routes})
            return
        route_id, action = self.route_path()
        if route_id is None or action not in ("", "audit"):
            self.reply(404, {"error": "unknown endpoint"})
            return
        if action == "audit":
            path = os.path.join(LOGS_DIR, route_id + ".jsonl")
            try:
                with open(path, "rb") as handle:
                    handle.seek(0, os.SEEK_END)
                    size = handle.tell()
                    handle.seek(max(0, size - AUDIT_TAIL))
                    data = handle.read()
            except OSError:
                self.reply(404, {"error": "no audit log for this route"})
                return
            self.reply(200, None, text=data)
            return
        with ROUTES_LOCK:
            route = ROUTES.get(route_id)
        if route is None:
            self.reply(404, {"error": "no such route", "boot_id": BOOT_ID})
            return
        self.reply(200, dict(route.state(), boot_id=BOOT_ID))

    def do_DELETE(self):
        if not self.authorized():
            return
        route_id, action = self.route_path()
        if route_id is None or action:
            self.reply(404, {"error": "unknown endpoint"})
            return
        with ROUTES_LOCK:
            route = ROUTES.pop(route_id, None)
        if route is not None:
            with route.lock:
                route.stop()
            shutil.rmtree(route.dir, ignore_errors=True)
        self.reply(200, {"deleted": route is not None, "boot_id": BOOT_ID})

    def do_PUT(self):
        if not self.authorized():
            return
        route_id, action = self.route_path()
        if route_id is None or action:
            self.reply(404, {"error": "unknown endpoint"})
            return
        body = self.body()
        if body is None:
            return
        token_sha256 = body.get("token_sha256")
        source = body.get("source")
        ports = body.get("ports")
        config = body.get("config")
        files = body.get("files")
        if not isinstance(token_sha256, str) or not re.match(r"^[0-9a-f]{64}$", token_sha256):
            self.reply(400, {"error": "token_sha256 must be a hex SHA-256"})
            return
        if source is not None and not isinstance(source, str):
            self.reply(400, {"error": "source must be an address or null"})
            return
        if not isinstance(ports, dict) or sorted(ports) != sorted(PORT_NAMES) or not all(
                isinstance(ports[n], int) and 1024 <= ports[n] <= 65535 for n in PORT_NAMES):
            self.reply(400, {"error": "ports must name %s, each 1024-65535" % ", ".join(PORT_NAMES)})
            return
        if not isinstance(config, str) or not isinstance(files, dict) or not all(
                isinstance(k, str) and FILE_NAME.match(k) and isinstance(v, str) for k, v in files.items()):
            self.reply(400, {"error": "config must be text and files must map allowed names to text"})
            return
        for name in ("ca.crt", "ca.key", "management.key"):
            if name not in files:
                self.reply(400, {"error": "files must include " + name})
                return
        with ROUTES_LOCK:
            old = ROUTES.pop(route_id, None)
            taken = {p for r in ROUTES.values() for p in r.ports.values()}
        if old is not None:
            with old.lock:
                old.stop()
            shutil.rmtree(old.dir, ignore_errors=True)
        wanted = [ports[n] for n in PORT_NAMES]
        if len(set(wanted)) != len(wanted) or taken.intersection(wanted) or \
                {FRONT_PORT, CONTROL_PORT}.intersection(wanted) or not all(port_free(p) for p in wanted):
            self.reply(409, {"error": "ports in use; pick others"})
            return
        route = Route(route_id, token_sha256, source, ports)
        try:
            os.makedirs(route.dir, mode=0o700)
            write_private(os.path.join(route.dir, "iron-proxy.yaml"), config)
            for name, text in files.items():
                write_private(os.path.join(route.dir, name), text)
            route.launch()
        except OSError as error:
            shutil.rmtree(route.dir, ignore_errors=True)
            self.reply(500, {"error": "could not start the route: %s" % error})
            return
        if not route.wait_listening(START_WAIT_S):
            route.stop()
            shutil.rmtree(route.dir, ignore_errors=True)
            self.reply(500, {"error": "iron-proxy did not start for this route", "log": log_tail(route.log)})
            return
        with ROUTES_LOCK:
            ROUTES[route_id] = route
        self.reply(200, dict(route.state(), boot_id=BOOT_ID))

    def do_POST(self):
        if not self.authorized():
            return
        route_id, action = self.route_path()
        if route_id is None or action != "secrets":
            self.reply(404, {"error": "unknown endpoint"})
            return
        body = self.body()
        if body is None:
            return
        files = body.get("files")
        if not isinstance(files, dict) or not files or not all(
                isinstance(k, str) and k.startswith("secrets/") and FILE_NAME.match(k) and isinstance(v, str)
                for k, v in files.items()):
            self.reply(400, {"error": "files must map secrets/<ENV>.secret to the new values"})
            return
        with ROUTES_LOCK:
            route = ROUTES.get(route_id)
        if route is None:
            self.reply(404, {"error": "no such route", "boot_id": BOOT_ID})
            return
        for name, text in files.items():
            write_private(os.path.join(route.dir, name), text)
        with open(os.path.join(route.dir, "management.key"), encoding="utf-8") as handle:
            key = handle.read().strip()
        request = urllib.request.Request(
            "http://127.0.0.1:%d/v1/reload" % route.ports["management"],
            data=b"", method="POST", headers={"Authorization": "Bearer " + key})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(request, timeout=5) as response:
                status = response.status
        except urllib.error.HTTPError as error:
            status = error.code
        except OSError as error:
            self.reply(502, {"error": "reload failed: %s" % error})
            return
        if status != 200:
            self.reply(502, {"error": "iron-proxy reload answered HTTP %d" % status})
            return
        self.reply(200, {"reloaded": sorted(files)})


def log_tail(path):
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            handle.seek(max(0, handle.tell() - 2000))
            return handle.read().decode(errors="replace")
    except OSError:
        return ""


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass


def shutdown():
    """Stop every route's iron-proxy, wipe their files, then exit."""
    with ROUTES_LOCK:
        routes = list(ROUTES.values())
    for route in routes:
        route.stopping = True
        proc = route.proc
        if proc is not None and proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass
    shutil.rmtree(STATE, ignore_errors=True)
    os._exit(0)


def main():
    if not CONTROL_SHA256 or not os.path.isfile(IRON_PROXY):
        sys.exit("MONOLITH_PROXY_CONTROL_SHA256 and MONOLITH_IRON_PROXY are required")
    os.umask(0o077)
    kill_stale()
    shutil.rmtree(STATE, ignore_errors=True)
    os.makedirs(ROUTES_DIR, mode=0o700)
    os.makedirs(LOGS_DIR, mode=0o700)
    os.chmod(STATE, 0o700)
    signal.signal(signal.SIGTERM, lambda *_: shutdown())
    threading.Thread(target=spawner, daemon=True).start()
    threading.Thread(target=watch, daemon=True).start()
    threading.Thread(target=serve_front, daemon=True).start()
    Server(("0.0.0.0", CONTROL_PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
