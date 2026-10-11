//! The cloudflare substrate end to end: `bimo agent` applies worker agents
//! to a Bimo host Worker (engine/cloudflare/host) and every outbound request
//! they make goes through the host's credential gateway.
//!
//! Gated on `BIMO_CLOUDFLARE_E2E`:
//! - unset: writes a NOT_RUN report and passes;
//! - `local`: runs the host under `wrangler dev` (Dynamic Workers and
//!   Durable Objects run locally in workerd) with an upstream server on this
//!   host's loopback, and checks the whole failure list;
//! - anything else (`live` included, until a deployed host is approved)
//!   fails, so a requested run never shows as passed.
//!
//! Needs `npm ci` in engine/cloudflare/host. Every run writes
//! `.bimo/reports/<time>-cloudflare-<pid>.json`.
//!
//! Failure modes, written before the cases (plan:
//! docs/plans/2026-10-10-cloudflare-substrate.md):
//! - F1 apply reports ready for an agent that never accepted a task, or
//!   leaves its generation on the host after the failure;
//! - F2 a real value is visible to the agent (its env) or in a response from
//!   the host's control API;
//! - F3 the placeholder is not swapped on the secret's host;
//! - F4 the value is sent to an allowed host that is not the secret's;
//! - F5 a request to a host outside the allowlist leaves the gateway;
//! - F6 raw TCP from the agent reaches anything;
//! - F7 tenant B gets tenant A's value by sending A's placeholder;
//! - F8 a rotated value needs a restart (new generation) or is not used;
//! - F9 an outbound request has no audit line, or a line holds a value;
//! - F10 destroy is not idempotent or leaves the agent or route on the host;
//! - F11 the host accepts a missing or wrong operator token;
//! - F12 a value is stored in plaintext in Durable Object storage;
//! - F13 a value lands anywhere on the control host's disk;
//! - F14 the agent accepts a task without its control key;
//! - F15 a replaced generation is still reachable or keeps its route;
//! - F16 status does not match the host;
//! - F17 the gateway follows a redirect (a swapped value could follow it);
//! - F18 an agent name owned by one tenant can be taken by another.
mod common;

use common::live_gate::{repo, write_report};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const SUITE: &str = "cloudflare";
const TOKEN_ENV: &str = "BIMO_CF_E2E_TOKEN";
const TARGET: &str = "cf-local";
const SECRET_ENV: &str = "UPSTREAM_TOKEN";

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    fs::File::open("/dev/urandom").unwrap().read_exact(&mut buffer).unwrap();
    buffer.iter().map(|b| format!("{b:02x}")).collect()
}

fn base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn http() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .http_status_as_error(false)
        .proxy(None)
        .build()
        .new_agent()
}

/// (status, body) of one request; status 0 when nothing answered.
fn request(method: &str, url: &str, bearer: Option<&str>) -> (u16, String) {
    let agent = http();
    let result = match method {
        "POST" => {
            let mut call = agent.post(url);
            if let Some(token) = bearer {
                call = call.header("Authorization", format!("Bearer {token}"));
            }
            call.send_json(json!({"input": "e2e"}))
        }
        _ => {
            let mut call = agent.get(url);
            if let Some(token) = bearer {
                call = call.header("Authorization", format!("Bearer {token}"));
            }
            call.call()
        }
    };
    match result {
        Ok(mut response) => {
            let status = response.status().as_u16();
            (status, response.body_mut().read_to_string().unwrap_or_default())
        }
        Err(_) => (0, String::new()),
    }
}

/// One request the upstream server received.
#[derive(Clone, Debug)]
struct Seen {
    path: String,
    headers: BTreeMap<String, String>,
}

