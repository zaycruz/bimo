#!/usr/bin/env python3
"""Monolith warm launcher for Hermes (templates/README.md, "Warm runtimes").

Started by the bind agent in a pooled guest before any agent is claimed, as
the unprivileged runtime user and under the egress lock. It holds no tenant
secret, no control key and no CA, and it serves no task. It loads the
third-party modules Hermes imports, syncs Hermes's bundled skills into
HERMES_HOME (neither step reads agent configuration), then listens on the
task port for one go request:

  POST /monolith/warm/go   Authorization: Bearer <MONOLITH_WARM_TOKEN>
  {"env": {...}, "cwd": "...", "dirs": [...], "files": {"rel/path": "<base64>"}}

The token was minted for this guest by the control plane when it warmed the
guest; nothing else knows it. Every other request is answered 503. On go the
launcher writes the agent's files (its HERMES_HOME configuration and the
agent CA) under the runtime root, replaces its environment with the agent's,
closes the listener and runs `hermes gateway run` in this process, so the
modules it loaded are reused. Hermes modules that read configuration when
they are imported are imported only after go.

The go request is kept in the runtime root (mode 0600) so that a restart by
the bind agent's supervisor resumes the same agent without a new go.
"""
import base64
import hmac
import importlib
import json
import os
import socket
import sys
import time

ROOT = os.path.normpath(os.environ.get("MONOLITH_RUNTIME_ROOT", "/srv/monolith/runtime"))
PORT = int(os.environ.get("MONOLITH_WARM_PORT", "8080"))
TOKEN = os.environ.get("MONOLITH_WARM_TOKEN", "")
GO_PATH = "/monolith/warm/go"
GO_RECORD = os.path.join(ROOT, ".monolith-warm-go.json")
MAX_HEADER = 64 * 1024
MAX_GO = 16 * 1024 * 1024
HERE = os.path.dirname(os.path.abspath(__file__))


def note(text):
    print("[monolith-warm] " + text, flush=True)


def preload():
    started = time.monotonic()
    try:
        with open(os.path.join(HERE, "preload.txt")) as handle:
            names = [line.strip() for line in handle if line.strip() and not line.startswith("#")]
    except OSError:
        names = []
    loaded = 0
    for name in names:
        try:
            importlib.import_module(name)
            loaded += 1
        except Exception:  # absent optional modules are expected
            pass
    note("loaded %d of %d modules in %.0f ms" % (loaded, len(names), (time.monotonic() - started) * 1000))


def sync_skills():
    """Copy Hermes's bundled skills into HERMES_HOME now, so the gateway's
    own sync at start finds nothing to do. The sync reads no configuration."""
    started = time.monotonic()
    try:
        import tools.skills_sync as skills_sync
        skills_sync.sync_skills(quiet=True)
    except Exception as error:
        note("skills sync failed (the gateway will sync at start): %s" % error)
        return None
    note("synced bundled skills in %.0f ms" % ((time.monotonic() - started) * 1000))
    return skills_sync


def runtime_path(relative):
    parts = relative.split("/")
    if not relative or relative.startswith("/") or any(p in ("", ".", "..") for p in parts):
        raise ValueError("bad path %r" % relative)
    return os.path.join(ROOT, *parts)


def check_go(go):
    if not isinstance(go, dict):
        raise ValueError("go must be a JSON object")
    env, cwd = go.get("env"), go.get("cwd")
    if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
        raise ValueError("env must map strings to strings")
    if not isinstance(cwd, str) or not os.path.realpath(cwd).startswith(ROOT + "/"):
        raise ValueError("cwd must be inside " + ROOT)
    files, dirs = go.get("files", {}), go.get("dirs", [])
    if not isinstance(files, dict) or not all(isinstance(v, str) for v in files.values()):
        raise ValueError("files must map paths to base64 text")
    if not isinstance(dirs, list) or not all(isinstance(d, str) for d in dirs):
        raise ValueError("dirs must be a list of paths")
    for relative in list(files) + dirs:
        runtime_path(relative)
    return go


