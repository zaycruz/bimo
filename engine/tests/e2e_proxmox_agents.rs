//! Live: eve and Hermes agents deployed on the Proxmox cluster behind their
//! tenant's proxy guest (U7 stage 2, U8; AE1 to AE3 on the cluster).
//!
//! Gated on `MONOLITH_PROXMOX_LIVE=1`, a proxmox target in the targets file,
//! that target's pool-scoped token (`tests/common/live_gate.rs`) and a real
//! OpenRouter key in `MONOLITH_SECRET_DEMO__OPENROUTER` (the examples' secret
//! handle `demo/openrouter`). Without the flag it writes a NOT_RUN report and
//! passes; with the flag and a missing precondition it fails. The key is
//! never printed, logged or written by this test: assertions about it name
//! where it was found, never the value. When the golden template's bind
//! agent predates API 3 the run stops with a BLOCKED report.
//!
//! Tenant `demo` runs eve (cold) and Hermes (warm); tenant `e2e-b` runs
//! Hermes (cold) with its own handle, which holds the same key so it can
//! answer. Each tenant gets one proxy guest; at most two agent guests exist
//! at once.
//!
//! Failure modes, written before the cases:
//! - apply reports ready without the runtime running in the guest, or the
//!   runtime runs on the control plane instead (AE1);
//! - the runtime cannot reach its model provider from the guest, or reaches
//!   it with the placeholder (the provider would refuse it);
//! - the real key is anywhere in the agent guest: bind claim, bundle, runtime
//!   files, `/tmp`, `/dev/shm`, logs, or any process's environment or command
//!   line (AE3);
//! - the runtime user can connect somewhere directly, around its proxy, or to
//!   the proxy guest's control API or bind agent;
//! - a proxy, its CA key or the secret file runs or lands in the agent guest,
//!   or a proxy process runs on the control plane;
//! - tenant B uses tenant A's handle, or reaches or authenticates to tenant
//!   A's proxy guest (no credential, its own credential, a forged one);
//! - the proxy guest loses its routes to the external restart (about three
//!   minutes after first start on pve-node-a) and is not provisioned again;
//! - destroy leaves the guest or the route behind; proxy down leaves the
//!   proxy guest; the pool on the cluster holds anything but the template;
//! - the run "passes" without reaching the cluster or the provider.
mod common;

use common::live_gate::{gate, live_driver, pool_members, repo, write_report, Gate, Sweeper};
use monolith::proxmox::delivery::GuestChannel;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

const SUITE: &str = "proxmox-agents";
const SECRET_ENV: &str = "MONOLITH_SECRET_DEMO__OPENROUTER";
const TENANT_A: &str = "demo";
const TENANT_B: &str = "e2e-b";
const SECRET_ENV_B: &str = "MONOLITH_SECRET_E2E_B__OPENROUTER";
/// The external restart lands about 150 to 180 s after a container's first
/// start; the proxy guests settle past it before any agent depends on them.
const SETTLE_MS: u64 = 210_000;
const ANSWER_WORD: &str = "pineapple";

