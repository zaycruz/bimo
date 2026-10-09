//! Fabric E2E, local mode. Drives the real `monolith` binary against the real
//! local substrate with a real Hermes Agent (pinned, installed by
//! `scripts/e2e-tools.sh` into target/e2e-tools). No fakes, mocks or
//! simulated substrates.
//!
//! Every envelope a test sees is validated against
//! `docs/agent-cli.schema.json` and appended to a transcript under
//! `target/e2e-fabric/`, which is the repeatable artifact of the run.
//!
//! Failure modes this suite exists to catch, written before the cases:
//! - apply reports success but no runtime accepted a first task;
//! - a second unchanged apply restarts, recreates or rewrites anything (AE5);
//! - an apply killed between intent and commit leaves processes nobody owns,
//!   or status hides them, or the next apply does not clear them (F2);
//! - an apply killed after commit leaves the superseded generation running;
//! - a bad spec touches the substrate, or reports only its first problem;
//! - a handle from another tenant, or a host outside the allowlist, passes;
//! - an agent name is taken over by another tenant;
//! - a configured proxmox target without a token fails vaguely;
//! - any envelope drifts from the published schema;
//! - the agent's log or environment carries a real secret value;
//! - the outbound request does not carry the real credential, or carries it
//!   to a host the secret is not bound to (AE3);
//! - a host outside the allowlist is reached, or its refusal is not audited;
//! - a client that ignores the proxy variables connects directly;
//! - the agent can read the proxy's secrets, CA key, config or audit log, or
//!   another tenant's state, or reach another tenant's agent (AE4, local);
//! - a rotated secret needs a restart, or the live proxy keeps the old value;
//! - the per-agent CA can sign for hosts outside the allowlist.
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

const REAL_SECRET: &str = "sk-or-v1-e2e-real-value-0123456789abcdef";

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn tools() -> &'static BTreeMap<String, String> {
    static TOOLS: OnceLock<BTreeMap<String, String>> = OnceLock::new();
    TOOLS.get_or_init(|| {
        let output = Command::new("sh")
            .arg(repo().join("scripts/e2e-tools.sh"))
            .output()
            .expect("could not run scripts/e2e-tools.sh");
        assert!(
            output.status.success(),
            "scripts/e2e-tools.sh failed:\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.split_once('='))
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect()
    })
}

fn schema() -> &'static jsonschema::Validator {
    static SCHEMA: OnceLock<jsonschema::Validator> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        let text = fs::read_to_string(repo().join("docs/agent-cli.schema.json")).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        jsonschema::validator_for(&value).expect("docs/agent-cli.schema.json is not a valid schema")
    })
}

struct Run {
    code: i32,
    envelope: Value,
}

struct Fabric {
    dir: PathBuf,
    state_root: PathBuf,
    transcript: PathBuf,
    env: BTreeMap<String, String>,
    /// A targets file passed to every command, including the cleanup in Drop.
    targets: Option<PathBuf>,
}

impl Fabric {
    fn new(test: &str) -> Self {
        let dir = repo()
            .join("target/e2e-fabric")
            .join(format!("{test}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut env = BTreeMap::new();
        env.insert("MONOLITH_HERMES_BIN".to_owned(), tools()["HERMES_BIN"].clone());
        env.insert("MONOLITH_IRON_PROXY_BIN".to_owned(), tools()["IRON_PROXY_BIN"].clone());
        env.insert("MONOLITH_SECRET_DEMO__OPENROUTER".to_owned(), REAL_SECRET.to_owned());
        env.insert("MONOLITH_READY_TIMEOUT_MS".to_owned(), "90000".to_owned());
        env.insert(
            "MONOLITH_NODE_BIN".to_owned(),
            format!("{}/node", tools()["NODE_BIN_DIR"]),
        );
        env.insert(
            "MONOLITH_NPM_CACHE".to_owned(),
            repo().join("target/e2e-tools/npm-cache").to_string_lossy().into_owned(),
        );
        Self {
            state_root: dir.join("state"),
            transcript: dir.join("transcript.jsonl"),
            dir,
            env,
            targets: None,
        }
    }

    fn with_targets(mut self, text: &str) -> Self {
        let path = self.dir.join("targets.toml");
        fs::write(&path, text).unwrap();
        self.targets = Some(path);
        self
    }

    /// Copy the Hermes example into this test's directory, with overrides.
    fn hermes_spec(&self, file: &str, name: &str, tenant: &str, handle: &str) -> PathBuf {
        let source = self.dir.join(format!("{name}-config"));
        copy_dir(&repo().join("examples/hermes-agent"), &source);
        let spec = self.dir.join(file);
        let text = fs::read_to_string(repo().join("examples/hermes-agent.toml"))
            .unwrap()
            .replace("name = \"demo-hermes\"", &format!("name = \"{name}\""))
            .replace("tenant_id = \"demo\"", &format!("tenant_id = \"{tenant}\""))
            .replace("handle = \"demo/openrouter\"", &format!("handle = \"{handle}\""))
            .replace("path = \"hermes-agent\"", &format!("path = \"{name}-config\""));
        fs::write(&spec, text).unwrap();
        spec
    }

    /// Publish the eve example as a git repository and write a spec pinned to
    /// its commit. Asserts the checked-in example pins the same commit.
    fn eve_spec(&self, file: &str, name: &str) -> PathBuf {
        let dest = self.dir.join(format!("{name}.git"));
        let output = Command::new("sh")
            .arg(repo().join("scripts/eve-example-repo.sh"))
            .arg(&dest)
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let stdout = String::from_utf8_lossy(&output.stdout);
        let rev = stdout
            .lines()
            .find_map(|line| line.strip_prefix("REV="))
            .unwrap()
            .to_owned();
        let example = fs::read_to_string(repo().join("examples/eve-agent.toml")).unwrap();
        assert!(
            example.contains(&format!("rev = \"{rev}\"")),
            "examples/eve-agent.toml must pin {rev}, the commit scripts/eve-example-repo.sh publishes"
        );
        let text = example
            .replace("name = \"demo-eve\"", &format!("name = \"{name}\""))
            .replace("repo = \"../target/eve-agent.git\"", &format!("repo = \"{name}.git\""));
        let spec = self.dir.join(file);
        fs::write(&spec, text).unwrap();
        spec
    }

    fn agent(&self, args: &[&str]) -> Run {
        self.agent_with(args, &[])
    }

    fn agent_with(&self, args: &[&str], extra_env: &[(&str, &str)]) -> Run {
        let mut command = Command::new(env!("CARGO_BIN_EXE_monolith"));
        command.arg("agent").args(args);
        command.args(["--output", "json", "--state-root"]).arg(&self.state_root);
        if let Some(targets) = &self.targets {
            command.arg("--targets-config").arg(targets);
        }
        command.env_remove("MONOLITH_INJECT_CRASH");
        command.envs(&self.env);
        for (key, value) in extra_env {
            command.env(key, value);
        }
        let output = command.output().expect("could not run monolith");
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let code = output.status.code().unwrap_or(-1);
        let envelope: Value = if code == 137 {
            Value::Null
        } else {
            serde_json::from_str(stdout.trim()).unwrap_or_else(|error| {
                panic!(
                    "agent {args:?} did not print one JSON envelope ({error}):\nstdout: {stdout}\nstderr: {}",
                    String::from_utf8_lossy(&output.stderr)
                )
            })
        };
        if !envelope.is_null() {
            let errors: Vec<String> = schema()
                .iter_errors(&envelope)
                .map(|e| format!("{} at {}", e, e.instance_path()))
                .collect();
            assert!(
                errors.is_empty(),
                "envelope for {args:?} does not match docs/agent-cli.schema.json: {errors:#?}\n{envelope:#}"
            );
        }
        let record = serde_json::json!({"args": args, "env": extra_env, "exit": code, "envelope": envelope});
        let mut line = serde_json::to_string(&record).unwrap();
        line.push('\n');
        use std::io::Write;
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.transcript)
            .unwrap()
            .write_all(line.as_bytes())
            .unwrap();
        Run { code, envelope }
    }

    fn journal(&self, name: &str) -> Vec<Value> {
        fs::read_to_string(self.state_root.join(name).join("journal.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}

impl Drop for Fabric {
    fn drop(&mut self) {
        // Never leave a runtime behind, pass or fail.
        let Ok(entries) = fs::read_dir(&self.state_root) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let mut command = Command::new(env!("CARGO_BIN_EXE_monolith"));
            command
                .args(["agent", "destroy", &name, "--output", "json", "--state-root"])
                .arg(&self.state_root)
                .envs(&self.env);
            if let Some(targets) = &self.targets {
                command.arg("--targets-config").arg(targets);
            }
            let _ = command.output();
        }
    }
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).unwrap();
        }
    }
}

fn pid_alive(pid: u64) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

/// Every process pid in a resource list, sorted.
fn pids(resources: &Value) -> Vec<u64> {
    let mut pids: Vec<u64> = resources
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|r| r["process"]["pid"].as_u64().or(r["resource"]["process"]["pid"].as_u64()))
        .collect();
    pids.sort_unstable();
    pids
}

