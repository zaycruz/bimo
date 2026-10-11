//! The cloudflare substrate end to end: `bimo agent` applies worker agents
//! to a Bimo host Worker (engine/cloudflare/host) and every outbound request
//! they make goes through the host's credential gateway.
//!
//! Gated on `BIMO_CLOUDFLARE_E2E`:
//! - unset: writes a NOT_RUN report and passes;
//! - `local`: runs the host under `wrangler dev` (Dynamic Workers and
//!   Durable Objects run locally in workerd) with an upstream server on this
//!   host's loopback that records what arrives. Needs `npm ci` in
//!   engine/cloudflare/host.
//! - `live`: a deployed host at `BIMO_CLOUDFLARE_URL`, operator token in
//!   `BIMO_CLOUDFLARE_TOKEN`. Requests leave from Cloudflare's network, so
//!   public echo services stand in for the upstreams (httpbin.org is the
//!   secret's host, postman-echo.com another allowed host) and the suite
//!   reads what arrived from their echo. Checks that need the recorder or
//!   the host's storage (that nothing arrived, F12) are local only.
//! - anything else fails, so a requested run never shows as passed.
//!
//! Every run writes `.bimo/reports/<time>-cloudflare-<pid>.json`.
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

/// Where the agents' requests go and how the suite sees what arrived.
enum World {
    /// `wrangler dev` and a recording upstream on loopback.
    Local { host: Host, upstream: Upstream },
    /// A deployed host; public echo services report what they received.
    Live { url: String },
}

impl World {
    fn url(&self) -> &str {
        match self {
            World::Local { host, .. } => &host.url,
            World::Live { url } => url,
        }
    }

    fn local(&self) -> Option<&Upstream> {
        match self {
            World::Local { upstream, .. } => Some(upstream),
            World::Live { .. } => None,
        }
    }

    fn persist(&self) -> Option<&Path> {
        match self {
            World::Local { host, .. } => Some(&host.persist),
            World::Live { .. } => None,
        }
    }

    fn allow(&self) -> &'static [&'static str] {
        match self {
            World::Local { .. } => &["localhost", "127.0.0.1"],
            World::Live { .. } => &["httpbin.org", "postman-echo.com"],
        }
    }

    fn secret_hosts(&self) -> &'static [&'static str] {
        &self.allow()[..1]
    }

    /// A URL on the secret's host, tagged so the suite can find it.
    fn secret_url(&self, tag: &str) -> String {
        match self {
            World::Local { upstream, .. } => format!("http://localhost:{}/{tag}", upstream.port),
            World::Live { .. } => format!("https://httpbin.org/anything/{tag}"),
        }
    }

    /// A URL on an allowed host that is not the secret's.
    fn other_url(&self, tag: &str) -> String {
        match self {
            World::Local { upstream, .. } => format!("http://127.0.0.1:{}/{tag}", upstream.port),
            World::Live { .. } => format!("https://postman-echo.com/get?tag={tag}"),
        }
    }

    /// A URL that answers 302 to another allowed host.
    fn redirect_url(&self) -> String {
        match self {
            World::Local { upstream, .. } => format!("http://localhost:{}/redirect", upstream.port),
            World::Live { .. } => {
                "https://httpbin.org/redirect-to?url=https%3A%2F%2Fpostman-echo.com%2Fget%3Ftag%3Dlanded&status_code=302".to_owned()
            }
        }
    }

    fn tcp_target(&self) -> (String, u16) {
        match self {
            World::Local { upstream, .. } => ("127.0.0.1".to_owned(), upstream.port),
            World::Live { .. } => ("httpbin.org".to_owned(), 80),
        }
    }

    /// The `X-Token` the upstream received for `tag`: from the recorder, or
    /// from the echo in the agent's view of the response.
    fn received(&self, tag: &str, response: &Value) -> Option<String> {
        match self {
            World::Local { upstream, .. } => upstream.find(&format!("/{tag}"))?.headers.get("x-token").cloned(),
            World::Live { .. } => {
                let echo: Value = serde_json::from_str(response["body"].as_str()?).ok()?;
                echo["headers"]
                    .as_object()?
                    .iter()
                    .find(|(name, _)| name.eq_ignore_ascii_case("x-token"))
                    .and_then(|(_, value)| value.as_str().map(str::to_owned))
            }
        }
    }
}