def reply(conn, code, body):
    data = json.dumps(body).encode()
    reason = {200: "OK", 400: "Bad Request", 401: "Unauthorized", 413: "Payload Too Large",
              503: "Service Unavailable"}.get(code, "Error")
    head = ("HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\n"
            "Connection: close\r\n\r\n" % (code, reason, len(data))).encode()
    try:
        conn.sendall(head + data)
    except OSError:
        pass


def read_request(conn):
    conn.settimeout(10)
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = conn.recv(65536)
        if not chunk:
            raise ValueError("connection closed")
        data += chunk
        if len(data) > MAX_HEADER and b"\r\n\r\n" not in data:
            raise ValueError("header too large")
    head, body = data.split(b"\r\n\r\n", 1)
    lines = head.decode("latin-1").split("\r\n")
    method, path = lines[0].split(" ")[:2]
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            key, value = line.split(":", 1)
            headers[key.strip().lower()] = value.strip()
    return method, path, headers, body


def serve_one(conn):
    """Answer one request. Returns the go request when it is the valid one."""
    try:
        method, path, headers, body = read_request(conn)
    except (OSError, ValueError, IndexError):
        return None
    if method != "POST" or path != GO_PATH:
        reply(conn, 503, {"state": "warm", "error": "no agent is bound to this runtime yet"})
        return None
    given = headers.get("authorization", "").encode()
    if not TOKEN or not hmac.compare_digest(given, ("Bearer " + TOKEN).encode()):
        reply(conn, 401, {"error": "the go token is wrong"})
        return None
    try:
        length = int(headers.get("content-length", "-1"))
    except ValueError:
        length = -1
    if length < 0 or length > MAX_GO:
        reply(conn, 413, {"error": "a JSON body up to %d bytes is required" % MAX_GO})
        return None
    try:
        while len(body) < length:
            chunk = conn.recv(min(length - len(body), 1024 * 1024))
            if not chunk:
                raise ValueError("the go body was cut short")
            body += chunk
        go = check_go(json.loads(body[:length]))
    except (OSError, ValueError) as error:
        reply(conn, 400, {"error": str(error)})
        return None
    reply(conn, 200, {"state": "going"})
    return go


def wait_for_go():
    server = socket.create_server(("0.0.0.0", PORT))
    note("warm; waiting for go on port %d" % PORT)
    try:
        while True:
            conn, _ = server.accept()
            try:
                go = serve_one(conn)
            finally:
                conn.close()
            if go is not None:
                return go
    finally:
        server.close()


def apply(go, skills_sync):
    for relative in go.get("dirs", []):
        os.makedirs(runtime_path(relative), exist_ok=True)
    user_skills = False
    for relative, data in go.get("files", {}).items():
        path = runtime_path(relative)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(base64.b64decode(data))
        user_skills = user_skills or relative.startswith("hermes-home/skills/")
    if skills_sync is not None and not user_skills:
        # The bundled skills are in place; the gateway's own sync would only
        # hash them again.
        skills_sync.sync_skills = lambda quiet=False: {}
    os.environ.clear()
    os.environ.update(go["env"])
    os.chdir(go["cwd"])
    # aiohttp builds its default verified SSL context when it is imported,
    # which was before the agent CA existed. Trust the CA in it now.
    ca = go["env"].get("SSL_CERT_FILE")
    connector = sys.modules.get("aiohttp.connector")
    context = getattr(connector, "_SSL_CONTEXT_VERIFIED", None)
    if ca and os.path.isfile(ca) and context is not None:
        context.load_verify_locations(cafile=ca)


def main():
    skills_sync = None
    try:
        with open(GO_RECORD) as handle:
            go = check_go(json.load(handle))
        note("resuming the agent bound before this restart")
    except FileNotFoundError:
        if not TOKEN:
            note("MONOLITH_WARM_TOKEN is not set; refusing to wait for go")
            return 2
        preload()
        skills_sync = sync_skills()
        go = wait_for_go()
        started = time.monotonic()
        fd = os.open(GO_RECORD, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump(go, handle)
        note("go received; recorded in %.0f ms" % ((time.monotonic() - started) * 1000))
    apply(go, skills_sync)
    sys.argv = ["hermes", "gateway", "run"]
    from hermes_cli.main import main as hermes_main
    return hermes_main()


if __name__ == "__main__":
    sys.exit(main())