/// Plain-HTTP upstream on this host's loopback. `main` (127.0.0.1 and, when
/// it can bind, ::1 on the same port) stands for the allowed hosts; `side`
/// (::1 only) stands for a host outside the allowlist. It records what
/// arrives and answers `ok`; `/redirect` answers 302 to `/landed`.
struct Upstream {
    port: u16,
    side_port: Option<u16>,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Upstream {
    fn start() -> Self {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let main = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = main.local_addr().unwrap().port();
        Self::serve(main, port, seen.clone());
        if let Ok(v6) = TcpListener::bind(("::1", port)) {
            Self::serve(v6, port, seen.clone());
        }
        let side_port = TcpListener::bind("[::1]:0").ok().map(|side| {
            let side_port = side.local_addr().unwrap().port();
            Self::serve(side, side_port, seen.clone());
            side_port
        });
        Self { port, side_port, seen }
    }

    fn serve(listener: TcpListener, port: u16, seen: Arc<Mutex<Vec<Seen>>>) {
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let seen = seen.clone();
                std::thread::spawn(move || Self::answer(stream, port, seen));
            }
        });
    }

    fn answer(mut stream: TcpStream, port: u16, seen: Arc<Mutex<Vec<Seen>>>) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while head.len() < 65536 && !head.ends_with(b"\r\n\r\n") {
            match stream.read(&mut byte) {
                Ok(1) => head.push(byte[0]),
                _ => break,
            }
        }
        let text = String::from_utf8_lossy(&head).into_owned();
        let mut lines = text.split("\r\n");
        let path = lines.next().unwrap_or_default().split_whitespace().nth(1).unwrap_or_default().to_owned();
        let headers = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
            .collect();
        seen.lock().unwrap().push(Seen {
            path: path.clone(),
            headers,
        });
        let response = if path == "/redirect" {
            format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port}/landed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        } else {
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 3\r\nConnection: close\r\n\r\nok\n".to_owned()
        };
        let _ = stream.write_all(response.as_bytes());
    }

    fn find(&self, path: &str) -> Option<Seen> {
        self.seen.lock().unwrap().iter().find(|s| s.path == path).cloned()
    }
}

/// The host Worker under `wrangler dev`, in its own process group so the
/// whole tree (npx, wrangler, workerd) goes down with it.
struct Host {
    child: Child,
    url: String,
    persist: PathBuf,
}

impl Host {
    fn start(dir: &Path, token: &str) -> Result<Self, String> {
        let host_dir = repo().join("cloudflare/host");
        if !host_dir.join("node_modules/.bin/wrangler").exists() {
            return Err(format!("wrangler is not installed; run npm ci in {}", host_dir.display()));
        }
        let mut kek = [0u8; 32];
        fs::File::open("/dev/urandom").unwrap().read_exact(&mut kek).unwrap();
        let env_file = dir.join("host.env");
        fs::write(
            &env_file,
            format!("BIMO_OPERATOR_TOKEN={token}\nBIMO_VAULT_KEK={}\n", base64(&kek)),
        )
        .unwrap();
        let persist = dir.join("host-state");
        let port = free_port();
        let log = fs::File::create(dir.join("wrangler.log")).unwrap();
        let child = Command::new(host_dir.join("node_modules/.bin/wrangler"))
            .current_dir(&host_dir)
            .args(["dev", "--ip", "127.0.0.1", "--port", &port.to_string()])
            .args(["--inspector-port", &free_port().to_string()])
            .arg("--persist-to")
            .arg(&persist)
            .arg("--env-file")
            .arg(&env_file)
            .args(["--show-interactive-dev-session=false", "--log-level", "info"])
            .stdin(Stdio::null())
            .stdout(log.try_clone().unwrap())
            .stderr(log)
            .process_group(0)
            .spawn()
            .map_err(|e| format!("could not start wrangler: {e}"))?;
        let mut host = Self {
            child,
            url: format!("http://127.0.0.1:{port}"),
            persist,
        };
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            if request("GET", &format!("{}/healthz", host.url), None).0 == 200 {
                return Ok(host);
            }
            if let Ok(Some(status)) = host.child.try_wait() {
                return Err(format!("wrangler dev exited with {status}; see wrangler.log"));
            }
            if Instant::now() > deadline {
                return Err("wrangler dev did not answer /healthz within 90 s; see wrangler.log".to_owned());
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let group = self.child.id() as i32;
        unsafe { libc::killpg(group, libc::SIGTERM) };
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        unsafe { libc::killpg(group, libc::SIGKILL) };
        let _ = self.child.wait();
    }
}

/// `bimo agent` against one state root, with a transcript of every call.
struct Cli {
    dir: PathBuf,
    state_root: PathBuf,
    targets: PathBuf,
    env: BTreeMap<String, String>,
}

impl Cli {
    fn run(&self, args: &[&str]) -> (i32, Value) {
        let output = Command::new(env!("CARGO_BIN_EXE_bimo-engine"))
            .arg("agent")
            .args(args)
            .args(["--output", "json", "--state-root"])
            .arg(&self.state_root)
            .arg("--targets-config")
            .arg(&self.targets)
            .envs(&self.env)
            .output()
            .expect("could not run bimo-engine");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let envelope = serde_json::from_str(stdout.trim()).unwrap_or(Value::Null);
        let line = json!({"state_root": self.state_root.file_name().unwrap().to_string_lossy(), "args": args, "exit": output.status.code(), "envelope": envelope});
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join("transcript.jsonl"))
            .unwrap();
        writeln!(file, "{line}").unwrap();
        (output.status.code().unwrap_or(-1), envelope)
    }