/// The path of a URL, as the gateway's audit line records it.
fn path_of(url: &str) -> String {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let path = rest.find('/').map(|i| &rest[i..]).unwrap_or("/");
    path.split('?').next().unwrap_or("/").to_owned()
}

/// A workerd spec for `name` in `tenant`, its source copied next to it.
fn write_spec(dir: &Path, world: &World, name: &str, tenant: &str, fixture: &str, extra_allow: &[&str]) -> PathBuf {
    let source = dir.join(format!("{name}-src"));
    fs::create_dir_all(&source).unwrap();
    fs::copy(
        repo().join(format!("tests/fixtures/{fixture}/index.js")),
        source.join("index.js"),
    )
    .unwrap();
    let quote = |hosts: &[&str]| hosts.iter().map(|h| format!("\"{h}\"")).collect::<Vec<_>>().join(", ");
    let mut allow: Vec<&str> = world.allow().to_vec();
    allow.extend_from_slice(extra_allow);
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
hosts = [{secret_hosts}]

[egress]
allow = [{allow}]

[placement]
substrate = "{TARGET}"
"#,
        secret_hosts = quote(world.secret_hosts()),
        allow = quote(&allow),
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

    /// A check this mode cannot make; recorded so the report says so.
    fn skip(&mut self, id: &str, what: &str, why: &str) {
        eprintln!("[skip] {id} {what}: {why}");
        self.list.push(json!({"id": id, "check": what, "ok": true, "skipped": why}));
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
    let mode = bimo_engine::bimo::var("CLOUDFLARE_E2E").ok().unwrap_or_default();
    if mode.is_empty() {
        let path = write_report(SUITE, "NOT_RUN", json!({"reason": "BIMO_CLOUDFLARE_E2E is not set"}));
        eprintln!("NOT RUN: BIMO_CLOUDFLARE_E2E is not set ({})", path.display());
        return;
    }
    let dir = repo().join("target/e2e-cloudflare").join(std::process::id().to_string());
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let blocked = |reason: String| -> ! {
        let path = write_report(SUITE, "BLOCKED", json!({"mode": mode, "reason": reason}));
        panic!("{reason} ({})", path.display());
    };
    let (world, token) = match mode.as_str() {
        "local" => {
            let token = random_hex(32);
            let upstream = Upstream::start();
            match Host::start(&dir, &token) {
                Ok(host) => (World::Local { host, upstream }, token),
                Err(reason) => blocked(reason),
            }
        }
        "live" => {
            let url = std::env::var("BIMO_CLOUDFLARE_URL").unwrap_or_default();
            let token = std::env::var("BIMO_CLOUDFLARE_TOKEN").unwrap_or_default();
            if !url.starts_with("https://") || token.is_empty() {
                blocked("live mode needs BIMO_CLOUDFLARE_URL (https://) and BIMO_CLOUDFLARE_TOKEN".to_owned());
            }
            if request("GET", &format!("{url}/healthz"), None).0 != 200 {
                blocked(format!("{url}/healthz does not answer 200"));
            }
            (World::Live { url: url.trim_end_matches('/').to_owned() }, token)
        }
        other => blocked(format!("BIMO_CLOUDFLARE_E2E={other}: use local or live")),
    };
    let started = Instant::now();
    let mut checks = Checks::default();
    let report = run(&dir, &world, &token, &mut checks);
    let failed = checks.failed().len();
    let status = if failed == 0 { "PASS" } else { "FAIL" };
    let path = write_report(
        SUITE,
        status,
        json!({
            "mode": mode,
            "host": world.url(),
            "run_dir": dir,
            "elapsed_ms": started.elapsed().as_millis() as u64,
            "checks": checks.list,
            "failed": failed,
            "observed": report,
        }),
    );
    drop(world);
    eprintln!("report: {}", path.display());
    assert_eq!(failed, 0, "{failed} check(s) failed; see {}", path.display());
}

fn run(dir: &Path, world: &World, token: &str, checks: &mut Checks) -> Value {
    let value_a = format!("cfval-a-{}", random_hex(12));
    let value_a2 = format!("cfval-a2-{}", random_hex(12));
    let value_b = format!("cfval-b-{}", random_hex(12));
    let values = [value_a.as_str(), value_a2.as_str(), value_b.as_str()];
    // Names unique per run, so runs against one live host never meet.
    let run_id = random_hex(3);
    let (name_a, name_b, name_r) = (format!("cf-a-{run_id}"), format!("cf-b-{run_id}"), format!("cf-r-{run_id}"));
    let mut observed = json!({"agents": [name_a, name_b, name_r]});

    let targets = dir.join("targets.toml");
    fs::write(
        &targets,
        format!(
            "schema_version = 1\ndefault_target = \"{TARGET}\"\n\n[[targets]]\nkind = \"cloudflare\"\nname = \"{TARGET}\"\nurl = \"{}\"\ntoken_env = \"{TOKEN_ENV}\"\n",
            world.url()
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
    let api = |path: &str| format!("{}{path}", world.url());
    let generation = |name: &str, n: u32| api(&format!("/v1/agents/{name}/generations/{n}"));
    let route = |tenant: &str, name: &str, n: u32| api(&format!("/v1/tenants/{tenant}/routes/{name}-g{n}"));
    let mut audited = Vec::new();

    // F11: the control API refuses a missing or wrong token, and so does
    // bimo when its token is wrong.
    let (none, _) = request("GET", &generation(&name_a, 1), None);
    let (wrong, _) = request("GET", &generation(&name_a, 1), Some("not-the-token"));
    let (right, _) = request("GET", &generation(&name_a, 1), Some(token));
    checks.check("F11", "control API refuses no token and a wrong token", none == 401 && wrong == 401, format!("no token {none}, wrong {wrong}"));
    checks.check("F11", "control API accepts the suite's operator token", right == 404, format!("HTTP {right} (404 expected: nothing applied yet)"));
    let spec_a = write_spec(dir, world, &name_a, "cfa", "cf-agent", &[]);
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
    let spec_r = write_spec(dir, world, &name_r, "cfa", "cf-agent-refuses", &[]);
    let (exit, envelope) = cli.run(&["apply", spec_r.to_str().unwrap()]);
    let (gen_r, _) = request("GET", &generation(&name_r, 1), Some(token));
    let (route_r, _) = request("GET", &route("cfa", &name_r, 1), Some(token));
    checks.check("F1", "an agent that refuses tasks is not reported ready", exit != 0 && code(&envelope) == "probe_failed", format!("exit {exit}, code {}", code(&envelope)));
    checks.check("F1", "the failed apply leaves no generation or route on the host", gen_r == 404 && route_r == 404, format!("generation {gen_r}, route {route_r}"));

    // Agent A: applied, ready only once it accepted a task.
    let (exit, envelope) = cli.run(&["apply", spec_a.to_str().unwrap()]);
    let result = &envelope["result"];
    let endpoint_a = result["endpoint"].as_str().unwrap_or_default().to_owned();
    observed["apply_a"] = json!({"exit": exit, "generation": result["generation"], "ready_ms": result["ready_ms"], "phases": result["phases"]});
    checks.check(
        "F1",
        "apply of a working agent is ready with an accepted first task",
        exit == 0 && result["generation"] == 1 && result["first_task_id"].is_string() && !endpoint_a.is_empty(),
        format!("exit {exit}, code {}", code(&envelope)),
    );
    let key_a = cli.control_key(&name_a);

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
    for url in [
        generation(&name_a, 1),
        route("cfa", &name_a, 1),
        format!("{}/audit", route("cfa", &name_a, 1)),
    ] {
        let (_, body) = request("GET", &url, Some(token));
        if values.iter().any(|v| body.contains(v)) {
            leaked.push(path_of(&url));
        }
    }
    checks.check("F2", "no control API response holds a value", leaked.is_empty(), format!("leaked in {leaked:?}"));

    let mut call = |endpoint: &str, key: &str, url: &str, header: &str| -> Value {
        audited.push(path_of(url));
        let target = url.replace('%', "%25").replace('&', "%26").replace('?', "%3F").replace('=', "%3D");
        let (status, body) = request(
            "GET",
            &format!("{endpoint}/test/call?url={target}&header=X-Token:{header}"),
            Some(key),
        );
        let mut value: Value = serde_json::from_str(&body).unwrap_or(json!({"raw": body}));
        value["agent_status"] = json!(status);
        value
    };

    // F3: swapped on the secret's host.
    let response = call(&endpoint_a, &key_a, &world.secret_url("f3"), SECRET_ENV);
    let got = world.received("f3", &response);
    checks.check(
        "F3",
        "the placeholder is swapped for the value on the secret's host",
        got.as_deref() == Some(value_a.as_str()),
        format!("agent saw {}, upstream got the value: {}", response["status"], got.as_deref() == Some(value_a.as_str())),
    );
    if world.local().is_some() {
        checks.check(
            "F2",
            "the upstream's response reaches the agent without a value",
            response["status"] == 200 && !values.iter().any(|v| response.to_string().contains(v)),
            format!("agent saw {}", response["status"]),
        );
    }

    // F4: not swapped on another allowed host.
    let response = call(&endpoint_a, &key_a, &world.other_url("f4"), SECRET_ENV);
    let got = world.received("f4", &response).unwrap_or_default();
    checks.check(
        "F4",
        "an allowed host that is not the secret's gets the placeholder",
        response["status"] == 200 && got == placeholder_a && !values.contains(&got.as_str()),
        format!("agent saw {}, upstream got a value: {}", response["status"], values.contains(&got.as_str())),
    );

    // F5: a host outside the allowlist is refused before anything leaves.
    let mut refused = Vec::new();
    if let Some(upstream) = world.local() {
        match upstream.side_port {
            Some(side) => {
                let response = call(&endpoint_a, &key_a, &format!("http://[::1]:{side}/f5"), SECRET_ENV);
                refused.push(json!({"host": "[::1] (side listener)", "status": response["status"]}));
                checks.check(
                    "F5",
                    "a request to a host outside the allowlist is refused and never arrives",
                    response["status"] == 403 && upstream.find("/f5").is_none(),
                    format!("agent saw {}, arrived: {}", response["status"], upstream.find("/f5").is_some()),
                );
            }
            None => checks.check("F5", "a side listener on ::1 is available", false, "could not bind [::1]; F5 cannot observe a leak"),
        }
    }
    let response = call(&endpoint_a, &key_a, "http://example.com/f5b", SECRET_ENV);
    refused.push(json!({"host": "example.com", "status": response["status"]}));
    checks.check("F5", "an internet host outside the allowlist is refused", response["status"] == 403, format!("agent saw {}", response["status"]));
    observed["refused"] = json!(refused);

    // F6: raw TCP carries nothing.
    let (tcp_host, tcp_port) = world.tcp_target();
    let (status, body) = request(
        "GET",
        &format!("{endpoint_a}/test/connect?host={tcp_host}&port={tcp_port}"),
        Some(&key_a),
    );
    let connect: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let arrived = world.local().is_some_and(|u| u.find("/tcp").is_some());
    checks.check(
        "F6",
        "raw TCP from the agent reaches nothing",
        status == 200 && connect["reached"] == false && !arrived,
        format!("HTTP {status}, agent: {connect}, arrived: {arrived}"),
    );
    observed["connect"] = connect;

    // F17: redirects go back to the agent.
    let response = call(&endpoint_a, &key_a, &world.redirect_url(), SECRET_ENV);
    let followed = world.local().is_some_and(|u| u.find("/landed").is_some());
    checks.check(
        "F17",
        "the gateway returns a redirect to the agent and does not follow it",
        response["status"] == 302 && !followed,
        format!("agent saw {} (location {}), followed: {followed}", response["status"], response["location"]),
    );

    // Agent B in tenant cfb. F7: A's placeholder is not B's to swap.
    let spec_b = write_spec(dir, world, &name_b, "cfb", "cf-agent", &[]);
    let (exit, envelope) = cli.run(&["apply", spec_b.to_str().unwrap()]);
    let endpoint_b = envelope["result"]["endpoint"].as_str().unwrap_or_default().to_owned();
    let key_b = cli.control_key(&name_b);
    checks.check("F7", "agent B (tenant cfb) applies", exit == 0, format!("exit {exit}, code {}", code(&envelope)));
    let response = call(&endpoint_b, &key_b, &world.secret_url("f7-own"), SECRET_ENV);
    let own = world.received("f7-own", &response).unwrap_or_default();
    let response = call(&endpoint_b, &key_b, &world.secret_url("f7"), &placeholder_a);
    let cross = world.received("f7", &response).unwrap_or_default();
    checks.check("F7", "B's own placeholder is swapped for B's value", own == value_b, format!("B got its value: {}", own == value_b));
    checks.check(
        "F7",
        "A's placeholder sent by B is not swapped",
        !placeholder_a.is_empty() && cross == placeholder_a,
        format!("upstream got A's value: {}", cross == value_a),
    );

    // F18: another tenant cannot take A's name, even from another control
    // plane, and its rollback does not touch A.
    let other = Cli {
        state_root: dir.join("state-other"),
        dir: dir.to_owned(),
        targets: targets.clone(),
        env: cli.env.clone(),
    };
    let takeover_dir = dir.join("takeover");
    fs::create_dir_all(&takeover_dir).unwrap();
    let spec_t = write_spec(&takeover_dir, world, &name_a, "cfb", "cf-agent", &[]);
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
    let response = call(&endpoint_a, &key_a, &world.secret_url("f8"), SECRET_ENV);
    let got = world.received("f8", &response).unwrap_or_default();
    checks.check("F8", "the running agent's next request carries the new value", got == value_a2, format!("new value used: {}, old value used: {}", got == value_a2, got == value_a));

    // F9: one audit line per outbound request, no values.
    let (exit, envelope) = cli.run(&["logs", &name_a, "--stream", "egress"]);
    let text = envelope["result"]["text"].as_str().unwrap_or_default().to_owned();
    let lines: Vec<Value> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let line_for = |path: &str| lines.iter().find(|l| l["audit"]["path"] == path).cloned().unwrap_or(Value::Null);
    let f3_path = path_of(&world.secret_url("f3"));
    let f3 = line_for(&f3_path);
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
    // A's requests so far: every call made through endpoint A (B's two
    // calls are in B's route).
    let b_paths = [path_of(&world.secret_url("f7-own")), path_of(&world.secret_url("f7"))];
    let missing: Vec<&String> = audited.iter().filter(|p| !b_paths.contains(p)).filter(|p| line_for(p).is_null()).collect();
    checks.check("F9", "every outbound request has an audit line", missing.is_empty(), format!("missing {missing:?} of {} lines", lines.len()));
    checks.check("F9", "no audit line holds a value", !values.iter().any(|v| text.contains(v)), "a value appears in the audit");
    observed["audit_lines"] = json!(lines.len());

    // F12 while values are stored: sealed in host storage.
    match world.persist() {
        Some(persist) => {
            let in_storage = files_holding(persist, &values);
            checks.check("F12", "no value is stored in plaintext in host storage", in_storage.is_empty(), format!("found in {in_storage:?}"));
        }
        None => checks.skip("F12", "no value is stored in plaintext in host storage", "Durable Object storage is not readable from outside in live mode; proven in local mode"),
    }

    // F15: a new generation retires the old one completely.
    let spec_a = write_spec(dir, world, &name_a, "cfa", "cf-agent", &["example.org"]);
    let (exit, envelope) = cli.run(&["apply", spec_a.to_str().unwrap()]);
    let endpoint_a2 = envelope["result"]["endpoint"].as_str().unwrap_or_default().to_owned();
    let retired = envelope["result"]["retired"].as_array().map(Vec::len).unwrap_or(0);
    checks.check("F15", "a changed spec applies as generation 2", exit == 0 && envelope["result"]["generation"] == 2, format!("exit {exit}, generation {}", envelope["result"]["generation"]));
    let (old_task, _) = request("POST", &format!("{endpoint_a}/bimo/v1/tasks"), Some(&key_a));
    let (old_gen, _) = request("GET", &generation(&name_a, 1), Some(token));
    let (old_route, _) = request("GET", &route("cfa", &name_a, 1), Some(token));
    let (new_task, _) = request("POST", &format!("{endpoint_a2}/bimo/v1/tasks"), Some(&key_a));
    checks.check(
        "F15",
        "generation 1 and its route are gone and unreachable",
        retired == 2 && old_task == 404 && old_gen == 404 && old_route == 404,
        format!("retired {retired}, old task {old_task}, old generation {old_gen}, old route {old_route}"),
    );
    checks.check("F15", "generation 2 serves", new_task == 202, format!("HTTP {new_task}"));
    let (_, envelope) = cli.run(&["logs", &name_a, "--stream", "egress"]);
    let kept = envelope["result"]["text"].as_str().unwrap_or_default().contains(&format!("\"{f3_path}\""));
    checks.check("F9", "generation 1's audit is kept after it is retired", kept, "the f3 line is gone");

    // F16: status follows the host.
    let (_, envelope) = cli.run(&["status", &name_a]);
    checks.check(
        "F16",
        "status reports ready at generation 2",
        envelope["result"]["status"] == "ready" && envelope["result"]["generation"] == 2,
        format!("status {}, generation {}", envelope["result"]["status"], envelope["result"]["generation"]),
    );

    // F10: destroy is complete and idempotent.
    let (first, _) = cli.run(&["destroy", &name_a]);
    let (second, envelope) = cli.run(&["destroy", &name_a]);
    let destroyed_again = envelope["result"]["destroyed"].as_array().map(Vec::len).unwrap_or(99);
    let (gen2, _) = request("GET", &generation(&name_a, 2), Some(token));
    let (route2, _) = request("GET", &route("cfa", &name_a, 2), Some(token));
    let (task2, _) = request("POST", &format!("{endpoint_a2}/bimo/v1/tasks"), Some(&key_a));
    checks.check("F10", "destroy succeeds twice, the second time with nothing to do", first == 0 && second == 0 && destroyed_again == 0, format!("exits {first}/{second}, second destroyed {destroyed_again}"));
    checks.check("F10", "the host keeps no generation, route or endpoint", gen2 == 404 && route2 == 404 && task2 == 404, format!("generation {gen2}, route {route2}, endpoint {task2}"));
    let (_, envelope) = cli.run(&["status", &name_a]);
    checks.check("F16", "status reports destroyed after destroy", envelope["result"]["status"] == "destroyed", format!("status {}", envelope["result"]["status"]));
    let (exit, _) = cli.run(&["destroy", &name_b]);
    let (gen_b, _) = request("GET", &generation(&name_b, 1), Some(token));
    checks.check("F10", "agent B is destroyed", exit == 0 && gen_b == 404, format!("exit {exit}, generation {gen_b}"));

    // F12, F13 at the end: nothing in host storage, nothing on this disk
    // (state roots, specs, transcript, the host's own log).
    if let Some(persist) = world.persist() {
        let in_storage = files_holding(persist, &values);
        checks.check("F12", "no value remains in host storage", in_storage.is_empty(), format!("found in {in_storage:?}"));
    }
    let on_disk: Vec<String> = files_holding(dir, &values)
        .into_iter()
        .filter(|p| !p.starts_with("host-state"))
        .collect();
    checks.check("F13", "no value is on the control host's disk", on_disk.is_empty(), format!("found in {on_disk:?}"));
    observed
}
