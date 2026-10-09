//! U1: spawn-latency benchmark on a Proxmox cluster (R3, KTD1, KTD7).
//!
//! Live only. Gated on `MONOLITH_PROXMOX_LIVE=1`, a proxmox target in the
//! targets file, that target's pool-scoped write token (see
//! `tests/common/live_gate.rs`) and the examples' secret handle
//! `demo/openrouter` in `MONOLITH_SECRET_DEMO__OPENROUTER`, which apply
//! resolves into the credential proxy (the key is never printed, logged or
//! written by this test). Every run writes a dated report to
//! `.monolith/reports/`; a live run also rewrites
//! `docs/benchmarks/spawn-latency.md`.
//!
//! What the clock covers (R3, KTD7): `monolith agent apply` of the example
//! spec through the real CLI, from the request to the runtime accepting its
//! first task, as the CLI reports it in `ready_ms` with its phase breakdown.
//! That is spec validation, source, prepare, the tenant proxy guest's health
//! check, the pool claim and late bind (KTD10), the agent's route in the
//! proxy guest (beside delivery), go or start, and the first-task probe. Pools are filled before each sample, off the clock, the way the
//! pool refill keeps them filled in service. Hermes runs in the examples'
//! tenant on warm guests; eve runs in its own tenant (`bench-eve`, the same
//! key under that tenant's handle) on plain pooled guests.
//!
//! Steady state: every new container on pve-node-a is restarted from outside
//! Monolith about three minutes after its first start (tailscale is
//! installed into it). Samples therefore use guests older than
//! `MONOLITH_BENCH_SETTLE_S` (default 210) whose Proxmox uptime is at least
//! `MONOLITH_BENCH_UPTIME_S` (default 90), and a second fill after the wait
//! re-warms warm guests the restart emptied. The report records the waits.
//!
//! Failure modes, written before the benchmark:
//! - a number measured anywhere but the cluster is presented as R3 evidence;
//! - the clock stops before the runtime accepted a task (claim only, or the
//!   runtime merely listening);
//! - a cold clone, or a cold-pooled claim where a warm one was expected, is
//!   counted toward the percentiles;
//! - eve's one-off build on a build-cache miss is hidden in, or passed off
//!   as, the pooled numbers;
//! - a pre-started runtime holds the tenant's real key, its placeholder, its
//!   control key or its CA before it is claimed, or serves a task before go;
//! - one tenant's claim takes another tenant's warm guest;
//! - the run "passes" without having reached the cluster;
//! - a runtime does not clear one second and the result does not say so (the
//!   STOP verdict must be explicit, with its numbers);
//! - guests the run created are left on the cluster after it ends or fails.
//!
//! The proxy guests of the measured tenants are started before anything is
//! timed and checked again after every settle (`monolith proxy up`), so a
//! sample never pays for a proxy guest's creation or its re-provisioning
//! after the node's restart; both are reported.
//!
//! Settings: `MONOLITH_BENCH_RUNS` (pooled applies per runtime, default 6),
//! `MONOLITH_BENCH_COLD_RUNS` (cold clones, claim only, default 2),
//! `MONOLITH_BENCH_RUNTIMES` (default `hermes eve`), `MONOLITH_BENCH_SETTLE_S`,
//! `MONOLITH_BENCH_UPTIME_S`, `MONOLITH_BENCH_ISOLATION` (default 1; 0 skips
//! the tenant-isolation claim, which needs a third tenant's proxy guest and
//! more guests at once).
mod common;

use common::live_gate::{gate, live_driver, repo, write_report, Gate, Recorder, Sweeper};
use monolith::proxmox::delivery::GuestChannel;
use monolith::substrate::Substrate;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

const SUITE: &str = "spawn-latency";
const R3_MS: f64 = 1000.0;
/// The examples' tenant: its handle `demo/openrouter` resolves only for it.
const TENANT: &str = "demo";
const OTHER_TENANT: &str = "bench-other";
/// eve's pool tenant (a warm fill warms every ready guest of a tenant).
const EVE_TENANT: &str = "bench-eve";
const COLD_TENANT: &str = "bench-cold";
const SECRET_ENV: &str = "MONOLITH_SECRET_DEMO__OPENROUTER";

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
    names: std::cell::RefCell<Vec<String>>,
}