/// The pid of the resource of one kind (`agent_process` or `proxy_process`).
fn pid_of(resources: &Value, kind: &str) -> u64 {
    resources
        .as_array()
        .unwrap()
        .iter()
        .map(|r| if r["resource"].is_object() { &r["resource"] } else { r })
        .find(|r| r["kind"] == kind)
        .and_then(|r| r["process"]["pid"].as_u64())
        .unwrap_or_else(|| panic!("no {kind} in {resources:#}"))
}

fn wait_dead(pid: u64) -> bool {
    for _ in 0..100 {
        if !pid_alive(pid) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    false
}

fn ok(run: &Run) -> &Value {
    assert_eq!(run.code, 0, "expected success: {:#}", run.envelope);
    assert_eq!(run.envelope["ok"], true);
    &run.envelope["result"]
}

#[test]
fn hermes_applies_through_the_local_driver_and_reapply_changes_nothing() {
    let fabric = Fabric::new("apply-idempotent");
    let spec = fabric.hermes_spec("agent.toml", "e2e-hermes", "demo", "demo/openrouter");
    let spec = spec.to_str().unwrap();

    let validated = fabric.agent(&["validate", spec]);
    assert_eq!(ok(&validated)["runtime"], "hermes");

    let plan = fabric.agent(&["plan", spec]);
    assert_eq!(ok(&plan)["action"], "create");
    let key = plan.envelope["idempotency_key"].clone();
    assert!(key.is_string());

    let applied = fabric.agent(&["apply", spec]);
    let result = ok(&applied);
    assert_eq!(applied.envelope["changed"], true);
    assert_eq!(applied.envelope["idempotency_key"], key);
    assert!(result["first_task_id"].as_str().unwrap().starts_with("run_"), "{result:#}");
    let ready_ms = result["ready_ms"].as_u64().unwrap();
    // The credential proxy is a resource of the agent, started before it.
    let kinds: Vec<&str> = result["resources"].as_array().unwrap().iter().map(|r| r["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, vec!["proxy_process", "agent_process"]);
    let pid = pid_of(&result["resources"], "agent_process");
    let all = pids(&result["resources"]);
    assert!(all.iter().all(|p| pid_alive(*p)));
    let journal_len = fabric.journal("e2e-hermes").len();
    let record = fs::read(fabric.state_root.join("e2e-hermes/agent.json")).unwrap();

    // AE5: an unchanged apply creates, restarts and modifies nothing.
    let again = fabric.agent(&["apply", spec]);
    let result = ok(&again);
    assert_eq!(again.envelope["changed"], false, "{:#}", again.envelope);
    assert_eq!(again.envelope["idempotency_key"], key);
    assert_eq!(pids(&result["resources"]), all);
    assert!(result["ready_ms"].is_null() && result["first_task_id"].is_null());
    assert_eq!(fabric.journal("e2e-hermes").len(), journal_len, "the journal must not grow");
    assert_eq!(fs::read(fabric.state_root.join("e2e-hermes/agent.json")).unwrap(), record);
    assert_eq!(ok(&fabric.agent(&["plan", spec]))["action"], "none");

    let status = fabric.agent(&["status", "e2e-hermes"]);
    let result = ok(&status);
    assert_eq!(result["status"], "ready");
    assert_eq!(result["ready_ms"].as_u64(), Some(ready_ms));
    assert!(result["resources"].as_array().unwrap().iter().all(|r| r["alive"] == true));

    let listed = fabric.agent(&["list"]);
    assert_eq!(ok(&listed).as_array().unwrap().len(), 1);

    // The agent sees a placeholder, never the real value.
    let environ = Command::new("ps")
        .args(["eww", "-o", "command=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let environ = String::from_utf8_lossy(&environ.stdout);
    assert!(environ.contains("OPENROUTER_API_KEY=sk-or-v1-"), "{environ}");
    assert!(!environ.contains(REAL_SECRET), "the real secret reached the agent's environment");
    let logs = fabric.agent(&["logs", "e2e-hermes"]);
    assert!(!ok(&logs)["text"].as_str().unwrap().contains(REAL_SECRET));
    let journal = fabric.agent(&["logs", "e2e-hermes", "--stream", "journal"]);
    assert!(ok(&journal)["text"].as_str().unwrap().contains("\"event\":\"commit\""));

    let destroyed = fabric.agent(&["destroy", "e2e-hermes"]);
    assert_eq!(destroyed.envelope["changed"], true);
    assert_eq!(pids(&ok(&destroyed)["destroyed"]), all);
    assert!(all.iter().all(|p| wait_dead(*p)), "destroy must stop the runtime and its proxy");
    assert_eq!(ok(&fabric.agent(&["status", "e2e-hermes"]))["status"], "destroyed");
    let again = fabric.agent(&["destroy", "e2e-hermes"]);
    assert_eq!(again.envelope["changed"], false);
}

#[test]
fn an_apply_killed_before_commit_leaves_remains_that_status_shows_and_apply_clears() {
    let fabric = Fabric::new("crash-before-commit");
    let spec = fabric.hermes_spec("agent.toml", "e2e-crash", "demo", "demo/openrouter");
    let spec = spec.to_str().unwrap();

    // Killed right after the runtime (started after its proxy) was journaled
    // as created.
    let crashed = fabric.agent_with(&["apply", spec], &[("MONOLITH_INJECT_CRASH", "created:agent_process")]);
    assert_eq!(crashed.code, 137);
    let status = fabric.agent(&["status", "e2e-crash"]);
    let result = ok(&status);
    assert_eq!(result["status"], "absent");
    let remains = &result["remains"];
    assert_eq!(remains.as_array().unwrap().len(), 2, "{result:#}");
    let orphan = pid_of(remains, "agent_process");
    let orphans = pids(remains);
    assert!(orphans.iter().all(|p| pid_alive(*p)), "the injected crash should leave the runtime and proxy running");
    assert!(status.envelope["next"][0].as_str().unwrap().contains("remain"));
    assert_eq!(ok(&fabric.agent(&["plan", spec]))["remains"].as_array().unwrap().len(), 2);

    // The next apply clears the remains and converges.
    let applied = fabric.agent(&["apply", spec]);
    let result = ok(&applied);
    assert_eq!(pids(&result["recovered"]), orphans);
    assert!(orphans.iter().all(|p| wait_dead(*p)), "recovery must stop the orphaned runtime and proxy");
    let all = pids(&result["resources"]);
    let pid = pid_of(&result["resources"], "agent_process");
    assert_ne!(pid, orphan);
    let status = fabric.agent(&["status", "e2e-crash"]);
    assert_eq!(ok(&status)["status"], "ready");
    assert!(ok(&status)["remains"].as_array().unwrap().is_empty());

    // Killed after the first task was accepted but before commit: destroy
    // clears both the committed agent and the remains.
    let config = fabric.dir.join("e2e-crash-config/SOUL.md");
    fs::write(&config, "You are a terse assistant. Generation two.\n").unwrap();
    let crashed = fabric.agent_with(&["apply", spec], &[("MONOLITH_INJECT_CRASH", "ready")]);
    assert_eq!(crashed.code, 137);
    let status = fabric.agent(&["status", "e2e-crash"]);
    let result = ok(&status);
    assert_eq!(result["status"], "ready", "the committed generation still serves");
    let remains = pids(&result["remains"]);
    assert_eq!(remains.len(), 2, "{result:#}");
    let destroyed = fabric.agent(&["destroy", "e2e-crash"]);
    let result = ok(&destroyed);
    assert_eq!(pids(&result["recovered"]), remains);
    assert_eq!(pids(&result["destroyed"]), all);
    assert!(all.iter().chain(&remains).all(|p| wait_dead(*p)));
    assert!(ok(&fabric.agent(&["status", "e2e-crash"]))["remains"].as_array().unwrap().is_empty());
}

#[test]
fn an_apply_killed_after_commit_still_retires_the_superseded_generation() {
    let fabric = Fabric::new("crash-after-commit");
    let spec = fabric.hermes_spec("agent.toml", "e2e-retire", "demo", "demo/openrouter");
    let spec = spec.to_str().unwrap();
    let first = pids(&ok(&fabric.agent(&["apply", spec]))["resources"]);

    fs::write(
        fabric.dir.join("e2e-retire-config/SOUL.md"),
        "You are a terse assistant. Replaced.\n",
    )
    .unwrap();
    let plan = fabric.agent(&["plan", spec]);
    assert_eq!(ok(&plan)["action"], "replace");
    let crashed = fabric.agent_with(&["apply", spec], &[("MONOLITH_INJECT_CRASH", "commit")]);
    assert_eq!(crashed.code, 137);

    let status = fabric.agent(&["status", "e2e-retire"]);
    let result = ok(&status);
    assert_eq!(result["status"], "ready");
    assert_eq!(result["generation"], 2);
    assert_eq!(pids(&result["remains"]), first, "{result:#}");
    assert!(first.iter().all(|p| pid_alive(*p)));

    let applied = fabric.agent(&["apply", spec]);
    assert_eq!(applied.envelope["changed"], true, "clearing remains is a change");
    assert_eq!(ok(&applied)["generation"], 2, "the committed generation is kept");
    assert!(first.iter().all(|p| wait_dead(*p)), "the superseded runtime and proxy must be retired");
}

#[test]
fn invalid_specs_fail_before_anything_runs_with_every_problem_listed() {
    let fabric = Fabric::new("invalid-specs");
    let spec = fabric.dir.join("bad.toml");
    fs::create_dir_all(fabric.dir.join("cfg")).unwrap();
    fs::write(
        &spec,
        r#"
schema_version = 1
name = "Bad_Name"
runtime = "hermes"
vmid = 1234

[source]
kind = "config"
path = "cfg"

[[secrets]]
env = "OPENROUTER_API_KEY"
handle = "other/openrouter"
hosts = ["api.openai.com"]

[egress]
allow = ["openrouter.ai"]

[placement]
substrate = "local"
node = "pve-node-c"
"#,
    )
    .unwrap();
    let spec = spec.to_str().unwrap();
    for verb in ["validate", "plan", "apply"] {
        let run = fabric.agent(&[verb, spec]);
        assert_eq!(run.code, 1);
        assert_eq!(run.envelope["error"]["code"], "spec_invalid");
        let fields: Vec<&str> = run.envelope["error"]["details"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["field"].as_str().unwrap())
            .collect();
        for field in ["name", "tenant_id", "vmid", "placement.node", "secrets[0].hosts"] {
            assert!(fields.contains(&field), "missing {field} in {fields:?}");
        }
        assert!(run.envelope["next"][0].as_str().unwrap().contains("monolith agent validate"));
    }
    assert!(!fabric.state_root.exists(), "a bad spec must not touch the substrate");

    // A handle from another tenant is refused even when every other field is right.
    let cross = fabric.hermes_spec("cross.toml", "e2e-cross", "demo", "acme/openrouter");
    let run = fabric.agent_with(
        &["apply", cross.to_str().unwrap()],
        &[("MONOLITH_SECRET_ACME__OPENROUTER", REAL_SECRET)],
    );
    assert_eq!(run.envelope["error"]["code"], "spec_invalid");
    assert!(run.envelope["error"]["message"].as_str().unwrap().contains("acme"));

    // A handle that does not resolve fails before spawn.
    let unresolved = fabric.hermes_spec("unresolved.toml", "e2e-unres", "nosecret", "nosecret/openrouter");
    let run = fabric.agent(&["apply", unresolved.to_str().unwrap()]);
    assert_eq!(run.envelope["error"]["code"], "spec_invalid");
    assert!(run.envelope["error"]["message"].as_str().unwrap().contains("nosecret/openrouter"));
    assert!(!fabric.state_root.exists());

    // Usage errors have their own code and exit status.
    let run = fabric.agent(&["apply"]);
    assert_eq!((run.code, run.envelope["error"]["code"].as_str()), (2, Some("usage")));
    let run = fabric.agent(&["status", "nobody"]);
    assert_eq!(run.envelope["error"]["code"], "agent_not_found");
}

#[test]
fn an_agent_name_cannot_be_taken_over_by_another_tenant() {
    let fabric = Fabric::new("tenant-conflict");
    let spec = fabric.hermes_spec("demo.toml", "e2e-shared", "demo", "demo/openrouter");
    ok(&fabric.agent(&["apply", spec.to_str().unwrap()]));
    let other = fabric.hermes_spec("acme.toml", "e2e-shared", "acme", "acme/openrouter");
    let run = fabric.agent_with(
        &["apply", other.to_str().unwrap()],
        &[("MONOLITH_SECRET_ACME__OPENROUTER", REAL_SECRET)],
    );
    assert_eq!(run.envelope["error"]["code"], "tenant_conflict");
    assert_eq!(ok(&fabric.agent(&["status", "e2e-shared"]))["tenant_id"], "demo");
}

#[test]
fn a_proxmox_placement_without_its_token_is_refused_plainly() {
    let fabric = Fabric::new("proxmox-no-token");
    let targets = fabric.dir.join("targets.toml");
    fs::write(
        &targets,
        r#"
schema_version = 1
default_target = "local"

[[targets]]
kind = "proxmox"
name = "lab"
api_url = "https://pve-node-b:8006/api2/json"
token_env = "MONOLITH_E2E_FABRIC_ABSENT_TOKEN"
cluster = "homelab"
node = "pve-node-b"
guest_type = "lxc"
guest_id = 203
"#,
    )
    .unwrap();
    let spec = fabric.hermes_spec("lab.toml", "e2e-lab", "demo", "demo/openrouter");
    let text = fs::read_to_string(&spec)
        .unwrap()
        .replace("substrate = \"local\"", "substrate = \"lab\"");
    fs::write(&spec, text).unwrap();
    let run = fabric.agent(&[
        "apply",
        spec.to_str().unwrap(),
        "--targets-config",
        targets.to_str().unwrap(),
    ]);
    assert_eq!(run.envelope["error"]["code"], "target_unavailable", "{:#}", run.envelope);
    assert!(run.envelope["error"]["message"]
        .as_str()
        .unwrap()
        .contains("MONOLITH_E2E_FABRIC_ABSENT_TOKEN is not set"));
    assert!(run.envelope["next"][0]
        .as_str()
        .unwrap()
        .starts_with("export MONOLITH_E2E_FABRIC_ABSENT_TOKEN="));
    assert!(!fabric.state_root.join("e2e-lab").exists());
}

#[test]
fn hermes_and_eve_run_from_one_build_and_one_spec_format() {
    // AE2, local mode: both runtimes accept a first task from this binary.
    let fabric = Fabric::new("two-runtimes");
    let hermes = fabric.hermes_spec("hermes.toml", "e2e-ae2-hermes", "demo", "demo/openrouter");
    let eve = fabric.eve_spec("eve.toml", "e2e-ae2-eve");
    let mut tasks = Vec::new();
    for spec in [&hermes, &eve] {
        let run = fabric.agent(&["apply", spec.to_str().unwrap()]);
        let result = ok(&run);
        assert!(result["ready_ms"].as_u64().is_some());
        tasks.push(result["first_task_id"].as_str().unwrap().to_owned());
    }
    assert!(tasks[0].starts_with("run_"), "Hermes run id: {}", tasks[0]);
    assert!(!tasks[1].is_empty(), "eve session id");
    let listed = fabric.agent(&["list"]);
    let runtimes: Vec<&str> = ok(&listed)
        .as_array()
        .unwrap()
        .iter()
        .map(|agent| agent["runtime"].as_str().unwrap())
        .collect();
    assert_eq!(runtimes, vec!["eve", "hermes"]);

    // An unchanged eve spec is a no-op too (AE5): no checkout, build or restart.
    let again = fabric.agent(&["apply", eve.to_str().unwrap()]);
    assert_eq!(again.envelope["changed"], false);
}

#[test]
fn an_eve_agent_whose_channel_admits_anyone_is_not_committed() {
    // The runtime-state check: the eve channel must refuse callers without
    // the control bearer. Publish a variant whose channel falls back to open
    // access, and apply must fail with runtime_state_invalid and leave nothing.
    let fabric = Fabric::new("eve-open-channel");
    let spec = fabric.eve_spec("eve.toml", "e2e-open-eve");
    let repo_dir = fabric.dir.join("e2e-open-eve.git");
    fs::write(
        repo_dir.join("agent/channels/eve.ts"),
        "import { eveChannel } from \"eve/channels/eve\";\n\
         export default eveChannel({ auth: [() => ({ attributes: {}, authenticator: \"open\", principalId: \"anyone\", principalType: \"service\" })] });\n",
    )
    .unwrap();
    let git = |args: &[&str]| {
        let status = Command::new("git")
            .args(args)
            .current_dir(&repo_dir)
            .env("GIT_AUTHOR_NAME", "e2e")
            .env("GIT_AUTHOR_EMAIL", "e2e@monolith.invalid")
            .env("GIT_COMMITTER_NAME", "e2e")
            .env("GIT_COMMITTER_EMAIL", "e2e@monolith.invalid")
            .output()
            .unwrap();
        assert!(status.status.success(), "{}", String::from_utf8_lossy(&status.stderr));
        String::from_utf8_lossy(&status.stdout).trim().to_owned()
    };
    git(&["-c", "commit.gpgsign=false", "commit", "--quiet", "-am", "open channel"]);
    let rev = git(&["rev-parse", "HEAD"]);
    let text = fs::read_to_string(&spec).unwrap();
    let start = text.find("rev = \"").unwrap() + 7;
    let text = format!("{}{}{}", &text[..start], rev, &text[start + 40..]);
    fs::write(&spec, text).unwrap();

    let run = fabric.agent(&["apply", spec.to_str().unwrap()]);
    assert_eq!(run.envelope["error"]["code"], "runtime_state_invalid", "{:#}", run.envelope);
    assert!(run.envelope["error"]["message"].as_str().unwrap().contains("unauthenticated"));
    // Rolled back: no record, no remains, and the started runtime is gone.
    let status = fabric.agent(&["status", "e2e-open-eve"]);
    assert_eq!(status.envelope["error"]["code"], "agent_not_found");
    let journal = fabric.journal("e2e-open-eve");
    let events: Vec<&str> = journal.iter().map(|e| e["event"].as_str().unwrap()).collect();
    assert!(events.ends_with(&["cleared", "rollback"]), "{events:?}");
    let started: Vec<u64> = journal
        .iter()
        .filter(|e| e["event"] == "created")
        .filter_map(|e| e["resource"]["process"]["pid"].as_u64())
        .collect();
    assert_eq!(started.len(), 2, "runtime and proxy");
    assert!(started.iter().all(|p| wait_dead(*p)), "rollback must stop the runtime and its proxy");
}

#[test]
fn no_code_outside_src_runtimes_names_a_runtime() {
    // A third runtime is added by a file in src/runtimes/ and one entry in
    // ADAPTERS. Anything else naming a runtime would break that property.
    let runtimes: Vec<String> = fs::read_dir(repo().join("src/runtimes"))
        .unwrap()
        .filter_map(|entry| {
            let path = entry.unwrap().path();
            let stem = path.file_stem()?.to_string_lossy().into_owned();
            (stem != "mod").then_some(stem)
        })
        .collect();
    assert!(runtimes.contains(&"hermes".to_owned()) && runtimes.contains(&"eve".to_owned()));
    let mut offenders = Vec::new();
    let mut stack = vec![repo().join("src")];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.ends_with("runtimes") {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let text = fs::read_to_string(&path).unwrap();
            for (number, line) in text.lines().enumerate() {
                let code = line.split("//").next().unwrap_or_default();
                for runtime in &runtimes {
                    let quoted = format!("\"{runtime}\"");
                    let path_ref = format!("{runtime}::");
                    if code.contains(&quoted) || code.contains(&path_ref) {
                        offenders.push(format!("{}:{}: {}", path.display(), number + 1, line.trim()));
                    }
                }
            }
        }
    }
    assert!(offenders.is_empty(), "runtime named outside src/runtimes/: {offenders:#?}");
}

// ---------------------------------------------------------------------------
// Credential boundary (U7). The upstream below is a test peer standing in for
// a model API on this host's loopback, so the suite can see exactly what
// leaves the proxy. It is not a substrate: the agent, its proxy and its
// confinement are the real ones.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Recorded {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
}

impl Recorded {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// An OpenAI-compatible HTTP endpoint on 127.0.0.1 that records every
/// request it receives and answers chat completions with "ok".
struct Upstream {
    port: u16,
    server: std::sync::Arc<tiny_http::Server>,
    requests: std::sync::Arc<std::sync::Mutex<Vec<Recorded>>>,
}

impl Upstream {
    fn start() -> Self {
        let server = std::sync::Arc::new(tiny_http::Server::http("127.0.0.1:0").unwrap());
        let port = server.server_addr().to_ip().unwrap().port();
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let (srv, log) = (server.clone(), requests.clone());
        std::thread::spawn(move || {
            for mut request in srv.incoming_requests() {
                let mut body = String::new();
                let _ = std::io::Read::read_to_string(request.as_reader(), &mut body);
                let recorded = Recorded {
                    method: request.method().to_string(),
                    path: request.url().to_owned(),
                    headers: request
                        .headers()
                        .iter()
                        .map(|h| (h.field.to_string(), h.value.to_string()))
                        .collect(),
                };
                log.lock().unwrap().push(recorded.clone());
                let json = |text: String| {
                    tiny_http::Response::from_string(text).with_header(
                        "Content-Type: application/json".parse::<tiny_http::Header>().unwrap(),
                    )
                };
                let response = if recorded.path.ends_with("/models") {
                    json(r#"{"object":"list","data":[{"id":"e2e-model","object":"model","owned_by":"e2e"}]}"#.to_owned())
                } else if recorded.path.ends_with("/chat/completions") {
                    let stream = serde_json::from_str::<Value>(&body)
                        .map(|v| v["stream"] == true)
                        .unwrap_or(false);
                    if stream {
                        let chunk = |delta: Value, finish: Value| {
                            format!(
                                "data: {}\n\n",
                                serde_json::json!({"id":"chatcmpl-e2e","object":"chat.completion.chunk","created":0,"model":"e2e-model",
                                    "choices":[{"index":0,"delta":delta,"finish_reason":finish}]})
                            )
                        };
                        let text = format!(
                            "{}{}data: [DONE]\n\n",
                            chunk(serde_json::json!({"role":"assistant","content":"ok"}), Value::Null),
                            chunk(serde_json::json!({}), Value::from("stop"))
                        );
                        tiny_http::Response::from_string(text).with_header(
                            "Content-Type: text/event-stream".parse::<tiny_http::Header>().unwrap(),
                        )
                    } else {
                        json(serde_json::json!({"id":"chatcmpl-e2e","object":"chat.completion","created":0,"model":"e2e-model",
                            "choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],
                            "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}).to_string())
                    }
                } else {
                    json("{}".to_owned())
                };
                let _ = request.respond(response);
            }
        });
        Self { port, server, requests }
    }

    fn recorded(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }

    fn wait_for(&self, what: &str, pred: impl Fn(&Recorded) -> bool) -> Recorded {
        for _ in 0..1200 {
            if let Some(found) = self.recorded().into_iter().find(|r| pred(r)) {
                return found;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        panic!("the upstream never received {what}; it saw {:#?}", self.recorded());
    }
}

impl Drop for Upstream {
    fn drop(&mut self) {
        self.server.unblock();
    }
}

/// The agent's environment as the OS reports it.
fn environ(pid: u64) -> String {
    let output = Command::new("ps")
        .args(["eww", "-o", "command=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn env_value(environ: &str, key: &str) -> String {
    let marker = format!(" {key}=");
    let start = environ.find(&marker).unwrap_or_else(|| panic!("{key} not in {environ}")) + marker.len();
    environ[start..].split_whitespace().next().unwrap().to_owned()
}

/// The proxy listener the agent's sandbox admits.
fn proxy_port(generation: &Path) -> u16 {
    let profile = fs::read_to_string(generation.join("sandbox.sb")).unwrap();
    let start = profile.find("localhost:").unwrap() + "localhost:".len();
    profile[start..].split('"').next().unwrap().parse().unwrap()
}

/// Run a command from the agent's position: under the agent's own sandbox
/// profile, as written by the local driver.
fn as_agent(generation: &Path, program: &str, args: &[&str]) -> (i32, String) {
    let output = Command::new("/usr/bin/sandbox-exec")
        .arg("-f")
        .arg(generation.join("sandbox.sb"))
        .arg(program)
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .output()
        .unwrap();
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    (output.status.code().unwrap_or(-1), text)
}

/// curl from inside the agent's sandbox, through its proxy unless
/// `direct`. Returns (exit code, HTTP status or "000").
fn agent_curl(generation: &Path, url: &str, headers: &[String], direct: bool) -> (i32, String) {
    let proxy = format!("http://127.0.0.1:{}", proxy_port(generation));
    let mut args = vec!["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10"];
    if direct {
        args.extend(["--noproxy", "*"]);
    } else {
        args.extend(["-x", &proxy]);
    }
    for header in headers {
        args.extend(["-H", header.as_str()]);
    }
    args.push(url);
    let (code, text) = as_agent(generation, "/usr/bin/curl", &args);
    (code, text.chars().take(3).collect())
}

fn files_under(dir: &Path, skip: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path == skip {
            continue;
        }
        if path.is_dir() {
            files_under(&path, skip, out);
        } else {
            out.push(path);
        }
    }
}

const UPSTREAM_SECRET: &str = "upstream-real-credential-7f3a9c";
const OTHER_SECRET: &str = "other-real-credential-41d2e8";
const ROTATED_SECRET: &str = "upstream-rotated-credential-b5e1aa";

#[cfg(target_os = "macos")]
#[test]
fn the_agent_holds_placeholders_and_only_its_proxy_sends_real_credentials() {
    let upstream = Upstream::start();
    let mut fabric = Fabric::new("credential-boundary").with_targets(
        r#"
schema_version = 1
default_target = "local"

# Agents on this target may reach a service on this host's loopback through
# their proxy; cloud metadata stays denied.
[[targets]]
kind = "local"
name = "loopback"
upstream_deny_cidrs = ["169.254.169.254/32"]
"#,
    );
    fabric.env.insert("MONOLITH_SECRET_DEMO__UPSTREAM".to_owned(), UPSTREAM_SECRET.to_owned());
    fabric.env.insert("MONOLITH_SECRET_DEMO__OTHER".to_owned(), OTHER_SECRET.to_owned());
    let config = fabric.dir.join("e2e-ae3-config");
    copy_dir(&repo().join("examples/hermes-agent"), &config);
    fs::write(
        config.join("config.yaml"),
        format!(
            "model:\n  default: e2e-model\n  provider: custom:upstream\n\
             providers:\n  upstream:\n    base_url: http://127.0.0.1:{}/v1\n    key_env: UPSTREAM_API_KEY\n    default_model: e2e-model\n\
             platform_toolsets:\n  api_server: [web, file, memory, todo]\n",
            upstream.port
        ),
    )
    .unwrap();
    let spec = fabric.dir.join("ae3.toml");
    fs::write(
        &spec,
        r#"schema_version = 1
name = "e2e-ae3"
tenant_id = "demo"
runtime = "hermes"

[source]
kind = "config"
path = "e2e-ae3-config"

[[secrets]]
env = "UPSTREAM_API_KEY"
handle = "demo/upstream"
hosts = ["127.0.0.1"]

[[secrets]]
env = "OTHER_TOKEN"
handle = "demo/other"
hosts = ["localhost"]

[egress]
allow = ["127.0.0.1", "localhost"]

[placement]
substrate = "loopback"
"#,
    )
    .unwrap();
    let spec = spec.to_str().unwrap();
    let applied = fabric.agent(&["apply", spec]);
    let result = ok(&applied).clone();
    let pid = pid_of(&result["resources"], "agent_process");
    let all = pids(&result["resources"]);
    let endpoint = result["endpoint"].as_str().unwrap().to_owned();
    let agent_dir = fabric.state_root.join("e2e-ae3");
    let generation = fs::canonicalize(agent_dir.join("gen-1")).unwrap();

    // The agent's environment holds placeholders, never a real value.
    let env = environ(pid);
    let placeholder = env_value(&env, "UPSTREAM_API_KEY");
    let other_placeholder = env_value(&env, "OTHER_TOKEN");
    assert!(placeholder.starts_with("monolith-placeholder-"), "{placeholder}");
    for real in [UPSTREAM_SECRET, OTHER_SECRET] {
        assert!(!env.contains(real), "a real secret reached the agent's environment");
    }
    assert!(env.contains(&format!("HTTPS_PROXY=http://127.0.0.1:{}", proxy_port(&generation))));
    // ...and so do the files it can read: its generation, minus the proxy's
    // directory, which the next block shows it cannot read.
    let mut files = Vec::new();
    files_under(&generation, &generation.join("proxy"), &mut files);
    for file in &files {
        let bytes = fs::read(file).unwrap_or_default();
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            !text.contains(UPSTREAM_SECRET) && !text.contains(OTHER_SECRET),
            "{} holds a real secret",
            file.display()
        );
    }

    // The agent cannot read the proxy's secrets, CA key, config or audit log.
    let protected = [
        generation.join("proxy/secrets/UPSTREAM_API_KEY.secret"),
        generation.join("proxy/ca.key"),
        generation.join("proxy/iron-proxy.yaml"),
        generation.join("proxy/management.key"),
        fs::canonicalize(agent_dir.join("logs/egress-audit.jsonl")).unwrap(),
        fs::canonicalize(agent_dir.join("control.key")).unwrap(),
    ];
    for path in &protected {
        let (code, text) = as_agent(&generation, "/bin/cat", &[path.to_str().unwrap()]);
        assert_ne!(code, 0, "the agent read {}", path.display());
        assert!(text.contains("Operation not permitted"), "{text}");
    }
    let (code, text) = as_agent(&generation, "/bin/cat", &[generation.join("trust/monolith-agent-ca.pem").to_str().unwrap()]);
    assert_eq!(code, 0, "the agent must be able to read the CA it trusts: {text}");

    // AE3: a task the agent runs calls the model; the request that leaves
    // the proxy carries the real credential.
    let control_key = fs::read_to_string(agent_dir.join("control.key")).unwrap();
    let run = ureq::post(format!("{endpoint}/v1/runs"))
        .header("Authorization", format!("Bearer {}", control_key.trim()))
        .send_json(serde_json::json!({"input": "Reply with the single word: ok"}))
        .unwrap();
    assert_eq!(run.status().as_u16(), 202);
    let call = upstream.wait_for("a chat completion from the agent", |r| {
        r.method == "POST" && r.path.ends_with("/chat/completions")
    });
    assert_eq!(call.header("Authorization"), Some(format!("Bearer {UPSTREAM_SECRET}").as_str()));
    for request in upstream.recorded() {
        for (_, value) in &request.headers {
            assert!(!value.contains(&placeholder), "a placeholder left the proxy: {request:?}");
        }
    }

    // A placeholder sent to an allowed host its secret is not bound to stays
    // a placeholder; sent to its bound host, it becomes the real value.
    let marker = |tag: &str| format!("/boundary-{tag}");
    let header = format!("X-Other-Token: {other_placeholder}");
    let (code, status) = agent_curl(&generation, &format!("http://127.0.0.1:{}{}", upstream.port, marker("unbound")), &[header.clone()], false);
    assert_eq!((code, status.as_str()), (0, "200"));
    let seen = upstream.wait_for("the unbound request", |r| r.path == marker("unbound"));
    assert_eq!(seen.header("X-Other-Token"), Some(other_placeholder.as_str()));
    let (code, status) = agent_curl(&generation, &format!("http://localhost:{}{}", upstream.port, marker("bound")), &[header], false);
    assert_eq!((code, status.as_str()), (0, "200"));
    let seen = upstream.wait_for("the bound request", |r| r.path == marker("bound"));
    assert_eq!(seen.header("X-Other-Token"), Some(OTHER_SECRET));

    // A host outside the allowlist is refused and the refusal is audited.
    let (_, status) = agent_curl(&generation, "http://not-allowed.example/exfiltrate", &[], false);
    assert_eq!(status, "403");
    let (_, status) = agent_curl(&generation, "https://not-allowed.example/exfiltrate", &[], false);
    assert_eq!(status, "000", "CONNECT to a host outside the allowlist must fail");
    let egress = fabric.agent(&["logs", "e2e-ae3", "--stream", "egress"]);
    let audit: Vec<Value> = ok(&egress)["text"]
        .as_str()
        .unwrap()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .filter(|line: &Value| line["msg"] == "request")
        .collect();
    let refused: Vec<&Value> = audit
        .iter()
        .filter(|r| r["audit"]["host"].as_str().unwrap_or("").starts_with("not-allowed.example"))
        .collect();
    assert_eq!(refused.len(), 2, "{audit:#?}");
    assert!(refused.iter().all(|r| r["rejected_by"] == "allowlist" && r["audit"]["status_code"] == 403));
    assert!(audit.iter().any(|r| r["audit"]["path"] == "/v1/chat/completions" && r["audit"]["action"] == "allow"));
    let text = ok(&egress)["text"].as_str().unwrap().to_owned();
    assert!(!text.contains(UPSTREAM_SECRET) && !text.contains(OTHER_SECRET), "the audit log holds a real secret");

    // A client that ignores the proxy cannot connect at all.
    let (code, status) = agent_curl(&generation, &format!("http://127.0.0.1:{}{}", upstream.port, marker("direct")), &[], true);
    assert_eq!((code, status.as_str()), (7, "000"), "a direct connection must fail at the network layer");
    assert!(!upstream.recorded().iter().any(|r| r.path == marker("direct")));

    // The per-agent CA: critical CA with pathlen 0, signing-only key usage,
    // name constraints limited to the allowlist.
    let pem = fs::read(generation.join("trust/monolith-agent-ca.pem")).unwrap();
    let (_, block) = x509_parser::pem::parse_x509_pem(&pem).unwrap();
    let cert = block.parse_x509().unwrap();
    let bc = cert.basic_constraints().unwrap().unwrap();
    assert!(bc.critical && bc.value.ca && bc.value.path_len_constraint == Some(0));
    let ku = cert.key_usage().unwrap().unwrap();
    assert!(ku.critical && ku.value.key_cert_sign() && ku.value.crl_sign() && !ku.value.digital_signature());
    let nc = cert.name_constraints().unwrap().unwrap();
    let permitted: Vec<String> = nc
        .value
        .permitted_subtrees
        .as_ref()
        .unwrap()
        .iter()
        .map(|s| format!("{:?}", s.base))
        .collect();
    assert_eq!(permitted.len(), 2, "{permitted:?}");
    assert!(permitted.iter().any(|p| p.contains("localhost")), "{permitted:?}");

    // Rotation: a new value takes effect through reload, without a restart,
    // and the live proxy sends it.
    let rotated = fabric.agent_with(&["apply", spec], &[("MONOLITH_SECRET_DEMO__UPSTREAM", ROTATED_SECRET)]);
    let result = ok(&rotated);
    assert_eq!(rotated.envelope["changed"], true);
    assert!(result["rotated"].as_array().unwrap().iter().any(|v| v == "UPSTREAM_API_KEY"));
    assert_eq!(result["generation"], 1);
    assert_eq!(pids(&result["resources"]), all, "rotation must not restart anything");
    assert!(all.iter().all(|p| pid_alive(*p)));
    let (code, status) = agent_curl(
        &generation,
        &format!("http://127.0.0.1:{}{}", upstream.port, marker("rotated")),
        &[format!("Authorization: Bearer {placeholder}")],
        false,
    );
    assert_eq!((code, status.as_str()), (0, "200"));
    let seen = upstream.wait_for("the post-rotation request", |r| r.path == marker("rotated"));
    assert_eq!(seen.header("Authorization"), Some(format!("Bearer {ROTATED_SECRET}").as_str()));
    let again = fabric.agent_with(&["apply", spec], &[("MONOLITH_SECRET_DEMO__UPSTREAM", ROTATED_SECRET)]);
    assert_eq!(again.envelope["changed"], false);
    assert!(ok(&again)["rotated"].as_array().unwrap().is_empty());
    assert!(fabric
        .journal("e2e-ae3")
        .iter()
        .any(|e| e["event"] == "secrets_rotated"));
}

#[cfg(target_os = "macos")]
#[test]
fn agents_of_two_tenants_cannot_reach_each_other_or_read_each_others_secrets() {
    // AE4 in local mode. The live cluster version runs in e2e_proxmox.
    const ACME_SECRET: &str = "sk-or-v1-acme-real-value-fedcba9876543210";
    let mut fabric = Fabric::new("tenant-isolation");
    fabric.env.insert("MONOLITH_SECRET_ACME__OPENROUTER".to_owned(), ACME_SECRET.to_owned());
    let demo = fabric.hermes_spec("demo.toml", "e2e-iso-demo", "demo", "demo/openrouter");
    let acme = fabric.hermes_spec("acme.toml", "e2e-iso-acme", "acme", "acme/openrouter");
    ok(&fabric.agent(&["apply", demo.to_str().unwrap()]));
    let acme_applied = fabric.agent(&["apply", acme.to_str().unwrap()]);
    let acme_endpoint = ok(&acme_applied)["endpoint"].as_str().unwrap().to_owned();
    let demo_gen = fs::canonicalize(fabric.state_root.join("e2e-iso-demo/gen-1")).unwrap();
    let acme_dir = fs::canonicalize(fabric.state_root.join("e2e-iso-acme")).unwrap();

    // Directly: refused by the network layer.
    let (code, _) = agent_curl(&demo_gen, &format!("{acme_endpoint}/v1/capabilities"), &[], true);
    assert_eq!(code, 7, "demo's agent connected straight to acme's agent");
    // Through demo's proxy: refused by the allowlist, and recorded.
    let (_, status) = agent_curl(&demo_gen, &format!("{acme_endpoint}/v1/capabilities"), &[], false);
    assert_eq!(status, "403");
    let egress = fabric.agent(&["logs", "e2e-iso-demo", "--stream", "egress"]);
    let acme_host = acme_endpoint.trim_start_matches("http://").to_owned();
    let recorded = ok(&egress)["text"]
        .as_str()
        .unwrap()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .any(|r| r["audit"]["host"] == acme_host.as_str() && r["rejected_by"] == "allowlist");
    assert!(recorded, "the refused attempt must be in demo's audit log");

    // Acme's secret, control key and record are unreadable from demo's agent.
    for path in [
        acme_dir.join("gen-1/proxy/secrets/OPENROUTER_API_KEY.secret"),
        acme_dir.join("control.key"),
        acme_dir.join("agent.json"),
        acme_dir.join("logs/agent.log"),
    ] {
        let (code, text) = as_agent(&demo_gen, "/bin/cat", &[path.to_str().unwrap()]);
        assert_ne!(code, 0, "demo's agent read {}", path.display());
        assert!(!text.contains(ACME_SECRET));
    }
    let demo_pid = pid_of(&ok(&fabric.agent(&["status", "e2e-iso-demo"]))["resources"], "agent_process");
    assert!(!environ(demo_pid).contains(ACME_SECRET));
}
