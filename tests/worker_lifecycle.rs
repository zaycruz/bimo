//! Worker lifecycle and crash-injection tests (plan U5).
//!
//! These tests drive the real `monolith` binary against a temporary state
//! directory and inspect durable state through the library API. The fixture
//! worker supports one-shot crash injection: a JSON file at
//! `MONOLITH_CRASH_FILE` names a crash point, the worker consumes the file at
//! startup, and the crash fires on the first delivery. A restart therefore
//! replays without crashing again.

use monolith::runtime::process_is_alive;
use monolith::state::{self, PodStatus};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

fn monolith() -> &'static str {
    env!("CARGO_BIN_EXE_monolith")
}

fn run_with_env(args: &[&str], envs: &[(&str, &str)]) -> (bool, String) {
    let mut cmd = Command::new(monolith());
    cmd.args(args);
    for (key, value) in envs {
        cmd.env(key, value);
    }
    let out = cmd.output().expect("failed to run monolith");
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    (out.status.success(), text)
}

fn run(args: &[&str]) -> (bool, String) {
    run_with_env(args, &[])
}

fn run_ok(args: &[&str]) -> String {
    let (ok, text) = run(args);
    assert!(ok, "command failed: monolith {}\n{text}", args.join(" "));
    text
}

struct TestDir(PathBuf);
impl TestDir {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "monolith-lifecycle-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_factory(
    dir: &Path,
    worker_engine: &str,
    worker_script: &str,
    worker_caps: &[&str],
    worker_dests: &[&str],
    crash_env: bool,
) -> PathBuf {
    let caps = worker_caps
        .iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let dests = worker_dests
        .iter()
        .map(|d| format!("\"{d}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let mut envs = vec!["\"PATH\"".to_owned()];
    if crash_env {
        envs.push("\"MONOLITH_CRASH_FILE\"".to_owned());
        envs.push("\"MONOLITH_VARY_MARKER\"".to_owned());
    }
    let env_line = format!("allowed_env = [{}]", envs.join(", "));
    let caps_line = if caps.is_empty() {
        String::new()
    } else {
        format!("capabilities = [{caps}]\n")
    };
    let dests_line = if dests.is_empty() {
        String::new()
    } else {
        format!("destinations = [{dests}]\n")
    };
    let manifest = format!(
        "name = \"lifecycle-test\"\ntrusted_executable_roots = [\"/usr/bin\"]\n\
         [[pods]]\nname = \"planner\"\nrole = \"planner\"\nengine = \"fixture\"\n\
         command = [\"/usr/bin/env\", \"node\", \"workers/fixture/fixture-worker.mjs\"]\n\
         allowed_env = [\"PATH\"]\n\n\
         [[pods]]\nname = \"worker\"\nrole = \"worker\"\nengine = \"{worker_engine}\"\n\
         command = [\"/usr/bin/env\", \"node\", \"{worker_script}\"]\n\
         {env_line}\n{caps_line}{dests_line}"
    );
    let path = dir.join("factory.toml");
    fs::write(&path, manifest).unwrap();
    path
}

fn write_crash_file(dir: &Path, point: &str) -> PathBuf {
    let path = dir.join("crash.json");
    fs::write(&path, format!("{{\"point\":\"{point}\"}}")).unwrap();
    path
}

fn wait_until<F: FnMut() -> bool>(what: &str, mut f: F) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if f() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    panic!("timed out waiting for {what}");
}

fn pod_status(dir: &Path, pod: &str) -> Option<PodStatus> {
    // The status command refreshes observed state: a pod-process that exited
    // without writing a terminal failure (e.g. a malformed frame) is only
    // marked Failed when observed.
    let _ = run(&["status", dir.to_str().unwrap()]);
    state::read_state(dir)
        .ok()
        .flatten()
        .and_then(|s| s.pods.get(pod).map(|p| p.status.clone()))
}