    fn control_key(&self, name: &str) -> String {
        fs::read_to_string(self.state_root.join(name).join("control.key"))
            .unwrap_or_default()
            .trim()
            .to_owned()
    }
}

/// A worker spec for `name` in `tenant`, its source copied next to it.
fn write_spec(dir: &Path, name: &str, tenant: &str, fixture: &str, extra_allow: &[&str]) -> PathBuf {
    let source = dir.join(format!("{name}-src"));
    fs::create_dir_all(&source).unwrap();
    fs::copy(
        repo().join(format!("tests/fixtures/{fixture}/index.js")),
        source.join("index.js"),
    )
    .unwrap();
    let mut allow = vec!["\"localhost\"".to_owned(), "\"127.0.0.1\"".to_owned()];
    allow.extend(extra_allow.iter().map(|h| format!("\"{h}\"")));
    let text = format!(
        r#"schema_version = 1
name = "{name}"
tenant_id = "{tenant}"
runtime = "workerd"

[source]
kind = "config"
path = "{name}-src"

[[secrets]]
env = "{SECRET_ENV}"
handle = "{tenant}/upstream"
hosts = ["localhost"]

[egress]
allow = [{allow}]

[placement]
substrate = "{TARGET}"
"#,
        allow = allow.join(", ")
    );
    let path = dir.join(format!("{name}.toml"));
    fs::write(&path, text).unwrap();
    path
}

fn files_under(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => files_under(&path, out),
            Ok(kind) if kind.is_file() => out.push(path),
            _ => {}
        }
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle)
}

/// Files under `dir` holding any of `values`, by path relative to `dir`.
/// Never returns the values themselves.
fn files_holding(dir: &Path, values: &[&str]) -> Vec<String> {
    let mut files = Vec::new();
    files_under(dir, &mut files);
    files
        .into_iter()
        .filter(|path| {
            let bytes = fs::read(path).unwrap_or_default();
            values.iter().any(|v| contains(&bytes, v.as_bytes()))
        })
        .map(|path| path.strip_prefix(dir).unwrap_or(&path).display().to_string())
        .collect()
}

/// The suite's checks. A failed check never stops the run, so cleanup and
/// the report always happen; the test fails at the end.
#[derive(Default)]
struct Checks {
    list: Vec<Value>,
}

impl Checks {
    fn check(&mut self, id: &str, what: &str, ok: bool, detail: impl Into<String>) {
        let detail = detail.into();
        eprintln!("[{}] {id} {what}{}", if ok { "pass" } else { "FAIL" }, if ok { String::new() } else { format!(": {detail}") });
        self.list.push(json!({"id": id, "check": what, "ok": ok, "detail": detail}));
    }

    fn failed(&self) -> Vec<&Value> {
        self.list.iter().filter(|c| c["ok"] != true).collect()
    }
}

fn code(envelope: &Value) -> String {
    envelope["error"]["code"].as_str().unwrap_or("").to_owned()
}