impl Cli {
    /// `monolith <args> --output json --targets-config <targets>`, with
    /// `--state-root` for agent commands. Every call is kept in
    /// `transcript.jsonl` beside the run.
    fn run(&self, args: &[&str]) -> (i32, Value) {
        let mut command = Command::new(env!("CARGO_BIN_EXE_monolith"));
        command.args(args).args(["--output", "json"]);
        if args.first() == Some(&"agent") {
            command.arg("--state-root").arg(&self.state_root);
        }
        let output = command
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

    fn fill(&self, target: &str, tenant: &str, warm: Option<&str>) -> Value {
        let mut args = vec!["pool", "fill", "--target", target, "--tenant", tenant];
        if let Some(runtime) = warm {
            args.extend(["--warm", runtime]);
        }
        let (code, envelope) = self.run(&args);
        assert_eq!(code, 0, "pool fill for {tenant} failed: {envelope:#}");
        let result = envelope["result"].clone();
        assert!(
            result["errors"].as_array().is_none_or(Vec::is_empty),
            "pool fill for {tenant} reported errors: {result:#}"
        );
        result
    }

    fn drain(&self, target: &str, tenant: &str) {
        let (code, envelope) = self.run(&["pool", "drain", "--target", target, "--tenant", tenant]);
        assert_eq!(code, 0, "pool drain for {tenant} failed: {envelope:#}");
    }
}

impl Drop for Cli {
    fn drop(&mut self) {
        // Never leave an agent guest or route behind, pass or fail (the
        // sweeper drains the pools and takes the proxy guests down).
        for name in self.names.borrow().clone() {
            let _ = self.run(&["agent", "destroy", &name]);
        }
    }
}

/// The example spec, placed on the live target, under a test name.
fn spec(dir: &Path, runtime: &str, name: &str, target: &str) -> PathBuf {
    let example = repo().join(format!("examples/{runtime}-agent.toml"));
    let mut text = fs::read_to_string(&example)
        .unwrap()
        .replace(&format!("name = \"demo-{runtime}\""), &format!("name = \"{name}\""))
        .replace("substrate = \"local\"", &format!("substrate = \"{target}\""));
    if runtime == "eve" {
        let dest = dir.join(format!("{name}.git"));
        let output = Command::new("sh")
            .arg(repo().join("scripts/eve-example-repo.sh"))
            .arg(&dest)
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        text = text.replace("repo = \"../target/eve-agent.git\"", &format!("repo = \"{name}.git\""));
    } else {
        copy_dir(&repo().join("examples/hermes-agent"), &dir.join("hermes-agent"));
    }
    let path = dir.join(format!("{name}.toml"));
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

fn phase_names(result: &Value) -> Vec<String> {
    result["phases"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| p["phase"].as_str().map(str::to_owned))
        .collect()
}

fn claim_kind(result: &Value) -> String {
    phase_names(result)
        .into_iter()
        .find(|p| p.starts_with("claim_"))
        .unwrap_or_else(|| "none".to_owned())
}

fn guest_of(result: &Value) -> Value {
    result["resources"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|r| r["kind"] == "guest")
        .map(|r| r["guest"].clone())
        .unwrap_or_default()
}

/// The tenant's guests in the pool state, as `pool status` reports them.
fn pool_guests(cli: &Cli, target: &str, tenant: &str) -> Vec<Value> {
    let (code, envelope) = cli.run(&["pool", "status", "--target", target]);
    assert_eq!(code, 0, "{envelope:#}");
    envelope["result"]["guests"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|g| g["tenant"] == tenant)
        .cloned()
        .collect()
}

/// Wait until every ready guest of `tenants` was created at least
/// `min_age_s` ago. Returns the seconds waited.
fn settle(
    cli: &Cli,
    driver: &monolith::proxmox::ProxmoxDriver,
    target: &str,
    tenants: &[&str],
    min_age_s: u64,
    min_uptime_s: u64,
) -> f64 {
    let started = Instant::now();
    loop {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let youngest_ms = tenants
            .iter()
            .flat_map(|t| pool_guests(cli, target, t))
            .filter(|g| g["state"] == "ready")
            .filter_map(|g| g["created_at_ms"].as_u64())
            .max();
        let Some(created) = youngest_ms else { break };
        let age_ms = now_ms.saturating_sub(created);
        if age_ms < min_age_s * 1000 {
            std::thread::sleep(Duration::from_millis((min_age_s * 1000 - age_ms).min(15_000)));
            continue;
        }
        // Past the restart, wait out its aftermath (the guest boots again
        // and starts the daemon installed into it).
        let least_uptime = tenants
            .iter()
            .flat_map(|t| pool_guests(cli, target, t))
            .filter(|g| g["state"] == "ready")
            .filter_map(|g| {
                let path = format!("/nodes/{}/lxc/{}/status/current", g["node"].as_str()?, g["vmid"].as_u64()?);
                driver.api_get(&path).ok()?.ok()?["uptime"].as_u64()
            })
            .min()
            .unwrap_or(u64::MAX);
        if least_uptime >= min_uptime_s {
            break;
        }
        std::thread::sleep(Duration::from_secs((min_uptime_s - least_uptime).min(15)));
    }
    let waited = started.elapsed().as_secs_f64();
    if waited > 1.0 {
        eprintln!("settled pooled guests for {waited:.0} s");
    }
    round_ms(waited)
}

/// Before any claim: a warm guest serves no task, refuses go without its
/// token, and holds nothing of the tenant's agent (no real key anywhere, no
/// placeholder or control key in any process environment, no CA, no go
/// record).
fn check_unclaimed_warm_guest(guest: &Value, bind_port: u16, dir: &Path, target: &str, secret: &str) -> Value {
    let vmid = guest["vmid"].as_u64().unwrap();
    let address: Ipv4Addr = guest["address"].as_str().unwrap().parse().unwrap();
    let agent = http(Duration::from_secs(5));
    let mut task = agent
        .post(format!("http://{address}:8080/v1/runs"))
        .send_json(json!({"input": "are you serving tasks before go?"}))
        .expect("the warm runtime answers");
    let task_status = task.status().as_u16();
    let task_body: Value = task.body_mut().read_json().unwrap_or_default();
    assert_eq!(task_status, 503, "an unclaimed warm runtime served a task: {task_body}");
    assert_eq!(task_body["state"], "warm", "{task_body}");
    let go = agent
        .post(format!("http://{address}:8080/monolith/warm/go"))
        .header("Authorization", "Bearer not-the-go-token")
        .send_json(json!({"env": {}, "cwd": "/srv/monolith/runtime/home"}))
        .expect("the warm runtime answers");
    let go_status = go.status().as_u16();
    assert_eq!(go_status, 401, "go without the token was not refused");

    // The pool's bind credential for this guest (kept by the control plane,
    // not a tenant secret) opens the bind agent's inspect endpoint.
    let pools = repo().join(".monolith/pools");
    let warm: Value =
        serde_json::from_slice(&fs::read(pools.join(format!("{target}-warm/{vmid}.json"))).unwrap()).unwrap();
    let channel = GuestChannel::new(address, bind_port, warm["credential"].as_str().unwrap());
    let status = channel.status().expect("bind agent status");
    assert_eq!(status["payload"]["tenant"], TENANT, "{status}");
    assert!(status["payload"]["agent"].is_null(), "a warm guest is bound to no agent: {status}");
    let inspect = dir.join(format!("warm-{vmid}-inspect.tar"));
    let size = channel.inspect(&inspect).expect("inspect tar");
    let unpacked = dir.join(format!("warm-{vmid}-inspect"));
    fs::create_dir_all(&unpacked).unwrap();
    let ok = Command::new("tar").arg("-xf").arg(&inspect).arg("-C").arg(&unpacked).status().unwrap();
    assert!(ok.success(), "the inspect tar unpacks");
    let mut files = Vec::new();
    files_under(&unpacked, &mut files);
    let mut launcher_environ = false;
    for file in &files {
        let bytes = fs::read(file).unwrap();
        let shown = file.strip_prefix(&unpacked).unwrap().display().to_string();
        assert!(!contains(&bytes, secret.as_bytes()), "the real key is in the unclaimed guest at {shown}");
        assert!(!shown.ends_with(".monolith-warm-go.json"), "the unclaimed guest holds a go record at {shown}");
        assert!(!shown.ends_with("monolith-agent-ca.pem"), "the unclaimed guest holds an agent CA at {shown}");
        if shown.ends_with("/environ") {
            for marker in ["OPENROUTER_API_KEY=", "API_SERVER_KEY=", "MONOLITH_CONTROL_KEY=", "SSL_CERT_FILE="] {
                assert!(!contains(&bytes, marker.as_bytes()), "{marker} is in a process environment at {shown}");
            }
            launcher_environ |= contains(&bytes, b"MONOLITH_WARM_PORT=");
        }
    }
    assert!(launcher_environ, "the launcher's process environment was captured");
    json!({"vmid": vmid, "task_before_go": task_status, "go_without_token": go_status, "inspect_bytes": size,
           "inspect_files": files.len(), "tenant_material_found": false})
}

#[test]
fn pooled_apply_reaches_first_task_under_one_second_on_the_cluster() {
    let (targets, target) = match gate() {
        Gate::NotRun(reason) => {
            let report = write_report(SUITE, "NOT_RUN", json!({"reason": reason, "r3_evidence": false}));
            eprintln!("NOT RUN: {reason}. Report: {}", report.display());
            return;
        }
        Gate::Requested(reason) => {
            let report =
                write_report(SUITE, "NOT_RUN", json!({"reason": reason, "r3_evidence": false, "requested": true}));
            panic!("NOT RUN (live run requested): {reason}. Report: {}", report.display());
        }
        Gate::Live { targets, target, .. } => (targets, target),
    };
    let secret = std::env::var(SECRET_ENV).unwrap_or_default();
    if secret.trim().len() < 16 {
        let reason = format!("{SECRET_ENV} must hold the examples' provider key; apply resolves it into the proxy");
        let report = write_report(SUITE, "NOT_RUN", json!({"reason": reason, "r3_evidence": false, "requested": true}));
        panic!("NOT RUN (live run requested): {reason}. Report: {}", report.display());
    }
    let runs = env_count("MONOLITH_BENCH_RUNS", 6);
    let cold_runs = env_count("MONOLITH_BENCH_COLD_RUNS", 2);
    let settle_s = env_count("MONOLITH_BENCH_SETTLE_S", 210) as u64;
    let uptime_s = env_count("MONOLITH_BENCH_UPTIME_S", 90) as u64;
    let runtimes: Vec<String> = std::env::var("MONOLITH_BENCH_RUNTIMES")
        .unwrap_or_else(|_| "hermes eve".to_owned())
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    let driver = live_driver(&targets, &target);
    let settings = driver.settings().expect("the live target has every driver field").clone();
    let template_version = match driver.template_version() {
        Ok(version) => version,
        Err(error) => {
            let reason = format!(
                "the golden template is not ready, so nothing was measured: {error} (next: {})",
                error.next.join("; ")
            );
            let report =
                write_report(SUITE, "BLOCKED", json!({"reason": reason, "target": target, "r3_evidence": false}));
            panic!("BLOCKED: {reason} Report: {}", report.display());
        }
    };
    let sweeper = Sweeper::new(&driver, &[TENANT, EVE_TENANT, OTHER_TENANT, COLD_TENANT]);
    // Start from empty pools so every sample's guest was filled by this run.
    for tenant in [TENANT, EVE_TENANT] {
        driver.drain(Some(tenant)).expect("drain a bench pool");
    }

    let tools = tools();
    let dir = repo().join("target/e2e-spawn-latency").join(std::process::id().to_string());
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let path = |p: &str| repo().join(p).to_string_lossy().into_owned();
    let mut env = BTreeMap::new();
    env.insert("MONOLITH_IRON_PROXY_BIN".to_owned(), tools["IRON_PROXY_BIN"].clone());
    env.insert("MONOLITH_IRON_PROXY_GUEST_BIN".to_owned(), tools["IRON_PROXY_LINUX_BIN"].clone());
    env.insert("MONOLITH_NODE_BIN".to_owned(), format!("{}/node", tools["NODE_BIN_DIR"]));
    env.insert("MONOLITH_NPM_CACHE".to_owned(), path("target/e2e-tools/npm-cache"));
    env.insert("MONOLITH_BUILD_CACHE".to_owned(), path(".monolith/cache"));
    env.insert("MONOLITH_POOL_DIR".to_owned(), path(".monolith/pools"));
    env.insert("MONOLITH_READY_TIMEOUT_MS".to_owned(), "300000".to_owned());
    // eve's tenant gets the same provider key under its own handle; the
    // value goes only to the CLI's environment, as the operator would set it.
    env.insert(monolith::secrets::env_variable_for(&monolith::secrets::Handle::parse(&format!("{EVE_TENANT}/openrouter")).unwrap()), secret.clone());
    // The run fills the pool itself before each sample, off the clock.
    env.insert("MONOLITH_POOL_REFILL".to_owned(), "0".to_owned());
    let cli = Cli {
        state_root: dir.join("state"),
        targets: targets.clone(),
        dir: dir.clone(),
        env,
        names: Default::default(),
    };

    // Each measured tenant's proxy guest, off the clock.
    let proxy_tenants: Vec<&str> = runtimes
        .iter()
        .map(|r| if r == "hermes" { TENANT } else { EVE_TENANT })
        .collect();
    let mut proxy_checks: Vec<Value> = Vec::new();
    let proxy_up = |cli: &Cli, tenant: &str, when: &str, checks: &mut Vec<Value>| {
        let started = Instant::now();
        let (code, envelope) = cli.run(&["proxy", "up", "--target", &target, "--tenant", tenant]);
        if code != 0 && envelope["error"]["code"] == "target_unavailable" {
            let reason = format!("{} (next: {})", envelope["error"]["message"], envelope["next"]);
            let report =
                write_report(SUITE, "BLOCKED", json!({"reason": reason, "target": target, "r3_evidence": false}));
            panic!("BLOCKED: {reason} Report: {}", report.display());
        }
        assert_eq!(code, 0, "proxy up {tenant} ({when}) failed: {envelope:#}");
        let result = &envelope["result"];
        checks.push(json!({
            "tenant": tenant,
            "when": when,
            "ms": round_ms(started.elapsed().as_secs_f64() * 1000.0),
            "changed": envelope["changed"],
            "vmid": result["vmid"],
            "provisions": result["provisions"],
        }));
    };
    for tenant in &proxy_tenants {
        proxy_up(&cli, tenant, "start", &mut proxy_checks);
    }

    // Cold path, claim only (clone, configure, start, bind): context for
    // what the pool saves. Never counted toward R3.
    let mut cold = Vec::new();
    for run in 0..cold_runs {
        let mut journal = Recorder::default();
        let started = Instant::now();
        let claim = driver
            .cold_claim(COLD_TENANT, &format!("bench-cold-{run}"), run as u64 + 1, &mut journal)
            .unwrap_or_else(|error| panic!("cold clone {run} failed: {error}"));
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        sweeper.track(claim.vmid);
        assert!(!claim.pooled);
        cold.push(json!({"run": run, "ms": round_ms(ms), "vmid": claim.vmid}));
        driver.destroy(&claim.resource).expect("destroy cold guest");
        eprintln!("cold clone {run}: {ms:.0} ms (vmid {})", claim.vmid);
    }

    // Each runtime has its own tenant pool: a fill with --warm warms every
    // ready guest of the tenant, and eve has no warm runtime. Hermes uses the
    // examples' tenant; eve's spec is moved to EVE_TENANT with the same key
    // under that tenant's own handle.
    struct Plan {
        runtime: String,
        tenant: &'static str,
        warm: Option<&'static str>,
        expected_claim: &'static str,
        name: String,
        spec: String,
        total: usize,
        samples: Vec<Value>,
        other_claims: Vec<Value>,
        first: Value,
        fill_ms: Vec<f64>,
    }
    let mut plans: Vec<Plan> = runtimes
        .iter()
        .map(|runtime| {
            let hermes = runtime == "hermes";
            let tenant = if hermes { TENANT } else { EVE_TENANT };
            let name = format!("bench-{runtime}");
            let mut path = spec(&dir, runtime, &name, &target);
            if !hermes {
                let text = fs::read_to_string(&path)
                    .unwrap()
                    .replace(&format!("tenant_id = \"{TENANT}\""), &format!("tenant_id = \"{tenant}\""))
                    .replace(&format!("handle = \"{TENANT}/openrouter\""), &format!("handle = \"{tenant}/openrouter\""));
                path = dir.join(format!("{name}-{tenant}.toml"));
                fs::write(&path, text).unwrap();
            }
            Plan {
                runtime: runtime.clone(),
                tenant,
                warm: hermes.then_some("hermes"),
                expected_claim: if hermes { "claim_warm" } else { "claim_pooled" },
                name,
                spec: path.to_string_lossy().into_owned(),
                // eve builds its agent once per source revision; the first
                // apply of a run may pay that build and is reported apart.
                total: if hermes { runs } else { runs + 1 },
                samples: Vec::new(),
                other_claims: Vec::new(),
                first: Value::Null,
                fill_ms: Vec::new(),
            }
        })
        .collect();
    let mut unclaimed_checks = Vec::new();
    let mut settle_waits = Vec::new();
    let rounds = plans.iter().map(|p| p.total).max().unwrap_or(0);
    for round in 0..rounds {
        // Fill each pool (off the clock), let every pooled guest get past
        // the node's restart window, then fill again: the second fill
        // re-warms a warm guest that the restart emptied.
        for plan in plans.iter_mut().filter(|p| round < p.total) {
            let started = Instant::now();
            let filled = cli.fill(&target, plan.tenant, plan.warm);
            for vmid in filled["ready"].as_array().into_iter().flatten() {
                sweeper.track(vmid.as_u64().unwrap() as u32);
            }
            if filled["created"].as_array().is_some_and(|c| !c.is_empty()) {
                plan.fill_ms.push(round_ms(started.elapsed().as_secs_f64() * 1000.0));
            }
        }
        let tenants: Vec<&str> = plans.iter().filter(|p| round < p.total).map(|p| p.tenant).collect();
        let waited = settle(&cli, &driver, &target, &tenants, settle_s, uptime_s);
        settle_waits.push(waited);
        // The proxy guests are older than any pooled guest; past the restart
        // they may need provisioning again, which must not land on a sample.
        for tenant in &tenants {
            proxy_up(&cli, tenant, &format!("round {round}"), &mut proxy_checks);
        }
        for plan in plans.iter_mut().filter(|p| round < p.total) {
            let filled = cli.fill(&target, plan.tenant, plan.warm);
            for vmid in filled["ready"].as_array().into_iter().flatten() {
                sweeper.track(vmid.as_u64().unwrap() as u32);
            }
            if plan.warm.is_some() && round == 0 {
                // Inspect the warm guest the next claim will not take (a
                // claim takes the first one): reading 30 MB of its state
                // would perturb the guest the timed apply then uses.
                let guests = pool_guests(&cli, &target, plan.tenant);
                let guest = guests.iter().rev().find(|g| !g["warm"].is_null()).expect("a warm guest after fill --warm");
                unclaimed_checks.push(check_unclaimed_warm_guest(guest, settings.bind_port, &dir, &target, &secret));
            }
        }
        for plan in plans.iter_mut().filter(|p| round < p.total) {
            let name = plan.name.clone();
            cli.names.borrow_mut().push(name.clone());
            let (code, envelope) = cli.run(&["agent", "apply", &plan.spec]);
            assert_eq!(code, 0, "apply {name} (round {round}) failed: {envelope:#}");
            let result = &envelope["result"];
            let ready_ms = result["ready_ms"].as_f64().expect("ready_ms");
            let phases: Vec<Value> = result["phases"].as_array().cloned().unwrap_or_default();
            let claim = claim_kind(result);
            assert!(
                phase_names(result).iter().any(|p| p.starts_with("first_task_accepted")),
                "apply reported ready without the first-task probe: {phases:?}"
            );
            let row = json!({
                "run": round,
                "ms": ready_ms,
                "claim": claim,
                "vmid": guest_of(result)["vmid"],
                "phases": phases.iter().map(|p| json!([p["phase"], p["ms"]])).collect::<Vec<_>>(),
            });
            eprintln!(
                "{} {round}: ready {ready_ms:.0} ms ({claim}) {}",
                plan.runtime,
                phases
                    .iter()
                    .map(|p| format!("{} {:.0}", p["phase"].as_str().unwrap_or_default(), p["ms"].as_f64().unwrap_or(0.0)))
                    .collect::<Vec<_>>()
                    .join(" | ")
            );
            let (code, destroyed) = cli.run(&["agent", "destroy", &name]);
            assert_eq!(code, 0, "destroy {name}: {destroyed:#}");
            cli.names.borrow_mut().retain(|n| n != &name);
            if plan.runtime == "eve" && round == 0 {
                plan.first = row;
            } else if claim == plan.expected_claim {
                plan.samples.push(row);
            } else {
                plan.other_claims.push(row);
            }
        }
    }
    for plan in &plans {
        cli.drain(&target, plan.tenant);
    }

    // Tenant isolation: with the tenant's own pool empty and another
    // tenant's warm guests ready, a claim must clone, never take theirs.
    let mut isolation = Value::Null;
    let check_isolation = env_count("MONOLITH_BENCH_ISOLATION", 1) != 0;
    if let Some(plan) = plans.iter().find(|p| p.warm.is_some() && check_isolation) {
        let others = cli.fill(&target, OTHER_TENANT, plan.warm);
        let other_vmids: Vec<u64> = others["ready"].as_array().unwrap().iter().filter_map(Value::as_u64).collect();
        for vmid in &other_vmids {
            sweeper.track(*vmid as u32);
        }
        assert!(!other_vmids.is_empty(), "{OTHER_TENANT} has warm guests: {others}");
        cli.names.borrow_mut().push(plan.name.clone());
        let (code, envelope) = cli.run(&["agent", "apply", &plan.spec]);
        assert_eq!(code, 0, "apply {} with an empty pool failed: {envelope:#}", plan.name);
        let result = &envelope["result"];
        let vmid = guest_of(result)["vmid"].as_u64().unwrap();
        let claim = claim_kind(result);
        assert!(!other_vmids.contains(&vmid), "tenant {TENANT} claimed {OTHER_TENANT}'s guest {vmid}");
        assert_eq!(claim, "claim_cold_clone", "with an empty pool the claim must clone");
        let still_other: Vec<u64> =
            pool_guests(&cli, &target, OTHER_TENANT).iter().filter_map(|g| g["vmid"].as_u64()).collect();
        assert_eq!(still_other, other_vmids, "{OTHER_TENANT}'s warm guests are untouched");
        let (code, destroyed) = cli.run(&["agent", "destroy", &plan.name]);
        assert_eq!(code, 0, "destroy {}: {destroyed:#}", plan.name);
        cli.names.borrow_mut().retain(|n| n != &plan.name);
        cli.drain(&target, OTHER_TENANT);
        isolation = json!({
            "other_tenant_warm_guests": other_vmids,
            "claimed_vmid": vmid,
            "claim": claim,
            "cold_ready_ms": result["ready_ms"],
            "took_other_tenants_guest": false,
        });
    }

    let mut per_runtime = serde_json::Map::new();
    for plan in plans {
        let runs = plan.total - usize::from(!plan.first.is_null());
        let stats = stats(&plan.samples);
        let p95 = stats["p95_ms"].as_f64();
        let meets = plan.samples.len() == runs && p95.is_some_and(|p| p < R3_MS);
        let (runtime, expected_claim) = (&plan.runtime, plan.expected_claim);
        let verdict = if meets {
            format!(
                "{runtime}: PASS, apply-to-first-task p95 {} ms (p50 {} ms) over {} {expected_claim} samples",
                p95.unwrap(),
                stats["p50_ms"],
                plan.samples.len()
            )
        } else if plan.samples.len() < runs {
            format!(
                "{runtime}: STOP, {} of {runs} applies did not get a {expected_claim} ({:?}); R3 is not shown",
                runs - plan.samples.len(),
                plan.other_claims.iter().map(|r| r["claim"].clone()).collect::<Vec<_>>()
            )
        } else {
            format!(
                "{runtime}: STOP, apply-to-first-task p95 {} ms (p50 {} ms) is not under {R3_MS} ms",
                p95.unwrap_or(f64::NAN),
                stats["p50_ms"]
            )
        };
        eprintln!("{verdict}");
        per_runtime.insert(
            runtime.clone(),
            json!({
                "tenant": plan.tenant,
                "path": if plan.warm.is_some() {
                    "warm pooled guest: runtime pre-started at fill, agent late-bound by go"
                } else {
                    "pooled guest: runtime delivered and started at claim"
                },
                "stats": stats,
                "meets_r3": meets,
                "verdict": verdict,
                "samples": plan.samples,
                "other_claims": plan.other_claims,
                "first_apply_of_run": plan.first,
                "refill_ms": plan.fill_ms,
            }),
        );
    }
    let drained: Vec<u32> = [TENANT, EVE_TENANT]
        .iter()
        .flat_map(|t| driver.drain(Some(t)).expect("drain"))
        .collect();

    let meets = !per_runtime.is_empty() && per_runtime.values().all(|r| r["meets_r3"] == true);
    let detail = json!({
        "target": target,
        "node": settings.node,
        "guest_type": "lxc",
        "template_id": settings.template_id,
        "template_version": template_version,
        "guest_memory_mb": settings.memory_mb,
        "warm_pool_size": settings.warm_pool_size,
        "runs": runs,
        "r3_threshold_ms": R3_MS,
        "r3_evidence": true,
        "clock": "monolith agent apply through the CLI, from the request to the runtime accepting its first task (ready_ms); pools filled before each sample, off the clock",
        "runtimes": per_runtime,
        "unclaimed_warm_guest": unclaimed_checks,
        "settle": {"min_guest_age_s": settle_s, "min_uptime_s": uptime_s, "waited_s": settle_waits, "why": "every new container on pve-node-a is restarted from outside Monolith about three minutes after its first start (tailscale is installed into it); samples use guests past that restart and its boot aftermath, and a fill after it re-warms guests the restart emptied"},
        "tenant_isolation": if check_isolation { isolation } else { json!("skipped (MONOLITH_BENCH_ISOLATION=0)") },
        "proxy_guests": proxy_checks,
        "cold_clone_claim_only": {"stats": stats(&cold), "samples": cold},
        "drained": drained,
        "transcript": dir.join("transcript.jsonl"),
        "verdict": per_runtime.values().map(|r| r["verdict"].clone()).collect::<Vec<_>>(),
        "meets_r3": meets,
    });
    let report = write_report(SUITE, if meets { "PASSED" } else { "FAILED" }, detail.clone());
    write_benchmark_doc(&detail, &report);
    drop(cli);
    drop(sweeper);
    assert!(meets, "{}. Report: {}", detail["verdict"], report.display());
    eprintln!("{}. Report: {}", detail["verdict"], report.display());
}

fn env_count(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or(default)
}

fn round_ms(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// Nearest-rank percentiles over the samples' `ms`.
fn stats(samples: &[Value]) -> Value {
    let mut values: Vec<f64> = samples.iter().filter_map(|s| s["ms"].as_f64()).collect();
    if values.is_empty() {
        return json!({"n": 0});
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let rank = |p: f64| values[((p / 100.0 * values.len() as f64).ceil() as usize).clamp(1, values.len()) - 1];
    json!({
        "n": values.len(),
        "min_ms": values[0],
        "p50_ms": rank(50.0),
        "p95_ms": rank(95.0),
        "max_ms": values[values.len() - 1],
        "mean_ms": round_ms(values.iter().sum::<f64>() / values.len() as f64),
    })
}

/// Median time of each apply phase over the samples, in apply order.
fn phase_medians(samples: &[Value]) -> Vec<(String, f64)> {
    let mut order: Vec<String> = Vec::new();
    let mut values: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    for sample in samples {
        for pair in sample["phases"].as_array().into_iter().flatten() {
            let mut name = pair[0].as_str().unwrap_or_default().to_owned();
            if name.starts_with("first_task_accepted") {
                name = "first_task_accepted".to_owned();
            }
            if !order.contains(&name) {
                order.push(name.clone());
            }
            values.entry(name).or_default().push(pair[1].as_f64().unwrap_or(0.0));
        }
    }
    order
        .into_iter()
        .map(|name| {
            let mut v = values.remove(&name).unwrap_or_default();
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let median = v.get(v.len() / 2).copied().unwrap_or(0.0);
            (name, round_ms(median.max(0.0)))
        })
        .collect()
}

fn write_benchmark_doc(detail: &Value, report: &Path) {
    let mut rows = String::new();
    let mut breakdowns = String::new();
    for (runtime, r) in detail["runtimes"].as_object().into_iter().flatten() {
        let s = &r["stats"];
        rows.push_str(&format!(
            "| {runtime} | {} | {} | {} | {} | {} | {} |\n",
            r["path"].as_str().unwrap_or_default(),
            s["n"],
            s["p50_ms"],
            s["p95_ms"],
            s["min_ms"],
            s["max_ms"]
        ));
        let samples: Vec<Value> = r["samples"].as_array().cloned().unwrap_or_default();
        breakdowns.push_str(&format!(
            "- {runtime}: {}\n",
            phase_medians(&samples)
                .iter()
                .map(|(n, ms)| format!("{n} {ms}"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
        let first = &r["first_apply_of_run"];
        if !first.is_null() {
            let phases: Vec<String> = first["phases"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|p| format!("{} {:.0}", p[0].as_str().unwrap_or_default(), p[1].as_f64().unwrap_or(0.0).max(0.0)))
                .collect();
            breakdowns.push_str(&format!(
                "  - first {runtime} apply of the run, not counted (pays the build on a build-cache miss): {} ms; {}\n",
                first["ms"],
                phases.join(", ")
            ));
        }
    }
    let cold = &detail["cold_clone_claim_only"]["stats"];
    let verdicts: Vec<String> = detail["verdict"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|v| format!("- {}", v.as_str().unwrap_or_default()))
        .collect();
    let text = format!(
        "# Spawn latency (U1)\n\n\
         Generated by `MONOLITH_PROXMOX_LIVE=1 cargo test --test e2e_spawn_latency -- --nocapture`.\n\
         Machine-readable report: `{report}`. The mechanism and its decisions are in `templates/README.md`, \"Warm runtimes\".\n\n\
         ## Verdict\n\n{verdicts}\n\n\
         ## Before: credential proxy on the control plane (U7 stage 1, 2026-10-09)\n\n\
         - Report `.monolith/reports/20261009T033408Z-spawn-latency-8754.json`: Hermes on a warm guest p50 834 ms, p95 1004 ms; \
         eve on a pooled guest p50 1622 ms. `proxy_plan`, `proxy_start` and `relay_start` (about 87 ms together) ran iron-proxy \
         and a relay to it on the control plane.\n\n\
         ## Before that (2026-10-08, same cluster, same clock)\n\n\
         - eve on a pooled guest: 7.8 s (`eve build` on every apply 5.6 s, bundle 0.4 s, upload 0.3 s, Node start to first task 1.2 s).\n\
         - Hermes on a pooled guest: 11.9 s (a lazy PyPI install of `discord.py` at start 8.5 to 9.7 s, imports 1.1 s, skills sync 0.4 s, \
         and the probe stopping its own run before ready).\n\
         - Decisions: Hermes runs on a warm runtime pre-started per tenant at fill and late-bound by go; lazy installs are off in guests; \
         the probe's run is stopped after ready; eve's build and bundle are cached per source revision; eve has no generic warm runtime \
         because the agent is compiled into its server bundle. No template rebuild.\n\n\
         ## Setup\n\n\
         - Target `{target}`, node `{node}`, guest type `lxc`, template {template} (version `{version}`).\n\
         - Linked clones (`full=0`) on `local-lvm`, {memory} MB each, warm pool size {size} per tenant.\n\
         - Clock: {clock}.\n         - Steady state: {settle}\n\n\
         ## Results: apply to first task accepted\n\n\
         | Runtime | Path | n | p50 ms | p95 ms | min ms | max ms |\n|---|---|---|---|---|---|---|\n{rows}\n\
         R3 threshold: p95 under {threshold} ms, per runtime.\n\n\
         Median time per apply phase (ms):\n\n{breakdowns}\n\
         The credential proxy runs in the tenant's proxy guest: `proxy_plan` mints the agent's CA (no local config, no process), \
         `proxy_ready` is the proxy guest's health check, and the agent's route starts there beside the upload (`upload`) \
         or before go (`route`). No proxy or relay process runs on the control plane.\n\n\
         - Proxy guests (`monolith proxy up`, off the clock): {proxies}\n\
         - Cold clone, claim only (clone, start, bind; no runtime): p50 {cold_p50} ms, p95 {cold_p95} ms (n {cold_n}); not counted toward R3.\n\
         - Unclaimed warm guests checked (no task before go, no tenant material): {unclaimed}\n\
         - Tenant isolation: {isolation}\n",
        report = report.display(),
        verdicts = verdicts.join("\n"),
        target = detail["target"].as_str().unwrap_or_default(),
        node = detail["node"].as_str().unwrap_or_default(),
        template = detail["template_id"],
        version = detail["template_version"].as_str().unwrap_or_default(),
        memory = detail["guest_memory_mb"],
        size = detail["warm_pool_size"],
        clock = detail["clock"].as_str().unwrap_or_default(),
        threshold = R3_MS,
        cold_p50 = cold["p50_ms"],
        cold_p95 = cold["p95_ms"],
        cold_n = cold["n"],
        unclaimed = detail["unclaimed_warm_guest"],
        isolation = detail["tenant_isolation"],
        proxies = detail["proxy_guests"],
        settle = detail["settle"]["why"].as_str().unwrap_or_default(),
    );
    let path = repo().join("docs/benchmarks/spawn-latency.md");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}