fn tools() -> BTreeMap<String, String> {
    let output = Command::new("sh")
        .arg(repo().join("scripts/e2e-tools.sh"))
        .output()
        .expect("could not run scripts/e2e-tools.sh");
    assert!(output.status.success(), "scripts/e2e-tools.sh failed:\n{}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect()
}

struct Cli {
    dir: PathBuf,
    state_root: PathBuf,
    targets: PathBuf,
    env: BTreeMap<String, String>,
    names: Vec<String>,
}

impl Cli {
    fn run(&self, args: &[&str]) -> (i32, Value) {
        let output = Command::new(env!("CARGO_BIN_EXE_monolith"))
            .arg("agent")
            .args(args)
            .args(["--output", "json", "--state-root"])
            .arg(&self.state_root)
            .arg("--targets-config")
            .arg(&self.targets)
            .envs(&self.env)
            .output()
            .expect("could not run monolith");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let envelope = serde_json::from_str(stdout.trim()).unwrap_or(Value::Null);
        let line = json!({"args": args, "exit": output.status.code(), "envelope": envelope});
        let mut text = fs::read_to_string(self.dir.join("transcript.jsonl")).unwrap_or_default();
        text.push_str(&line.to_string());
        text.push('\n');
        fs::write(self.dir.join("transcript.jsonl"), text).unwrap();
        (output.status.code().unwrap_or(-1), envelope)
    }
}

impl Cli {
    fn proxy(&self, args: &[&str]) -> (i32, Value) {
        let output = Command::new(env!("CARGO_BIN_EXE_monolith"))
            .arg("proxy")
            .args(args)
            .args(["--output", "json", "--targets-config"])
            .arg(&self.targets)
            .envs(&self.env)
            .output()
            .expect("could not run monolith");
        let envelope: Value = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
        let line = json!({"proxy": args, "exit": output.status.code(), "envelope": envelope});
        let mut text = fs::read_to_string(self.dir.join("transcript.jsonl")).unwrap_or_default();
        text.push_str(&line.to_string());
        text.push('\n');
        fs::write(self.dir.join("transcript.jsonl"), text).unwrap();
        (output.status.code().unwrap_or(-1), envelope)
    }

    fn pool(&self, args: &[&str]) -> Value {
        let output = Command::new(env!("CARGO_BIN_EXE_monolith"))
            .arg("pool")
            .args(args)
            .args(["--output", "json", "--targets-config"])
            .arg(&self.targets)
            .envs(&self.env)
            .output()
            .expect("could not run monolith");
        let envelope: Value = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
        assert!(output.status.success(), "monolith pool {args:?} failed: {envelope:#}");
        envelope
    }
}

impl Drop for Cli {
    fn drop(&mut self) {
        // Never leave an agent guest or route behind, pass or fail (the
        // sweeper takes the proxy guests down after this).
        for name in &self.names {
            let _ = self.run(&["destroy", name]);
        }
    }
}

/// The example spec, placed on the live target, under a test name.
fn spec(cli: &Cli, runtime: &str, name: &str, target: &str) -> PathBuf {
    spec_for(cli, runtime, name, target, TENANT_A, "demo/openrouter")
}

/// The example spec for `tenant`, resolving its key through `handle`.
fn spec_for(cli: &Cli, runtime: &str, name: &str, target: &str, tenant: &str, handle: &str) -> PathBuf {
    let example = repo().join(format!("examples/{runtime}-agent.toml"));
    let mut text = fs::read_to_string(&example)
        .unwrap()
        .replace(&format!("name = \"demo-{runtime}\""), &format!("name = \"{name}\""))
        .replace("tenant_id = \"demo\"", &format!("tenant_id = \"{tenant}\""))
        .replace("handle = \"demo/openrouter\"", &format!("handle = \"{handle}\""))
        .replace("substrate = \"local\"", &format!("substrate = \"{target}\""));
    if runtime == "eve" {
        let dest = cli.dir.join(format!("{name}.git"));
        let output = Command::new("sh")
            .arg(repo().join("scripts/eve-example-repo.sh"))
            .arg(&dest)
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        text = text.replace("repo = \"../target/eve-agent.git\"", &format!("repo = \"{name}.git\""));
    } else {
        copy_dir(&repo().join("examples/hermes-agent"), &cli.dir.join("hermes-agent"));
    }
    let path = cli.dir.join(format!("{name}.toml"));
    fs::write(&path, text).unwrap();
    path
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap().flatten() {
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).unwrap();
        }
    }
}

fn http(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .proxy(None)
        .build()
        .new_agent()
}

/// Ask the runtime one question through its own task API and return the
/// answer text.
fn ask(runtime: &str, endpoint: &str, key: &str) -> Result<String, String> {
    let prompt = format!("Reply with exactly one lowercase word: {ANSWER_WORD}");
    let agent = http(Duration::from_secs(240));
    if runtime == "hermes" {
        let mut response = agent
            .post(format!("{endpoint}/v1/chat/completions"))
            .header("Authorization", format!("Bearer {key}"))
            .send_json(json!({"model": "hermes-agent", "messages": [{"role": "user", "content": prompt}]}))
            .map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let body: Value = response.body_mut().read_json().map_err(|e| e.to_string())?;
        return body["choices"][0]["message"]["content"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| format!("HTTP {status}: {body}"));
    }
    let mut response = agent
        .post(format!("{endpoint}/eve/v1/session"))
        .header("Authorization", format!("Bearer {key}"))
        .send_json(json!({"message": prompt}))
        .map_err(|e| e.to_string())?;
    let body: Value = response.body_mut().read_json().map_err(|e| e.to_string())?;
    let session = body["sessionId"].as_str().ok_or_else(|| format!("no sessionId: {body}"))?.to_owned();
    let mut response = agent
        .get(format!("{endpoint}/eve/v1/session/{session}/stream"))
        .header("Authorization", format!("Bearer {key}"))
        .call()
        .map_err(|e| e.to_string())?;
    let reader = BufReader::new(response.body_mut().as_reader());
    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        let Ok(event) = serde_json::from_str::<Value>(line.trim()) else { continue };
        match event["type"].as_str() {
            Some("message.completed") if event["data"]["finishReason"] != "tool-calls" => {
                if let Some(text) = event["data"]["message"].as_str() {
                    return Ok(text.to_owned());
                }
            }
            Some("turn.failed") | Some("session.failed") => return Err(format!("eve reported {event}")),
            _ => {}
        }
    }
    Err("the eve stream ended without a completed message".to_owned())
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