#[test]
fn cloudflare_substrate() {
    let mode = bimo_engine::bimo::var("CLOUDFLARE_E2E").ok();
    match mode.as_deref() {
        None | Some("") => {
            let path = write_report(SUITE, "NOT_RUN", json!({"reason": "BIMO_CLOUDFLARE_E2E is not set"}));
            eprintln!("NOT RUN: BIMO_CLOUDFLARE_E2E is not set ({})", path.display());
            return;
        }
        Some("local") => {}
        Some(other) => {
            let path = write_report(
                SUITE,
                "BLOCKED",
                json!({"reason": format!("BIMO_CLOUDFLARE_E2E={other}: only 'local' is implemented; live needs a deployed host")}),
            );
            panic!("BIMO_CLOUDFLARE_E2E={other} is not supported yet ({})", path.display());
        }
    }

    let dir = repo().join("target/e2e-cloudflare").join(std::process::id().to_string());
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let token = random_hex(32);
    let upstream = Upstream::start();
    let host = match Host::start(&dir, &token) {
        Ok(host) => host,
        Err(reason) => {
            let path = write_report(SUITE, "FAIL", json!({"reason": reason, "run_dir": dir}));
            panic!("{reason} ({})", path.display());
        }
    };
    let started = Instant::now();
    let mut checks = Checks::default();
    let report = run(&dir, &host, &upstream, &token, &mut checks);
    let failed = checks.failed().len();
    let status = if failed == 0 { "PASS" } else { "FAIL" };
    let path = write_report(
        SUITE,
        status,
        json!({
            "mode": "local",
            "run_dir": dir,
            "elapsed_ms": started.elapsed().as_millis() as u64,
            "checks": checks.list,
            "failed": failed,
            "observed": report,
        }),
    );
    drop(host);
    eprintln!("report: {}", path.display());
    assert_eq!(failed, 0, "{failed} check(s) failed; see {}", path.display());
}

