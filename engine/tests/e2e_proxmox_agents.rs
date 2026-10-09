//! Live: eve and Hermes agents deployed on the Proxmox cluster (U7, U8; AE1
//! to AE3 on the cluster).
//!
//! Gated on `MONOLITH_PROXMOX_LIVE=1`, a proxmox target in the targets file,
//! that target's pool-scoped token (`tests/common/live_gate.rs`) and a real
//! OpenRouter key in `MONOLITH_SECRET_DEMO__OPENROUTER` (the examples' secret
//! handle `demo/openrouter`). Without the flag it writes a NOT_RUN report and
//! passes; with the flag and a missing precondition it fails. The key is
//! never printed, logged or written by this test: assertions about it name
//! where it was found, never the value.
//!
//! For each of `examples/eve-agent.toml` and `examples/hermes-agent.toml`,
//! placed on the live target through the real CLI:
//!
//! Failure modes, written before the cases:
//! - apply reports ready without the runtime running in the guest, or the
//!   runtime runs on the control plane instead (AE1);
//! - the runtime cannot reach its model provider from the guest, or reaches
//!   it with the placeholder (the provider would refuse it);
//! - the real key is anywhere in the guest: bind claim, bundle, runtime
//!   files, `/tmp`, logs, or any process's environment or command line (AE3);
//! - the runtime user can connect somewhere directly, around the proxy;
//! - the proxy, its CA key or the secret file runs or lands in the guest;
//! - destroy leaves the guest, the proxy or the relay behind;
//! - the run "passes" without reaching the cluster or the provider.
mod common;

use common::live_gate::{gate, live_driver, repo, write_report, Gate};
use monolith::proxmox::delivery::GuestChannel;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

const SUITE: &str = "proxmox-agents";
const SECRET_ENV: &str = "MONOLITH_SECRET_DEMO__OPENROUTER";
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

impl Drop for Cli {
    fn drop(&mut self) {
        // Never leave a guest, proxy or relay behind, pass or fail.
        for name in &self.names {
            let _ = self.run(&["destroy", name]);
        }
    }
}