/// CONNECT through a proxy front from this host, with an optional
/// `route:token` credential; the status code it answers (0: no answer).
fn connect_status(front: &str, credential: Option<&str>) -> u16 {
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(&front.parse().unwrap(), Duration::from_secs(5)) else {
        return 0;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut request = "CONNECT openrouter.ai:443 HTTP/1.1\r\nHost: openrouter.ai:443\r\n".to_owned();
    if let Some(credential) = credential {
        request.push_str(&format!("Proxy-Authorization: Basic {}\r\n", base64(credential.as_bytes())));
    }
    request.push_str("\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return 0;
    }
    let mut head = [0u8; 64];
    let read = stream.read(&mut head).unwrap_or(0);
    String::from_utf8_lossy(&head[..read])
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0)
}

/// `http://<route>:<token>@<host>:<port>` -> (`route:token`, `host:port`)
fn split_proxy_url(url: &str) -> (String, String) {
    let rest = url.strip_prefix("http://").expect("an http proxy URL");
    let (userinfo, host) = rest.rsplit_once('@').expect("the proxy URL carries the route credential");
    (userinfo.to_owned(), host.trim_end_matches('/').to_owned())
}

/// The tenant's proxy guest as `monolith proxy status` shows it.
fn proxy_view(cli: &Cli, target: &str, tenant: &str) -> Value {
    let (code, envelope) = cli.proxy(&["status", "--target", target, "--tenant", tenant]);
    assert_eq!(code, 0, "proxy status failed: {envelope:#}");
    envelope["result"]["proxies"][0].clone()
}

/// Apply one agent and check it end to end; returns its report entry and,
/// while it still runs, what the cross-tenant checks need.
struct Running {
    name: String,
    vmid: u32,
    channel: GuestChannel,
    proxy_url: String,
    route: String,
    report: Value,
}