fn wait_for_terminal(dir: &Path, message_id: &str) {
    // The terminal file is written before the delivery is marked processed, so
    // wait for both to avoid a race between the two durable writes.
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if terminal_path(dir, message_id).exists()
            && state::is_processed(dir, "worker", message_id).unwrap_or(false)
        {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = run(&["status", dir.to_str().unwrap()]);
    if let Ok(Some(s)) = state::read_state(dir) {
        eprintln!("DIAG state: {s:?}");
    }
    if let Ok(log) = fs::read_to_string(dir.join("logs").join("worker.log")) {
        eprintln!("DIAG worker log:\n{log}");
    }
    panic!("timed out waiting for terminal to persist and delivery to be processed");
}

fn terminal_path(dir: &Path, message_id: &str) -> PathBuf {
    dir.join("terminals").join(format!("{message_id}.json"))
}

fn worker_message_id(dir: &Path) -> String {
    let pending = state::pending_message_ids(dir, "worker").unwrap();
    assert_eq!(
        pending.len(),
        1,
        "expected exactly one pending worker message"
    );
    pending[0].clone()
}

#[test]
fn before_hello_crash_fails_apply_cleanly() {
    let dir = TestDir::new("before-hello");
    let manifest = write_factory(
        dir.path(),
        "fixture",
        "workers/fixture/fixture-worker.mjs",
        &[],
        &[],
        true,
    );
    let crash = write_crash_file(dir.path(), "before_hello");
    let (ok, text) = run_with_env(
        &[
            "apply",
            manifest.to_str().unwrap(),
            "--state-dir",
            dir.path().to_str().unwrap(),
        ],
        &[("MONOLITH_CRASH_FILE", crash.to_str().unwrap())],
    );
    assert!(
        !ok,
        "apply must fail when the worker exits before hello: {text}"
    );
    assert!(
        text.contains("exited before handshake"),
        "unexpected failure text: {text}"
    );
    assert!(
        !dir.path().join("factory_state.json").exists(),
        "no partial state may be committed"
    );
}

#[test]
fn crash_after_work_receipt_replays_without_duplicate() {
    let dir = TestDir::new("after-work");
    let manifest = write_factory(
        dir.path(),
        "fixture",
        "workers/fixture/fixture-worker.mjs",
        &[],
        &[],
        true,
    );
    let crash = write_crash_file(dir.path(), "after_work_receipt");
    let state = dir.path().to_str().unwrap();
    let m = manifest.to_str().unwrap();
    let (ok, text) = run_with_env(
        &["apply", m, "--state-dir", state],
        &[("MONOLITH_CRASH_FILE", crash.to_str().unwrap())],
    );
    assert!(ok, "apply failed: {text}");
    run_ok(&[
        "send",
        state,
        "--from",
        "planner",
        "--to",
        "worker",
        "--kind",
        "work.requested",
        "--payload",
        "{\"task\":\"crash\"}",
    ]);
    let message_id = worker_message_id(dir.path());
    wait_until("worker pod to fail", || {
        pod_status(dir.path(), "worker") == Some(PodStatus::Failed)
    });
    assert!(
        !state::is_processed(dir.path(), "worker", &message_id).unwrap(),
        "message must stay pending after the crash"
    );
    // Re-apply replays the durable delivery; the crash file is consumed, so
    // the replacement worker completes the turn.
    run_ok(&["apply", m, "--state-dir", state]);
    wait_for_terminal(dir.path(), &message_id);
    run_ok(&["destroy", state]);
}

#[test]
fn crash_after_tool_result_does_not_duplicate_effect() {
    let dir = TestDir::new("after-tool");
    let manifest = write_factory(
        dir.path(),
        "fixture",
        "workers/fixture/fixture-worker.mjs",
        &["pod.send_message"],
        &["planner"],
        true,
    );
    let crash = write_crash_file(dir.path(), "after_tool_result");
    let state = dir.path().to_str().unwrap();
    let m = manifest.to_str().unwrap();
    let (ok, text) = run_with_env(
        &["apply", m, "--state-dir", state],
        &[("MONOLITH_CRASH_FILE", crash.to_str().unwrap())],
    );
    assert!(ok, "apply failed: {text}");
    run_ok(&[
        "send",
        state,
        "--from",
        "planner",
        "--to",
        "worker",
        "--kind",
        "work.requested",
        "--payload",
        "{\"task\":\"effect\"}",
    ]);
    let message_id = worker_message_id(dir.path());
    wait_until("worker pod to fail", || {
        pod_status(dir.path(), "worker") == Some(PodStatus::Failed)
    });
    // The capability effect was applied before the crash: exactly one effect
    // message must already sit in the planner inbox.
    let effects = |dir: &Path| -> Vec<String> {
        state::pending_message_ids(dir, "planner")
            .unwrap()
            .into_iter()
            .filter(|id| id.starts_with("effect-"))
            .collect()
    };
    assert_eq!(
        effects(dir.path()).len(),
        1,
        "effect must be applied once before the crash"
    );
    // Re-apply replays the delivery. The deterministic effect key must prevent
    // a second insertion.
    run_ok(&["apply", m, "--state-dir", state]);
    wait_for_terminal(dir.path(), &message_id);
    assert_eq!(
        effects(dir.path()).len(),
        1,
        "replay must not duplicate the effect"
    );
    run_ok(&["destroy", state]);
}

#[test]
fn terminal_replay_with_different_output_converges() {
    // A crash between terminal persist and mark_processed leaves an immutable
    // terminal with the delivery still pending. A non-deterministic worker
    // produces DIFFERENT output on replay; the first durable terminal must win
    // and the delivery must complete instead of failing forever (AGENTOPS-134).
    let dir = TestDir::new("terminal-replay");
    let manifest = write_factory(
        dir.path(),
        "fixture",
        "workers/fixture/fixture-worker.mjs",
        &[],
        &[],
        false,
    );
    let state = dir.path().to_str().unwrap();
    let m = manifest.to_str().unwrap();
    run_ok(&["apply", m, "--state-dir", state]);
    run_ok(&[
        "send",
        state,
        "--from",
        "planner",
        "--to",
        "worker",
        "--kind",
        "work.requested",
        "--payload",
        "{\"task\":\"replay\"}",
    ]);
    let message_id = worker_message_id(dir.path());
    wait_for_terminal(dir.path(), &message_id);

    // Simulate a non-deterministic worker: the first durable terminal differs
    // from what the fixture produces on replay. Overwrite the immutable
    // terminal file with a different payload, then un-process the delivery so
    // the next apply replays it.
    let terminal = terminal_path(dir.path(), &message_id);
    let mut frame: serde_json::Value =
        serde_json::from_slice(&fs::read(&terminal).unwrap()).unwrap();
    frame["payload"]["output"] = serde_json::json!("first durable terminal");
    fs::write(&terminal, serde_json::to_vec_pretty(&frame).unwrap()).unwrap();
    fs::remove_file(
        dir.path()
            .join("processed")
            .join("worker")
            .join(&message_id),
    )
    .unwrap();

    // Re-apply replays the delivery. The worker produces a different terminal;
    // the persisted (first) terminal must win and the delivery must complete.
    run_ok(&["apply", m, "--state-dir", state]);
    wait_for_terminal(dir.path(), &message_id);
    let persisted: serde_json::Value =
        serde_json::from_slice(&fs::read(&terminal).unwrap()).unwrap();
    assert_eq!(
        persisted["payload"]["output"], "first durable terminal",
        "the first durable terminal must be preserved"
    );
    run_ok(&["destroy", state]);
}

#[test]
fn replay_with_different_tool_call_id_does_not_duplicate_effect() {
    // The effect key must be deterministic across replays even when the worker
    // chooses a DIFFERENT tool_call_id on replay (AGENTOPS-135). The fixture
    // worker's after_tool_result_vary_id point crashes after the tool result on
    // the first run and uses tool-<request>-replay on the replay.
    let dir = TestDir::new("vary-tool-id");
    let manifest = write_factory(
        dir.path(),
        "fixture",
        "workers/fixture/fixture-worker.mjs",
        &["pod.send_message"],
        &["planner"],
        true,
    );
    let crash = write_crash_file(dir.path(), "after_tool_result_vary_id");
    let marker = dir.path().join("vary-marker");
    let state = dir.path().to_str().unwrap();
    let m = manifest.to_str().unwrap();
    let (ok, text) = run_with_env(
        &["apply", m, "--state-dir", state],
        &[
            ("MONOLITH_CRASH_FILE", crash.to_str().unwrap()),
            ("MONOLITH_VARY_MARKER", marker.to_str().unwrap()),
        ],
    );
    assert!(ok, "apply failed: {text}");
    run_ok(&[
        "send",
        state,
        "--from",
        "planner",
        "--to",
        "worker",
        "--kind",
        "work.requested",
        "--payload",
        "{\"task\":\"vary\"}",
    ]);
    let message_id = worker_message_id(dir.path());
    wait_until("worker pod to fail", || {
        pod_status(dir.path(), "worker") == Some(PodStatus::Failed)
    });
    let effects = |dir: &Path| -> Vec<String> {
        state::pending_message_ids(dir, "planner")
            .unwrap()
            .into_iter()
            .filter(|id| id.starts_with("effect-"))
            .collect()
    };
    assert_eq!(
        effects(dir.path()).len(),
        1,
        "effect must be applied once before the crash"
    );
    // Re-apply replays the delivery. The replacement worker uses a DIFFERENT
    // tool_call_id, so the effect key must not depend on the worker-chosen id.
    let (ok, text) = run_with_env(
        &["apply", m, "--state-dir", state],
        &[("MONOLITH_VARY_MARKER", marker.to_str().unwrap())],
    );
    assert!(ok, "re-apply failed: {text}");
    wait_for_terminal(dir.path(), &message_id);
    assert_eq!(
        effects(dir.path()).len(),
        1,
        "replay with a different tool_call_id must not duplicate the effect"
    );
    run_ok(&["destroy", state]);
}

#[test]
fn crash_after_terminal_sent_persists_terminal() {
    let dir = TestDir::new("after-terminal");
    let manifest = write_factory(
        dir.path(),
        "fixture",
        "workers/fixture/fixture-worker.mjs",
        &[],
        &[],
        true,
    );
    let crash = write_crash_file(dir.path(), "after_terminal_sent");
    let state = dir.path().to_str().unwrap();
    let m = manifest.to_str().unwrap();
    let (ok, text) = run_with_env(
        &["apply", m, "--state-dir", state],
        &[("MONOLITH_CRASH_FILE", crash.to_str().unwrap())],
    );
    assert!(ok, "apply failed: {text}");
    run_ok(&[
        "send",
        state,
        "--from",
        "planner",
        "--to",
        "worker",
        "--kind",
        "work.requested",
        "--payload",
        "{\"task\":\"terminal\"}",
    ]);
    let message_id = worker_message_id(dir.path());
    // The terminal frame is flushed before the worker exits, so Rust must
    // persist it and mark the delivery processed.
    wait_for_terminal(dir.path(), &message_id);
    run_ok(&["destroy", state]);
}

#[test]
fn malformed_worker_frame_fails_safely() {
    let dir = TestDir::new("malformed");
    let manifest = write_factory(
        dir.path(),
        "fixture",
        "workers/fixture/fixture-worker.mjs",
        &[],
        &[],
        true,
    );
    let crash = write_crash_file(dir.path(), "malformed");
    let state = dir.path().to_str().unwrap();
    let m = manifest.to_str().unwrap();
    let (ok, text) = run_with_env(
        &["apply", m, "--state-dir", state],
        &[("MONOLITH_CRASH_FILE", crash.to_str().unwrap())],
    );
    assert!(ok, "apply failed: {text}");
    run_ok(&[
        "send",
        state,
        "--from",
        "planner",
        "--to",
        "worker",
        "--kind",
        "work.requested",
        "--payload",
        "{\"task\":\"garbage\"}",
    ]);
    let message_id = worker_message_id(dir.path());
    wait_until("worker pod to fail", || {
        pod_status(dir.path(), "worker") == Some(PodStatus::Failed)
    });
    assert!(
        !terminal_path(dir.path(), &message_id).exists(),
        "no terminal may be persisted for a malformed turn"
    );
    assert!(
        !state::is_processed(dir.path(), "worker", &message_id).unwrap(),
        "message must stay pending after a malformed turn"
    );
    run_ok(&["destroy", state]);
}

#[test]
fn destroy_leaves_no_orphan_processes() {
    let dir = TestDir::new("destroy");
    let manifest = write_factory(
        dir.path(),
        "fixture",
        "workers/fixture/fixture-worker.mjs",
        &[],
        &[],
        false,
    );
    let state = dir.path().to_str().unwrap();
    let m = manifest.to_str().unwrap();
    let apply_out = run_ok(&["apply", m, "--state-dir", state]);
    let pids: Vec<u32> = apply_out
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if !line.starts_with("pod ") {
                return None;
            }
            let pid = line
                .split_whitespace()
                .find_map(|token| token.strip_prefix("pid="))?;
            pid.parse().ok()
        })
        .collect();
    assert_eq!(
        pids.len(),
        2,
        "apply must report both pod pids: {apply_out}"
    );
    run_ok(&[
        "send",
        state,
        "--from",
        "planner",
        "--to",
        "worker",
        "--kind",
        "work.requested",
        "--payload",
        "{\"task\":\"destroy\"}",
    ]);
    let message_id = worker_message_id(dir.path());
    wait_for_terminal(dir.path(), &message_id);
    run_ok(&["destroy", state]);
    for pid in pids {
        assert!(
            !process_is_alive(pid),
            "pod process {pid} must be gone after destroy"
        );
    }
}

#[test]
fn replacement_harness_completes_the_same_contract() {
    let dir = TestDir::new("replacement");
    let manifest = write_factory(
        dir.path(),
        "replacement",
        "workers/replacement/replacement-worker.mjs",
        &[],
        &[],
        false,
    );
    let state = dir.path().to_str().unwrap();
    let m = manifest.to_str().unwrap();
    run_ok(&["apply", m, "--state-dir", state]);
    run_ok(&[
        "send",
        state,
        "--from",
        "planner",
        "--to",
        "worker",
        "--kind",
        "work.requested",
        "--payload",
        "{\"task\":\"replacement\"}",
    ]);
    let message_id = worker_message_id(dir.path());
    wait_for_terminal(dir.path(), &message_id);
    let terminal = fs::read_to_string(terminal_path(dir.path(), &message_id)).unwrap();
    assert!(
        terminal.contains("replacement completed"),
        "terminal must carry the replacement worker output: {terminal}"
    );
    run_ok(&["destroy", state]);
}