/// The example spec, placed on the live target, under a test name.
fn spec(cli: &Cli, runtime: &str, name: &str, target: &str) -> PathBuf {
    let example = repo().join(format!("examples/{runtime}-agent.toml"));
    let mut text = fs::read_to_string(&example)
        .unwrap()
        .replace(&format!("name = \"demo-{runtime}\""), &format!("name = \"{name}\""))
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

fn process_alive(pid: u64) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
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

    let tools = tools();
    let dir = repo().join("target/e2e-proxmox-agents").join(std::process::id().to_string());
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let mut env = BTreeMap::new();
    env.insert("MONOLITH_IRON_PROXY_BIN".to_owned(), tools["IRON_PROXY_BIN"].clone());
    env.insert("MONOLITH_NODE_BIN".to_owned(), format!("{}/node", tools["NODE_BIN_DIR"]));
    env.insert(
        "MONOLITH_NPM_CACHE".to_owned(),
        repo().join("target/e2e-tools/npm-cache").to_string_lossy().into_owned(),
    );
    env.insert("MONOLITH_READY_TIMEOUT_MS".to_owned(), "300000".to_owned());
    env.insert("MONOLITH_POOL_REFILL".to_owned(), "0".to_owned());
    let mut cli = Cli {
        state_root: dir.join("state"),
        targets: targets.clone(),
        dir: dir.clone(),
        env,
        names: Vec::new(),
    };
    let mut results = serde_json::Map::new();

    for runtime in ["eve", "hermes"] {
        let name = format!("e2e-pve-{runtime}");
        cli.names.push(name.clone());
        let spec = spec(&cli, runtime, &name, &target);
        let started = Instant::now();
        let (code, envelope) = cli.run(&["apply", spec.to_str().unwrap()]);
        assert_eq!(code, 0, "apply {name} failed: {envelope:#}");
        let result = &envelope["result"];
        let ready_ms = result["ready_ms"].as_u64().expect("ready_ms");
        assert!(result["first_task_id"].as_str().is_some_and(|t| !t.is_empty()), "AE1: no first task");

        // AE1 on the cluster: the runtime answers from the guest; the proxy
        // and the relay run on the control plane.
        let resources = result["resources"].as_array().unwrap();
        let kinds: Vec<&str> = resources.iter().map(|r| r["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, vec!["proxy_process", "guest", "relay_process"], "{resources:#?}");
        let guest = resources.iter().find(|r| r["kind"] == "guest").unwrap()["guest"].clone();
        let vmid = guest["vmid"].as_u64().unwrap() as u32;
        let address: Ipv4Addr = guest["address"].as_str().unwrap().parse().unwrap();
        let endpoint = result["endpoint"].as_str().unwrap().to_owned();
        assert_eq!(endpoint, format!("http://{address}:8080"), "the endpoint is the guest");
        let pids: Vec<u64> = resources
            .iter()
            .filter_map(|r| r["process"]["pid"].as_u64())
            .collect();
        assert_eq!(pids.len(), 2, "proxy and relay are local processes");

        let agent_dir = cli.state_root.join(&name);
        let control_key = fs::read_to_string(agent_dir.join("control.key")).unwrap().trim().to_owned();
        let generation = result["generation"].as_u64().unwrap();
        let credential = fs::read_to_string(agent_dir.join(format!("gen-{generation}/guest-credential")))
            .unwrap()
            .trim()
            .to_owned();
        let channel = GuestChannel::new(address, settings.bind_port, &credential);
        let runtime_state = channel.runtime().expect("runtime status from the bind agent");
        assert_eq!(runtime_state["state"], "running", "{runtime_state}");

        // The runtime answers through its own API, which needs the provider,
        // which it reaches only through the proxy with the real key swapped in.
        let answer = ask(runtime, &endpoint, &control_key).unwrap_or_else(|e| panic!("{name} did not answer: {e}"));
        assert!(!answer.trim().is_empty(), "{name} answered nothing");
        assert!(!contains(answer.as_bytes(), secret.as_bytes()), "{name}'s answer holds the real key");
        let (_, egress) = cli.run(&["logs", &name, "--stream", "egress"]);
        let egress_text = egress["result"]["text"].as_str().unwrap_or_default().to_owned();
        assert!(!contains(egress_text.as_bytes(), secret.as_bytes()), "the audit log holds the real key");
        let provider_ok = egress_text
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|r| r["msg"] == "request" && r["audit"]["host"] == "openrouter.ai")
            .filter(|r| r["audit"]["action"] == "allow" && r["audit"]["status_code"] == 200)
            .count();
        assert!(provider_ok > 0, "no successful provider call in {name}'s audit log: the placeholder would be refused");

        // AE3 in the guest: nothing holds the real key.
        let inspect = dir.join(format!("{name}-inspect.tar"));
        let size = channel.inspect(&inspect).expect("inspect tar");
        let unpacked = dir.join(format!("{name}-inspect"));
        fs::create_dir_all(&unpacked).unwrap();
        let status = Command::new("tar").arg("-xf").arg(&inspect).arg("-C").arg(&unpacked).status().unwrap();
        assert!(status.success(), "the inspect tar unpacks");
        let manifest: Value =
            serde_json::from_str(&fs::read_to_string(unpacked.join("inspect-manifest.json")).expect("complete tar"))
                .unwrap();
        let mut files = Vec::new();
        files_under(&unpacked, &mut files);
        let mut runtime_environ = None;
        for file in &files {
            let bytes = fs::read(file).unwrap();
            let shown = file.strip_prefix(&unpacked).unwrap().display().to_string();
            assert!(!contains(&bytes, secret.as_bytes()), "the real key is in the guest at {shown}");
            if shown.ends_with("/environ") && contains(&bytes, b"OPENROUTER_API_KEY=") {
                runtime_environ = Some(String::from_utf8_lossy(&bytes).into_owned());
            }
            for forbidden in ["ca.key", "iron-proxy.yaml", "management.key"] {
                assert!(!shown.ends_with(forbidden), "proxy material {forbidden} is in the guest at {shown}");
            }
        }
        let environ = runtime_environ.expect("the runtime's process environment was captured");
        assert!(environ.split('\0').any(|kv| kv == "HTTPS_PROXY=http://127.0.0.1:7071"), "runtime egress goes to the relay");
        assert!(
            environ.split('\0').any(|kv| kv.starts_with("OPENROUTER_API_KEY=") && kv.len() > "OPENROUTER_API_KEY=".len()),
            "the runtime holds a placeholder"
        );
        assert!(manifest["skipped"].as_array().is_some_and(|s| s.is_empty()), "inspect skipped files: {manifest}");

        // Confinement: the runtime user cannot connect around the proxy.
        let direct = channel.probe_egress("1.1.1.1", 443).expect("egress probe");
        assert_eq!(direct["connected"], false, "the runtime user reached 1.1.1.1:443 directly: {direct}");
        let gateway = channel.probe_egress(&settings.gateway.to_string(), 8006).expect("egress probe");
        assert_eq!(gateway["connected"], false, "the runtime user reached the LAN: {gateway}");

        // The agent log is fetched from the guest and holds no key.
        let (_, logs) = cli.run(&["logs", &name]);
        let log_text = logs["result"]["text"].as_str().unwrap_or_default();
        assert!(!contains(log_text.as_bytes(), secret.as_bytes()), "the agent log holds the real key");

        // Destroy removes the guest, the proxy and the relay.
        let (code, destroyed) = cli.run(&["destroy", &name]);
        assert_eq!(code, 0, "{destroyed:#}");
        assert!(driver.vmid_free(vmid).unwrap(), "guest {vmid} is gone");
        std::thread::sleep(Duration::from_millis(500));
        for pid in &pids {
            assert!(!process_alive(*pid), "process {pid} outlived destroy");
        }
        cli.names.retain(|n| n != &name);

        results.insert(
            runtime.to_owned(),
            json!({
                "agent": name,
                "vmid": vmid,
                "address": address.to_string(),
                "ready_ms": ready_ms,
                "apply_wall_ms": started.elapsed().as_millis() as u64,
                "answer_excerpt": answer.chars().take(120).collect::<String>(),
                "answer_has_word": answer.to_lowercase().contains(ANSWER_WORD),
                "provider_calls_ok": provider_ok,
                "inspect": {"bytes": size, "files": files.len(), "processes": manifest["processes"].as_array().map(Vec::len)},
                "direct_egress": {"1.1.1.1:443": direct, "gateway:8006": gateway},
                "secret_found_in_guest": false,
                "destroyed": true,
            }),
        );
    }

    let report = write_report(
        SUITE,
        "PASSED",
        json!({
            "target": target,
            "node": settings.node,
            "transcript": dir.join("transcript.jsonl"),
            "runtimes": results,
            "segments": if settings.tenant_vlans.is_empty() {
                json!("shared bridge: tenant_vlans is empty, per-tenant segments (KTD5) are not provisioned yet")
            } else {
                json!(settings.tenant_vlans)
            },
        }),
    );
    eprintln!("PASSED. Report: {}", report.display());
}