#[allow(clippy::too_many_arguments)]
fn apply_and_check(
    cli: &mut Cli,
    driver: &monolith::proxmox::ProxmoxDriver,
    target: &str,
    runtime: &str,
    name: &str,
    spec: &Path,
    warm: bool,
    proxy: &Value,
    secret: &str,
) -> Running {
    let settings = driver.settings().unwrap().clone();
    cli.names.push(name.to_owned());
    let started = Instant::now();
    let (code, envelope) = cli.run(&["apply", spec.to_str().unwrap()]);
    assert_eq!(code, 0, "apply {name} failed: {envelope:#}");
    if warm {
        // Only the claimed guest stays: at most two agent guests at once.
        cli.pool(&["drain", "--target", target, "--tenant", TENANT_A]);
    }
    let result = &envelope["result"];
    let ready_ms = result["ready_ms"].as_u64().expect("ready_ms");
    assert!(result["first_task_id"].as_str().is_some_and(|t| !t.is_empty()), "AE1: no first task");
    let phases: Vec<String> = result["phases"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| p["phase"].as_str().map(str::to_owned))
        .collect();
    let claim = phases.iter().find(|p| p.starts_with("claim_")).cloned().unwrap_or_else(|| "none".to_owned());
    if warm {
        assert_eq!(claim, "claim_warm", "hermes was not placed on a warm guest");
    }
    for local in ["proxy_start", "relay_start"] {
        assert!(!phases.iter().any(|p| p == local), "a control-plane phase ran: {local} in {phases:?}");
    }

    // AE1 on the cluster: the runtime answers from the guest; its proxy is a
    // route in the tenant's proxy guest; nothing runs on this host.
    let resources = result["resources"].as_array().unwrap();
    let kinds: Vec<&str> = resources.iter().map(|r| r["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, vec!["proxy_route", "guest"], "{resources:#?}");
    assert!(resources.iter().all(|r| r["process"].is_null()), "a resource is a local process: {resources:#?}");
    let route_resource = &resources[0];
    let proxy_vmid = proxy["vmid"].as_u64().unwrap();
    assert_eq!(route_resource["guest"]["vmid"].as_u64(), Some(proxy_vmid), "the route is in the tenant's proxy guest");
    let route = route_resource["id"].as_str().unwrap().rsplit(':').next().unwrap().to_owned();
    let guest = resources.iter().find(|r| r["kind"] == "guest").unwrap()["guest"].clone();
    let vmid = guest["vmid"].as_u64().unwrap() as u32;
    let address: Ipv4Addr = guest["address"].as_str().unwrap().parse().unwrap();
    let endpoint = result["endpoint"].as_str().unwrap().to_owned();
    assert_eq!(endpoint, format!("http://{address}:8080"), "the endpoint is the guest");

    let agent_dir = cli.state_root.join(name);
    let control_key = fs::read_to_string(agent_dir.join("control.key")).unwrap().trim().to_owned();
    let generation = result["generation"].as_u64().unwrap();
    assert!(
        !agent_dir.join(format!("gen-{generation}/proxy/iron-proxy.yaml")).exists(),
        "the control plane rendered a local proxy"
    );
    let credential = fs::read_to_string(agent_dir.join(format!("gen-{generation}/guest-credential")))
        .unwrap()
        .trim()
        .to_owned();
    let channel = GuestChannel::new(address, settings.bind_port, &credential);
    let runtime_state = channel.runtime().expect("runtime status from the bind agent");
    assert_eq!(runtime_state["state"], "running", "{runtime_state}");
    assert_eq!(
        runtime_state["egress"]["address"].as_str(),
        proxy["agent_address"].as_str(),
        "the agent guest's lock names its tenant's proxy guest: {runtime_state}"
    );

    // The runtime answers through its own API, which needs the provider,
    // which it reaches only through the proxy guest with the real key
    // swapped in.
    let answer = ask(runtime, &endpoint, &control_key).unwrap_or_else(|e| panic!("{name} did not answer: {e}"));
    assert!(!answer.trim().is_empty(), "{name} answered nothing");
    assert!(answer.to_lowercase().contains(ANSWER_WORD), "{name} did not answer {ANSWER_WORD}: {answer}");
    assert!(!contains(answer.as_bytes(), secret.as_bytes()), "{name}'s answer holds the real key");
    let (_, egress) = cli.run(&["logs", name, "--stream", "egress"]);
    let egress_text = egress["result"]["text"].as_str().unwrap_or_default().to_owned();
    assert!(!contains(egress_text.as_bytes(), secret.as_bytes()), "the audit log holds the real key");
    let provider_ok = egress_text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|r| r["msg"] == "request" && r["audit"]["host"] == "openrouter.ai")
        .filter(|r| r["audit"]["action"] == "allow" && r["audit"]["status_code"] == 200)
        .count();
    assert!(provider_ok > 0, "no successful provider call in {name}'s audit log: the placeholder would be refused");

    // AE3 in the agent guest and its runtime dump: nothing holds the real
    // key; no proxy material is there.
    let inspect = cli.dir.join(format!("{name}-inspect.tar"));
    let size = channel.inspect(&inspect).expect("inspect tar");
    let unpacked = cli.dir.join(format!("{name}-inspect"));
    fs::create_dir_all(&unpacked).unwrap();
    let status = Command::new("tar").arg("-xf").arg(&inspect).arg("-C").arg(&unpacked).status().unwrap();
    assert!(status.success(), "the inspect tar unpacks");
    let manifest: Value =
        serde_json::from_str(&fs::read_to_string(unpacked.join("inspect-manifest.json")).expect("complete tar"))
            .unwrap();
    let mut files = Vec::new();
    files_under(&unpacked, &mut files);
    let mut runtime_environ = None;
    let mut go_record = None;
    for file in &files {
        let bytes = fs::read(file).unwrap();
        let shown = file.strip_prefix(&unpacked).unwrap().display().to_string();
        assert!(!contains(&bytes, secret.as_bytes()), "the real key is in the guest at {shown}");
        if shown.ends_with("/environ") && contains(&bytes, b"OPENROUTER_API_KEY=") {
            runtime_environ = Some(String::from_utf8_lossy(&bytes).into_owned());
        }
        if shown.ends_with(".monolith-warm-go.json") {
            go_record = Some(serde_json::from_slice::<Value>(&bytes).expect("the go record is JSON"));
        }
        for forbidden in ["ca.key", "iron-proxy.yaml", "management.key", "iron-proxy"] {
            assert!(!shown.ends_with(forbidden), "proxy material {forbidden} is in the guest at {shown}");
        }
    }
    // A warm runtime's /proc environ is the launcher's pre-claim
    // environment; the environment it runs the agent with is the one in its
    // go record (mode 0600 in the runtime root).
    let environ = if warm {
        assert!(
            runtime_environ.is_none(),
            "a process environment holds the agent's placeholder; the launcher's should not"
        );
        let go = go_record.expect("the warm runtime's go record was captured");
        go["env"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or_default()))
            .collect::<Vec<_>>()
            .join("\0")
    } else {
        runtime_environ.expect("the runtime's process environment was captured")
    };
    let proxy_url = environ
        .split('\0')
        .find_map(|kv| kv.strip_prefix("HTTPS_PROXY="))
        .expect("the runtime has HTTPS_PROXY")
        .to_owned();
    let (userinfo, front) = split_proxy_url(&proxy_url);
    assert_eq!(
        front,
        format!("{}:{}", proxy["agent_address"].as_str().unwrap(), proxy["front_port"]),
        "runtime egress goes to its tenant's proxy guest"
    );
    assert!(userinfo.starts_with(&format!("{route}:")), "the proxy credential names the agent's route");
    assert!(
        environ.split('\0').any(|kv| kv.starts_with("OPENROUTER_API_KEY=") && kv.len() > "OPENROUTER_API_KEY=".len()),
        "the runtime holds a placeholder"
    );
    assert!(manifest["skipped"].as_array().is_some_and(|s| s.is_empty()), "inspect skipped files: {manifest}");
    let processes = manifest["processes"].as_array().map(Vec::len);
    // The unpacked dump holds the route credential (not a provider secret);
    // it goes now that it was checked.
    let _ = fs::remove_dir_all(&unpacked);
    let _ = fs::remove_file(&inspect);

    // Confinement: the runtime user reaches its proxy's front and nothing
    // else, not even the proxy guest's control API or bind agent.
    let proxy_address = proxy["agent_address"].as_str().unwrap().to_owned();
    let mut probes = serde_json::Map::new();
    for (host, port, allowed) in [
        ("1.1.1.1".to_owned(), 443u16, false),
        (settings.gateway.to_string(), 8006, false),
        (proxy_address.clone(), 3128, true),
        (proxy_address.clone(), 8080, false),
        (proxy_address.clone(), settings.bind_port, false),
    ] {
        let probe = channel.probe_egress(&host, port).expect("egress probe");
        assert_eq!(probe["connected"], allowed, "the runtime user's connection to {host}:{port}: {probe}");
        probes.insert(format!("{host}:{port}"), probe);
    }

    // The agent log is fetched from the guest and holds no key.
    let (_, logs) = cli.run(&["logs", name]);
    let log_text = logs["result"]["text"].as_str().unwrap_or_default();
    assert!(!contains(log_text.as_bytes(), secret.as_bytes()), "the agent log holds the real key");

    Running {
        name: name.to_owned(),
        vmid,
        channel,
        proxy_url,
        route: route.clone(),
        report: json!({
            "agent": name,
            "vmid": vmid,
            "address": address.to_string(),
            "proxy_guest": proxy_vmid,
            "route": route,
            "ready_ms": ready_ms,
            "claim": claim,
            "phases": result["phases"],
            "apply_wall_ms": started.elapsed().as_millis() as u64,
            "answer_excerpt": answer.chars().take(120).collect::<String>(),
            "answer_has_word": true,
            "provider_calls_ok": provider_ok,
            "inspect": {"bytes": size, "files": files.len(), "processes": processes},
            "egress_probes": probes,
            "secret_found_in_guest": false,
        }),
    }
}

/// Destroy an agent and check its guest and its route are gone.
fn destroy_and_check(cli: &mut Cli, driver: &monolith::proxmox::ProxmoxDriver, target: &str, tenant: &str, running: &mut Running) {
    let (code, destroyed) = cli.run(&["destroy", &running.name]);
    assert_eq!(code, 0, "{destroyed:#}");
    assert!(driver.vmid_free(running.vmid).unwrap(), "guest {} is gone", running.vmid);
    let view = proxy_view(cli, target, tenant);
    let routes: Vec<&str> = view["supervisor"]["routes"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    assert!(!routes.contains(&running.route.as_str()), "route {} outlived destroy", running.route);
    cli.names.retain(|n| n != &running.name);
    running.report["destroyed"] = json!(true);
}

/// Look for tailscaled among the proxy guest's processes (through its bind
/// agent; nothing from the proxy guest is written to disk).
fn tailscaled_in(driver: &monolith::proxmox::ProxmoxDriver, tenant: &str) -> Value {
    let settings = driver.settings().unwrap();
    let Some(record) = driver.proxy_record(tenant).unwrap() else {
        return json!({"error": "no proxy record"});
    };
    let Some(channel) = record.channel(settings.bind_port) else {
        return json!({"error": "no bind credential on record"});
    };
    match channel.processes() {
        Ok(listing) => {
            let found: Vec<Value> = listing["processes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|p| p["cmdline"].to_string().contains("tailscaled"))
                .map(|p| json!({"pid": p["pid"], "uid": p["uid"]}))
                .collect();
            let supervisor = listing["processes"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|p| p["cmdline"].to_string().contains("tenant-proxy.py"));
            json!({"tailscaled_running": !found.is_empty(), "tailscaled": found, "supervisor_running": supervisor,
                   "processes": listing["processes"].as_array().map(Vec::len)})
        }
        Err(error) => json!({"error": error.to_string()}),
    }
}

#[test]
fn eve_and_hermes_run_in_proxmox_guests_and_answer_without_the_real_secret() {
    let (targets, target) = match gate() {
        Gate::NotRun(reason) => {
            let report = write_report(SUITE, "NOT_RUN", json!({"reason": reason}));
            eprintln!("NOT RUN: {reason}. Report: {}", report.display());
            return;
        }
        Gate::Requested(reason) => {
            let report = write_report(SUITE, "NOT_RUN", json!({"reason": reason, "requested": true}));
            panic!("NOT RUN (live run requested): {reason}. Report: {}", report.display());
        }
        Gate::Live { targets, target, .. } => (targets, target),
    };
    let secret = std::env::var(SECRET_ENV).unwrap_or_default();
    if secret.trim().len() < 16 {
        let reason = format!("{SECRET_ENV} must hold a real OpenRouter key so the agents can answer");
        let report = write_report(SUITE, "NOT_RUN", json!({"reason": reason, "requested": true}));
        panic!("NOT RUN (live run requested): {reason}. Report: {}", report.display());
    }
    let driver = live_driver(&targets, &target);
    let settings = driver.settings().expect("the live target has every driver field").clone();
    if let Err(error) = driver.template_version() {
        let reason = format!("the golden template is not ready: {error} (next: {})", error.next.join("; "));
        let report = write_report(SUITE, "BLOCKED", json!({"reason": reason, "target": target}));
        panic!("BLOCKED: {reason} Report: {}", report.display());
    }

    // Drains the tenants' pools and takes their proxy guests down when the
    // run ends, pass or fail, after the agents themselves are destroyed (it
    // is dropped after `cli`).
    let _sweeper = Sweeper::new(&driver, &[TENANT_A, TENANT_B]);
    let tools = tools();
    let dir = repo().join("target/e2e-proxmox-agents").join(std::process::id().to_string());
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let mut env = BTreeMap::new();
    env.insert("MONOLITH_IRON_PROXY_BIN".to_owned(), tools["IRON_PROXY_BIN"].clone());
    env.insert("MONOLITH_IRON_PROXY_GUEST_BIN".to_owned(), tools["IRON_PROXY_LINUX_BIN"].clone());
    env.insert("MONOLITH_NODE_BIN".to_owned(), format!("{}/node", tools["NODE_BIN_DIR"]));
    env.insert(
        "MONOLITH_NPM_CACHE".to_owned(),
        repo().join("target/e2e-tools/npm-cache").to_string_lossy().into_owned(),
    );
    env.insert("MONOLITH_READY_TIMEOUT_MS".to_owned(), "300000".to_owned());
    env.insert("MONOLITH_POOL_REFILL".to_owned(), "0".to_owned());
    // Tenant B's own handle resolves to the same key, so B can answer too.
    env.insert(SECRET_ENV_B.to_owned(), secret.clone());
    let mut cli = Cli {
        state_root: dir.join("state"),
        targets: targets.clone(),
        dir: dir.clone(),
        env,
        names: Vec::new(),
    };
    let mut results = serde_json::Map::new();

    // One proxy guest per tenant, before any agent.
    let mut proxies = serde_json::Map::new();
    for tenant in [TENANT_A, TENANT_B] {
        let started = Instant::now();
        let (code, envelope) = cli.proxy(&["up", "--target", &target, "--tenant", tenant]);
        if code != 0 && envelope["error"]["code"] == "target_unavailable" {
            let report = write_report(
                SUITE,
                "BLOCKED",
                json!({
                    "reason": envelope["error"]["message"],
                    "next": envelope["next"],
                    "target": target,
                    "transcript": dir.join("transcript.jsonl"),
                }),
            );
            panic!("BLOCKED: {} Report: {}", envelope["error"]["message"], report.display());
        }
        assert_eq!(code, 0, "proxy up {tenant} failed: {envelope:#}");
        let result = envelope["result"].clone();
        assert_eq!(result["state"], "ready", "{result:#}");
        proxies.insert(tenant.to_owned(), json!({"up": result, "up_ms": started.elapsed().as_millis() as u64}));
    }
    assert_ne!(proxies[TENANT_A]["up"]["vmid"], proxies[TENANT_B]["up"]["vmid"], "each tenant has its own proxy guest");

    // Let the external restart land, then make sure each proxy guest is
    // ready (provisioned again if it lost its tmpfs).
    let newest = [TENANT_A, TENANT_B]
        .iter()
        .map(|t| proxies[*t]["up"]["created_at_ms"].as_u64().unwrap())
        .max()
        .unwrap();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    let settle = (newest + SETTLE_MS).saturating_sub(now);
    std::thread::sleep(Duration::from_millis(settle));
    for tenant in [TENANT_A, TENANT_B] {
        let (code, envelope) = cli.proxy(&["up", "--target", &target, "--tenant", tenant]);
        assert_eq!(code, 0, "proxy up {tenant} after the settle failed: {envelope:#}");
        let before = proxies[tenant]["up"].clone();
        let after = envelope["result"].clone();
        assert_eq!(after["vmid"], before["vmid"], "the proxy guest was replaced, not recovered");
        let entry = proxies.get_mut(tenant).unwrap();
        entry["settled_ms"] = json!(settle);
        entry["after_settle"] = after.clone();
        entry["reprovisioned"] = json!(after["provisions"] != before["provisions"]);
        entry["tailscale"] = tailscaled_in(&driver, tenant);
    }
    let proxy_a = proxy_view(&cli, &target, TENANT_A);
    let proxy_b = proxy_view(&cli, &target, TENANT_B);
    assert_eq!(proxy_a["supervisor"]["boot_matches"], true, "{proxy_a:#}");
    assert_eq!(proxy_b["supervisor"]["boot_matches"], true, "{proxy_b:#}");
    let front_a = format!("{}:{}", proxy_a["agent_address"].as_str().unwrap(), proxy_a["front_port"]);

    // Tenant A: eve cold, then Hermes on a warm guest.
    let eve_spec = spec(&cli, "eve", "e2e-pve-eve", &target);
    let mut eve = apply_and_check(&mut cli, &driver, &target, "eve", "e2e-pve-eve", &eve_spec, false, &proxy_a, &secret);
    destroy_and_check(&mut cli, &driver, &target, TENANT_A, &mut eve);
    results.insert("eve".to_owned(), eve.report.clone());

    cli.pool(&["fill", "--target", &target, "--tenant", TENANT_A, "--warm", "hermes"]);
    let hermes_spec = spec(&cli, "hermes", "e2e-pve-hermes", &target);
    let mut hermes_a =
        apply_and_check(&mut cli, &driver, &target, "hermes", "e2e-pve-hermes", &hermes_spec, true, &proxy_a, &secret);

    // Tenant B may not name tenant A's handle; nothing is created.
    let stolen = spec_for(&cli, "hermes", "e2e-pve-b-stolen", &target, TENANT_B, "demo/openrouter");
    cli.names.push("e2e-pve-b-stolen".to_owned());
    let (code, refused) = cli.run(&["apply", stolen.to_str().unwrap()]);
    assert_ne!(code, 0, "tenant B applied with tenant A's handle: {refused:#}");
    let stolen_code = refused["error"]["code"].clone();

    // Tenant B: Hermes cold, behind its own proxy guest.
    let b_spec = spec_for(&cli, "hermes", "e2e-pve-b-hermes", &target, TENANT_B, "e2e-b/openrouter");
    let mut hermes_b =
        apply_and_check(&mut cli, &driver, &target, "hermes", "e2e-pve-b-hermes", &b_spec, false, &proxy_b, &secret);
    assert_ne!(
        split_proxy_url(&hermes_b.proxy_url).1,
        front_a,
        "tenant B's agent was pointed at tenant A's proxy guest"
    );

    // Cross-tenant: B's guest cannot reach A's proxy guest at all, and A's
    // front refuses every credential that is not one of A's routes from its
    // own agent guest.
    let a_address = proxy_a["agent_address"].as_str().unwrap();
    let mut cross = serde_json::Map::new();
    for port in [3128u16, 8080, settings.bind_port] {
        let probe = hermes_b.channel.probe_egress(a_address, port).expect("egress probe");
        assert_eq!(probe["connected"], false, "tenant B's runtime reached tenant A's proxy guest on {port}: {probe}");
        cross.insert(format!("b_guest_to_a_proxy:{port}"), probe);
    }
    let (b_credential, _) = split_proxy_url(&hermes_b.proxy_url);
    let (a_credential, _) = split_proxy_url(&hermes_a.proxy_url);
    let forged = format!("{}:{}", hermes_a.route, "0".repeat(48));
    for (label, credential) in [
        ("no_credential", None),
        ("tenant_b_credential", Some(b_credential.as_str())),
        ("forged_token_for_a_route", Some(forged.as_str())),
        ("a_credential_from_another_host", Some(a_credential.as_str())),
    ] {
        let status = connect_status(&front_a, credential);
        assert_eq!(status, 407, "tenant A's proxy answered {status} to {label}");
        cross.insert(label.to_owned(), json!(status));
    }
    // And B's own front refuses A's credential.
    let front_b = split_proxy_url(&hermes_b.proxy_url).1;
    let status = connect_status(&front_b, Some(a_credential.as_str()));
    assert_eq!(status, 407, "tenant B's proxy answered {status} to tenant A's credential");
    cross.insert("a_credential_at_b_proxy".to_owned(), json!(status));
    cross.insert("handle_of_a_in_b_spec".to_owned(), json!({"refused": true, "code": stolen_code}));

    destroy_and_check(&mut cli, &driver, &target, TENANT_A, &mut hermes_a);
    destroy_and_check(&mut cli, &driver, &target, TENANT_B, &mut hermes_b);
    results.insert("hermes".to_owned(), hermes_a.report.clone());
    results.insert("hermes_tenant_b".to_owned(), hermes_b.report.clone());

    // Teardown: each proxy guest goes (no --force: it serves no route now).
    for tenant in [TENANT_A, TENANT_B] {
        let entry = proxies.get_mut(tenant).unwrap();
        entry["tailscale_at_teardown"] = tailscaled_in(&driver, tenant);
        let vmid = entry["up"]["vmid"].as_u64().unwrap() as u32;
        let (code, envelope) = cli.proxy(&["down", "--target", &target, "--tenant", tenant]);
        assert_eq!(code, 0, "proxy down {tenant} failed: {envelope:#}");
        assert!(driver.vmid_free(vmid).unwrap(), "proxy guest {vmid} is gone");
        entry["destroyed"] = json!(true);
    }
    driver.drain(None).expect("drain");
    let members = pool_members(&driver);
    assert_eq!(members, vec![u64::from(settings.template_id)], "the pool holds only the template");
    let pool_guests = driver.pool_state().unwrap().guests.len();
    assert_eq!(pool_guests, 0, "the pool file holds no guest");

    let report = write_report(
        SUITE,
        "PASSED",
        json!({
            "target": target,
            "node": settings.node,
            "transcript": dir.join("transcript.jsonl"),
            "proxy_guests": proxies,
            "runtimes": results,
            "cross_tenant": cross,
            "cleanup": {"pool_members": members, "pool_file_guests": pool_guests},
            "segments": if settings.tenant_vlans.is_empty() {
                json!("shared bridge: tenant_vlans is empty; tenant refusal is enforced by route credentials and source addresses at the proxy front, and by each agent guest's lock")
            } else {
                json!(settings.tenant_vlans)
            },
        }),
    );
    eprintln!("PASSED. Report: {}", report.display());
}