fn run(dir: &Path, host: &Host, upstream: &Upstream, token: &str, checks: &mut Checks) -> Value {
    let up = upstream.port;
    let value_a = format!("cfval-a-{}", random_hex(12));
    let value_a2 = format!("cfval-a2-{}", random_hex(12));
    let value_b = format!("cfval-b-{}", random_hex(12));
    let values = [value_a.as_str(), value_a2.as_str(), value_b.as_str()];
    let mut observed = json!({});

    let targets = dir.join("targets.toml");
    fs::write(
        &targets,
        format!(
            "schema_version = 1\ndefault_target = \"{TARGET}\"\n\n[[targets]]\nkind = \"cloudflare\"\nname = \"{TARGET}\"\nurl = \"{}\"\ntoken_env = \"{TOKEN_ENV}\"\n",
            host.url
        ),
    )
    .unwrap();
    let mut env = BTreeMap::new();
    env.insert(TOKEN_ENV.to_owned(), token.to_owned());
    env.insert("BIMO_SECRET_CFA__UPSTREAM".to_owned(), value_a.clone());
    env.insert("BIMO_SECRET_CFB__UPSTREAM".to_owned(), value_b.clone());
    env.insert("BIMO_READY_TIMEOUT_MS".to_owned(), "60000".to_owned());
    let mut cli = Cli {
        dir: dir.to_owned(),
        state_root: dir.join("state"),
        targets: targets.clone(),
        env,
    };
    let api = |path: &str| format!("{}{path}", host.url);

    // F11: the control API refuses a missing or wrong token, and so does
    // bimo when its token is wrong.
    let (none, _) = request("GET", &api("/v1/agents/cf-a/generations/1"), None);
    let (wrong, _) = request("GET", &api("/v1/agents/cf-a/generations/1"), Some("not-the-token"));
    let (right, _) = request("GET", &api("/v1/agents/cf-a/generations/1"), Some(token));
    checks.check("F11", "control API refuses no token and a wrong token", none == 401 && wrong == 401, format!("no token {none}, wrong {wrong}"));
    checks.check("F11", "control API accepts the suite's operator token", right == 404, format!("HTTP {right} (404 expected: nothing applied yet)"));
    let spec_a = write_spec(dir, "cf-a", "cfa", "cf-agent", &[]);
    let bad = Cli {
        env: cli.env.iter().map(|(k, v)| (k.clone(), if k == TOKEN_ENV { "wrong".to_owned() } else { v.clone() })).collect(),
        dir: dir.to_owned(),
        state_root: dir.join("state-badtoken"),
        targets: targets.clone(),
    };
    let (exit, envelope) = bad.run(&["apply", spec_a.to_str().unwrap()]);
    checks.check("F11", "apply with a wrong operator token fails as target_unavailable", exit != 0 && code(&envelope) == "target_unavailable", format!("exit {exit}, code {}", code(&envelope)));

    // F1: an agent that refuses its first task is never ready and leaves
    // nothing on the host.
    let spec_r = write_spec(dir, "cf-r", "cfa", "cf-agent-refuses", &[]);
    let (exit, envelope) = cli.run(&["apply", spec_r.to_str().unwrap()]);
    let (gen_r, _) = request("GET", &api("/v1/agents/cf-r/generations/1"), Some(token));
    let (route_r, _) = request("GET", &api("/v1/tenants/cfa/routes/cf-r-g1"), Some(token));
    checks.check("F1", "an agent that refuses tasks is not reported ready", exit != 0 && code(&envelope) == "probe_failed", format!("exit {exit}, code {}", code(&envelope)));
    checks.check("F1", "the failed apply leaves no generation or route on the host", gen_r == 404 && route_r == 404, format!("generation {gen_r}, route {route_r}"));

    // Agent A: applied, ready only once it accepted a task.
    let (exit, envelope) = cli.run(&["apply", spec_a.to_str().unwrap()]);
    let result = &envelope["result"];
    let endpoint_a = result["endpoint"].as_str().unwrap_or_default().to_owned();
    observed["apply_a"] = json!({"exit": exit, "generation": result["generation"], "ready_ms": result["ready_ms"], "endpoint": endpoint_a});
    checks.check(
        "F1",
        "apply of a working agent is ready with an accepted first task",
        exit == 0 && result["generation"] == 1 && result["first_task_id"].is_string() && !endpoint_a.is_empty(),
        format!("exit {exit}, code {}", code(&envelope)),
    );
    let key_a = cli.control_key("cf-a");

    // F14: the agent needs its control key.
    let (anonymous, _) = request("POST", &format!("{endpoint_a}/bimo/v1/tasks"), None);
    let (wrong_key, _) = request("POST", &format!("{endpoint_a}/bimo/v1/tasks"), Some("not-the-key"));
    let (keyed, _) = request("POST", &format!("{endpoint_a}/bimo/v1/tasks"), Some(&key_a));
    checks.check("F14", "a task without the control key is refused", anonymous == 401 && wrong_key == 401, format!("none {anonymous}, wrong {wrong_key}"));
    checks.check("F14", "a task with the control key is accepted", keyed == 202, format!("HTTP {keyed}"));

    // F2: the agent sees placeholders only; the control API returns no value.
    let (status, env_text) = request("GET", &format!("{endpoint_a}/test/env"), Some(&key_a));
    let agent_env: Value = serde_json::from_str(&env_text).unwrap_or(Value::Null);
    let placeholder_a = agent_env[SECRET_ENV].as_str().unwrap_or_default().to_owned();
    checks.check(
        "F2",
        "the agent's env holds the placeholder, not the value",
        status == 200 && placeholder_a.starts_with("monolith-placeholder-") && !values.iter().any(|v| env_text.contains(v)),
        format!("HTTP {status}, placeholder present: {}", !placeholder_a.is_empty()),
    );
    let mut leaked = Vec::new();
    for path in [
        "/v1/agents/cf-a/generations/1",
        "/v1/tenants/cfa/routes/cf-a-g1",
        "/v1/tenants/cfa/routes/cf-a-g1/audit",
    ] {
        let (_, body) = request("GET", &api(path), Some(token));
        if values.iter().any(|v| body.contains(v)) {
            leaked.push(path);
        }
    }
    checks.check("F2", "no control API response holds a value", leaked.is_empty(), format!("leaked in {leaked:?}"));

    let call = |endpoint: &str, key: &str, url: &str, header: &str| -> Value {
        let (status, body) = request(
            "GET",
            &format!("{endpoint}/test/call?url={url}&header=X-Token:{header}"),
            Some(key),
        );
        let mut value: Value = serde_json::from_str(&body).unwrap_or(json!({"raw": body}));
        value["agent_status"] = json!(status);
        value
    };

    // F3: swapped on the secret's host.
    let response = call(&endpoint_a, &key_a, &format!("http://localhost:{up}/f3"), SECRET_ENV);
    let seen = upstream.find("/f3");
    checks.check(
        "F3",
        "the placeholder is swapped for the value on the secret's host",
        seen.as_ref().and_then(|s| s.headers.get("x-token")).map(String::as_str) == Some(value_a.as_str()),
        format!("agent saw {}, upstream got the request: {}", response["status"], seen.is_some()),
    );
    checks.check(
        "F2",
        "the upstream's response reaches the agent without a value",
        response["status"] == 200 && !values.iter().any(|v| response.to_string().contains(v)),
        format!("agent saw {}", response["status"]),
    );

    // F4: not swapped on another allowed host.
    let response = call(&endpoint_a, &key_a, &format!("http://127.0.0.1:{up}/f4"), SECRET_ENV);
    let seen = upstream.find("/f4");
    let got = seen.as_ref().and_then(|s| s.headers.get("x-token")).cloned().unwrap_or_default();
    checks.check(
        "F4",
        "an allowed host that is not the secret's gets the placeholder",
        response["status"] == 200 && got == placeholder_a && !values.contains(&got.as_str()),
        format!("agent saw {}, upstream got a value: {}", response["status"], values.contains(&got.as_str())),
    );

    // F5: a host outside the allowlist is refused before anything leaves.
    let mut refused = Vec::new();
    if let Some(side) = upstream.side_port {
        let response = call(&endpoint_a, &key_a, &format!("http://[::1]:{side}/f5"), SECRET_ENV);
        refused.push(json!({"host": "[::1] (side listener)", "status": response["status"]}));
        checks.check(
            "F5",
            "a request to a host outside the allowlist is refused and never arrives",
            response["status"] == 403 && upstream.find("/f5").is_none(),
            format!("agent saw {}, arrived: {}", response["status"], upstream.find("/f5").is_some()),
        );
    } else {
        checks.check("F5", "a side listener on ::1 is available", false, "could not bind [::1]; F5 cannot observe a leak");
    }
    let response = call(&endpoint_a, &key_a, "http://example.com/f5b", SECRET_ENV);
    refused.push(json!({"host": "example.com", "status": response["status"]}));
    checks.check("F5", "an internet host outside the allowlist is refused", response["status"] == 403, format!("agent saw {}", response["status"]));
    observed["refused"] = json!(refused);

    // F6: raw TCP carries nothing.
    let (status, body) = request(
        "GET",
        &format!("{endpoint_a}/test/connect?host=127.0.0.1&port={up}"),
        Some(&key_a),
    );
    let connect: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    checks.check(
        "F6",
        "raw TCP from the agent reaches nothing",
        status == 200 && connect["reached"] == false && upstream.find("/tcp").is_none(),
        format!("HTTP {status}, agent: {connect}, arrived: {}", upstream.find("/tcp").is_some()),
    );
    observed["connect"] = connect;

    // F17: redirects go back to the agent.
    let response = call(&endpoint_a, &key_a, &format!("http://localhost:{up}/redirect"), SECRET_ENV);
    checks.check(
        "F17",
        "the gateway returns a redirect to the agent and does not follow it",
        response["status"] == 302 && upstream.find("/landed").is_none(),
        format!("agent saw {} (location {}), followed: {}", response["status"], response["location"], upstream.find("/landed").is_some()),
    );

    // Agent B in tenant cfb. F7: A's placeholder is not B's to swap.
    let spec_b = write_spec(dir, "cf-b", "cfb", "cf-agent", &[]);
    let (exit, envelope) = cli.run(&["apply", spec_b.to_str().unwrap()]);
    let endpoint_b = envelope["result"]["endpoint"].as_str().unwrap_or_default().to_owned();
    let key_b = cli.control_key("cf-b");
    checks.check("F7", "agent B (tenant cfb) applies", exit == 0, format!("exit {exit}, code {}", code(&envelope)));
    call(&endpoint_b, &key_b, &format!("http://localhost:{up}/f7-own"), SECRET_ENV);
    call(&endpoint_b, &key_b, &format!("http://localhost:{up}/f7"), &placeholder_a);
    let own = upstream.find("/f7-own").and_then(|s| s.headers.get("x-token").cloned()).unwrap_or_default();
    let cross = upstream.find("/f7").and_then(|s| s.headers.get("x-token").cloned()).unwrap_or_default();
    checks.check("F7", "B's own placeholder is swapped for B's value", own == value_b, format!("B got its value: {}", own == value_b));
    checks.check(
        "F7",
        "A's placeholder sent by B is not swapped",
        !placeholder_a.is_empty() && cross == placeholder_a,
        format!("upstream got A's value: {}", cross == value_a),
    );

    // F18: another tenant cannot take cf-a, even from another control plane.
    let other = Cli {
        state_root: dir.join("state-other"),
        dir: dir.to_owned(),
        targets: targets.clone(),
        env: cli.env.clone(),
    };
    let takeover_dir = dir.join("takeover");
    fs::create_dir_all(&takeover_dir).unwrap();
    let spec_t = write_spec(&takeover_dir, "cf-a", "cfb", "cf-agent", &[]);
    let (exit, envelope) = other.run(&["apply", spec_t.to_str().unwrap()]);
    let (still, _) = request("POST", &format!("{endpoint_a}/bimo/v1/tasks"), Some(&key_a));
    checks.check("F18", "another tenant's apply of the same name is a tenant conflict", exit != 0 && code(&envelope) == "tenant_conflict", format!("exit {exit}, code {}", code(&envelope)));
    checks.check("F18", "the owner's agent keeps serving", still == 202, format!("HTTP {still}"));

    // F8: rotation in place.
    cli.env.insert("BIMO_SECRET_CFA__UPSTREAM".to_owned(), value_a2.clone());
    let (exit, envelope) = cli.run(&["apply", spec_a.to_str().unwrap()]);
    let rotated = envelope["result"]["rotated"].as_array().cloned().unwrap_or_default();
    checks.check(
        "F8",
        "a changed value is rotated without a new generation",
        exit == 0 && envelope["result"]["generation"] == 1 && rotated.contains(&json!(SECRET_ENV)),
        format!("exit {exit}, generation {}, rotated {rotated:?}", envelope["result"]["generation"]),
    );
    call(&endpoint_a, &key_a, &format!("http://localhost:{up}/f8"), SECRET_ENV);
    let got = upstream.find("/f8").and_then(|s| s.headers.get("x-token").cloned()).unwrap_or_default();
    checks.check("F8", "the running agent's next request carries the new value", got == value_a2, format!("new value used: {}, old value used: {}", got == value_a2, got == value_a));

    // F9: one audit line per outbound request, no values.
    let (exit, envelope) = cli.run(&["logs", "cf-a", "--stream", "egress"]);
    let text = envelope["result"]["text"].as_str().unwrap_or_default().to_owned();
    let lines: Vec<Value> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let line_for = |path: &str| lines.iter().find(|l| l["audit"]["path"] == path).cloned().unwrap_or(Value::Null);
    let f3 = line_for("/f3");
    let f5 = line_for("/f5b");
    checks.check(
        "F9",
        "the swapped request is audited as allowed with the swapped header",
        exit == 0 && f3["audit"]["action"] == "allow" && f3["annotations"]["swapped"].to_string().contains("x-token"),
        format!("line: {f3}"),
    );
    checks.check(
        "F9",
        "the refused request is audited as rejected by the allowlist",
        f5["audit"]["action"] == "reject" && f5["rejected_by"] == "allowlist",
        format!("line: {f5}"),
    );
    let expected = ["/f3", "/f4", "/f5b", "/redirect", "/f8"];
    let missing: Vec<&str> = expected.iter().copied().filter(|p| line_for(p).is_null()).collect();
    checks.check("F9", "every outbound request has an audit line", missing.is_empty(), format!("missing {missing:?} of {} lines", lines.len()));
    checks.check("F9", "no audit line holds a value", !values.iter().any(|v| text.contains(v)), "a value appears in the audit");
    observed["audit_lines"] = json!(lines.len());

    // F12, F13 while values are stored: sealed on the host, absent here.
    let in_storage = files_holding(&host.persist, &values);
    checks.check("F12", "no value is stored in plaintext in host storage", in_storage.is_empty(), format!("found in {in_storage:?}"));

    // F15: a new generation retires the old one completely.
    let spec_a = write_spec(dir, "cf-a", "cfa", "cf-agent", &["example.com"]);
    let (exit, envelope) = cli.run(&["apply", spec_a.to_str().unwrap()]);
    let endpoint_a2 = envelope["result"]["endpoint"].as_str().unwrap_or_default().to_owned();
    let retired = envelope["result"]["retired"].as_array().map(Vec::len).unwrap_or(0);
    checks.check("F15", "a changed spec applies as generation 2", exit == 0 && envelope["result"]["generation"] == 2, format!("exit {exit}, generation {}", envelope["result"]["generation"]));
    let (old_task, _) = request("POST", &format!("{endpoint_a}/bimo/v1/tasks"), Some(&key_a));
    let (old_gen, _) = request("GET", &api("/v1/agents/cf-a/generations/1"), Some(token));
    let (old_route, _) = request("GET", &api("/v1/tenants/cfa/routes/cf-a-g1"), Some(token));
    let (new_task, _) = request("POST", &format!("{endpoint_a2}/bimo/v1/tasks"), Some(&key_a));
    checks.check(
        "F15",
        "generation 1 and its route are gone and unreachable",
        retired == 2 && old_task == 404 && old_gen == 404 && old_route == 404,
        format!("retired {retired}, old task {old_task}, old generation {old_gen}, old route {old_route}"),
    );
    checks.check("F15", "generation 2 serves", new_task == 202, format!("HTTP {new_task}"));
    let (_, envelope) = cli.run(&["logs", "cf-a", "--stream", "egress"]);
    let kept = envelope["result"]["text"].as_str().unwrap_or_default().contains("\"/f3\"");
    checks.check("F9", "generation 1's audit is kept after it is retired", kept, "the /f3 line is gone");

    // F16: status follows the host.
    let (_, envelope) = cli.run(&["status", "cf-a"]);
    checks.check(
        "F16",
        "status reports ready at generation 2",
        envelope["result"]["status"] == "ready" && envelope["result"]["generation"] == 2,
        format!("status {}, generation {}", envelope["result"]["status"], envelope["result"]["generation"]),
    );

    // F10: destroy is complete and idempotent.
    let (first, _) = cli.run(&["destroy", "cf-a"]);
    let (second, envelope) = cli.run(&["destroy", "cf-a"]);
    let destroyed_again = envelope["result"]["destroyed"].as_array().map(Vec::len).unwrap_or(99);
    let (gen2, _) = request("GET", &api("/v1/agents/cf-a/generations/2"), Some(token));
    let (route2, _) = request("GET", &api("/v1/tenants/cfa/routes/cf-a-g2"), Some(token));
    let (task2, _) = request("POST", &format!("{endpoint_a2}/bimo/v1/tasks"), Some(&key_a));
    checks.check("F10", "destroy succeeds twice, the second time with nothing to do", first == 0 && second == 0 && destroyed_again == 0, format!("exits {first}/{second}, second destroyed {destroyed_again}"));
    checks.check("F10", "the host keeps no generation, route or endpoint", gen2 == 404 && route2 == 404 && task2 == 404, format!("generation {gen2}, route {route2}, endpoint {task2}"));
    let (_, envelope) = cli.run(&["status", "cf-a"]);
    checks.check("F16", "status reports destroyed after destroy", envelope["result"]["status"] == "destroyed", format!("status {}", envelope["result"]["status"]));
    let (exit, _) = cli.run(&["destroy", "cf-b"]);
    checks.check("F10", "agent B is destroyed", exit == 0, format!("exit {exit}"));

    // F12, F13 at the end: nothing in host storage, nothing on this disk
    // (state roots, specs, transcript, the host's own log).
    let in_storage = files_holding(&host.persist, &values);
    checks.check("F12", "no value remains in host storage", in_storage.is_empty(), format!("found in {in_storage:?}"));
    let on_disk: Vec<String> = files_holding(dir, &values)
        .into_iter()
        .filter(|p| !p.starts_with("host-state"))
        .collect();
    checks.check("F13", "no value is on the control host's disk", on_disk.is_empty(), format!("found in {on_disk:?}"));
    observed
}
