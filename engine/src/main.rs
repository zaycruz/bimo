use monolith::{capabilities, durability, manifest, protocol, runtime, state, validation};

use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use capabilities::{CapabilityPolicy, SafePod, SendMessageArgs, SessionIdentity};
use manifest::{FactoryManifest, parse};
use protocol::{ControlState, Direction, Frame, FrameType, Machine};
use serde::Deserialize;
use sha2::Digest;
use state::MessageEnvelope;
use validation::validate;

const HELP: &str = r#"monolith - local agent factory foundation

USAGE:
  monolith validate <manifest>
  monolith plan <manifest> [--state-dir <dir>]
  monolith apply <manifest> [--state-dir <dir>]
  monolith status <state-dir>
  monolith send <state-dir> --from <pod> --to <pod> --kind <kind> --payload <text>
  monolith logs <state-dir> <pod>
  monolith destroy <state-dir>
  monolith demo <manifest> [--state-dir <dir>]

The demo uses local child processes and durable JSON inboxes. The pod-process
subcommand is an internal runtime used by apply and demo.
"#;
const MAX_TOOL_CALLS_PER_TURN: usize = 32;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PodProcessConfig {
    schema_version: u32,
    factory_gen: u64,
    factory: String,
    pod: manifest::PodManifest,
    session: String,
    launch_fingerprint: String,
}

struct ManagedWorker(Child);
impl std::ops::Deref for ManagedWorker {
    type Target = Child;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl std::ops::DerefMut for ManagedWorker {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
impl Drop for ManagedWorker {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args().skip(1);
    let command = arguments.next().unwrap_or_else(|| "help".to_owned());
    let rest: Vec<String> = arguments.collect();

    match command.as_str() {
        "help" | "--help" | "-h" => {
            print!("{HELP}");
            Ok(())
        }
        "validate" => command_validate(&rest),
        "plan" => command_plan(&rest),
        "apply" => command_apply(&rest),
        "status" => command_status(&rest),
        "send" => command_send(&rest),
        "logs" => command_logs(&rest),
        "destroy" => command_destroy(&rest),
        "demo" => command_demo(&rest),
        "pod-process" => command_pod_process(&rest),
        other => Err(format!("unknown command '{other}'. Run 'monolith help'.")),
    }
}

fn command_validate(arguments: &[String]) -> Result<(), String> {
    let manifest_path = required_positional(arguments, 0, "manifest")?;
    let manifest = load_manifest(manifest_path)?;
    println!(
        "valid factory '{}' with {} pod(s)",
        manifest.name,
        manifest.pods.len()
    );
    Ok(())
}

fn command_plan(arguments: &[String]) -> Result<(), String> {
    let manifest_path = required_positional(arguments, 0, "manifest")?;
    let manifest = load_manifest(manifest_path)?;
    let state_dir = manifest_state_dir(
        manifest_path,
        &manifest,
        option_value(arguments, "--state-dir")?,
    );
    let current = state::read_state(&state_dir)
        .map_err(|error| format!("could not read state '{}': {error}", state_dir.display()))?;

    println!("plan: factory {}", manifest.name);
    let mut changes = 0;
    for pod in &manifest.pods {
        let fingerprint = runtime::launch_fingerprint(pod).map_err(|e| e.to_string())?;
        let action = match current.as_ref().and_then(|value| value.pods.get(&pod.name)) {
            Some(existing)
                if runtime::managed_process_is_alive(existing)
                    && existing.launch_fingerprint.as_deref() == Some(&fingerprint) =>
            {
                "no-op"
            }
            Some(_) => "replace",
            None => "create",
        };
        if action != "no-op" {
            changes += 1;
        }
        println!("{action} pod {} (role={})", pod.name, pod.role());
    }

    if let Some(current) = &current {
        for name in current.pods.keys() {
            if !manifest.pods.iter().any(|pod| &pod.name == name) {
                changes += 1;
                println!("destroy pod {name}");
            }
        }
    }

    if changes == 0 {
        println!("plan: no changes");
    }
    Ok(())
}

fn command_apply(arguments: &[String]) -> Result<(), String> {
    let manifest_path = required_positional(arguments, 0, "manifest")?;
    let manifest = load_manifest(manifest_path)?;
    let state_dir = manifest_state_dir(
        manifest_path,
        &manifest,
        option_value(arguments, "--state-dir")?,
    );
    let state = runtime::apply(&state_dir, &manifest)
        .map_err(|error| format!("could not apply factory: {error}"))?;

    println!("applied factory '{}'", state.factory_name);
    for pod in state.pods.values() {
        println!(
            "pod {} engine={} status={} pid={} session={} delivery={} terminal={} restarts={} restart_required={} failure={}",
            pod.name,
            pod.engine,
            pod.status,
            display_pid(pod.pid),
            pod.session.as_deref().unwrap_or("-"),
            pod.active_delivery.as_deref().unwrap_or("-"),
            pod.terminal_result.as_deref().unwrap_or("-"),
            pod.restart.count,
            pod.restart.restart_required,
            pod.last_failure.as_deref().unwrap_or("-")
        );
    }
    Ok(())
}

fn command_status(arguments: &[String]) -> Result<(), String> {
    let state_dir = required_positional(arguments, 0, "state directory")?;
    let state_dir = Path::new(state_dir);
    let mut current = state::read_state(state_dir)
        .map_err(|error| format!("could not read state '{}': {error}", state_dir.display()))?
        .ok_or_else(|| format!("no factory state exists at '{}'", state_dir.display()))?;

    if runtime::refresh(state_dir, &mut current) {
        state::write_state(state_dir, &current)
            .map_err(|error| format!("could not update observed state: {error}"))?;
    }

    println!("factory: {}", current.factory_name);
    for pod in current.pods.values() {
        println!(
            "pod {} engine={} status={} pid={} session={} delivery={} terminal={} restarts={} restart_required={} failure={}",
            pod.name,
            pod.engine,
            pod.status,
            display_pid(pod.pid),
            pod.session.as_deref().unwrap_or("-"),
            pod.active_delivery.as_deref().unwrap_or("-"),
            pod.terminal_result.as_deref().unwrap_or("-"),
            pod.restart.count,
            pod.restart.restart_required,
            pod.last_failure.as_deref().unwrap_or("-")
        );
    }
    Ok(())
}

fn command_send(arguments: &[String]) -> Result<(), String> {
    let state_dir = required_positional(arguments, 0, "state directory")?;
    let state_dir = Path::new(state_dir);
    let from = required_option(arguments, "--from")?;
    let to = required_option(arguments, "--to")?;
    let kind = required_option(arguments, "--kind")?;
    let payload = required_option(arguments, "--payload")?;
    let message = MessageEnvelope {
        schema_version: state::SCHEMA_VERSION,
        id: option_value(arguments, "--id")?.unwrap_or_else(|| state::new_message_id("msg")),
        from,
        to,
        kind,
        payload,
        reply_to: option_value(arguments, "--reply-to")?,
        effect_id: None,
    };

    let current = state::read_state(state_dir)
        .map_err(|error| format!("could not read state '{}': {error}", state_dir.display()))?
        .ok_or_else(|| format!("no factory state exists at '{}'", state_dir.display()))?;
    if !current.pods.contains_key(&message.from) {
        return Err(format!("source pod '{}' is not declared", message.from));
    }
    if !current.pods.contains_key(&message.to) {
        return Err(format!("destination pod '{}' is not declared", message.to));
    }

    let inserted = state::enqueue_message(state_dir, &message)
        .map_err(|error| format!("could not enqueue message: {error}"))?;
    let outcome = if inserted { "queued" } else { "already queued" };
    println!("message {} {outcome}", message.id);
    Ok(())
}

fn command_logs(arguments: &[String]) -> Result<(), String> {
    let state_dir = required_positional(arguments, 0, "state directory")?;
    let pod = required_positional(arguments, 1, "pod")?;
    let output = runtime::logs(Path::new(state_dir), pod)
        .map_err(|error| format!("could not read logs: {error}"))?;
    print!("{output}");
    Ok(())
}

fn command_destroy(arguments: &[String]) -> Result<(), String> {
    let state_dir = required_positional(arguments, 0, "state directory")?;
    let state_dir = Path::new(state_dir);
    let mut current = state::read_state(state_dir)
        .map_err(|error| format!("could not read state '{}': {error}", state_dir.display()))?
        .ok_or_else(|| format!("no factory state exists at '{}'", state_dir.display()))?;
    runtime::destroy(state_dir, &mut current)
        .map_err(|error| format!("could not destroy factory: {error}"))?;
    println!("destroyed factory '{}'", current.factory_name);
    for pod in current.pods.values() {
        println!(
            "pod {} status={} pid={}",
            pod.name,
            pod.status,
            display_pid(pod.pid)
        );
    }
    Ok(())
}

fn command_demo(arguments: &[String]) -> Result<(), String> {
    let manifest_path = required_positional(arguments, 0, "manifest")?;
    let manifest = load_manifest(manifest_path)?;
    let state_dir = manifest_state_dir(
        manifest_path,
        &manifest,
        option_value(arguments, "--state-dir")?,
    );

    if state_dir.exists() {
        if let Some(mut previous) = state::read_state(&state_dir)
            .map_err(|error| format!("could not inspect demo state: {error}"))?
        {
            runtime::destroy(&state_dir, &mut previous)
                .map_err(|error| format!("could not clean previous demo: {error}"))?;
        }
        fs::remove_dir_all(&state_dir)
            .map_err(|error| format!("could not reset demo state: {error}"))?;
    }

    println!("demo: validate");
    println!(
        "valid factory '{}' with {} pod(s)",
        manifest.name,
        manifest.pods.len()
    );
    println!("demo: plan");
    println!("plan: factory {}", manifest.name);
    for pod in &manifest.pods {
        println!("create pod {} (role={})", pod.name, pod.role());
    }

    let state_value = runtime::apply(&state_dir, &manifest)
        .map_err(|error| format!("could not apply demo factory: {error}"))?;
    let planner = manifest
        .pods
        .iter()
        .find(|pod| pod.role() == "planner")
        .map(|pod| pod.name.clone())
        .ok_or_else(|| "demo requires a pod with role 'planner'".to_owned())?;
    let worker = manifest
        .pods
        .iter()
        .find(|pod| pod.role() == "worker")
        .map(|pod| pod.name.clone())
        .ok_or_else(|| "demo requires a pod with role 'worker'".to_owned())?;

    println!("demo: apply");
    for pod in state_value.pods.values() {
        println!(
            "pod {} status={} pid={}",
            pod.name,
            pod.status,
            display_pid(pod.pid)
        );
    }

    let request = MessageEnvelope {
        schema_version: state::SCHEMA_VERSION,
        id: state::new_message_id("request"),
        from: planner.clone(),
        to: worker.clone(),
        kind: "work.requested".to_owned(),
        payload: "golden-path-work".to_owned(),
        reply_to: None,
        effect_id: None,
    };
    state::enqueue_message(&state_dir, &request)
        .map_err(|error| format!("could not enqueue demo request: {error}"))?;
    println!(
        "demo: queued {} from {} to {}",
        request.kind, planner, worker
    );

    wait_for_processed(&state_dir, &worker, &request.id)?;
    let reply_id = format!("reply-{}", request.id);
    wait_for_processed(&state_dir, &planner, &reply_id)?;
    println!("demo: worker completed request and planner received work.completed");

    let logs = runtime::logs(&state_dir, &worker)
        .map_err(|error| format!("could not read worker logs: {error}"))?;
    println!("demo: worker logs");
    print!("{logs}");

    let mut final_state = state::read_state(&state_dir)
        .map_err(|error| format!("could not read final demo state: {error}"))?
        .ok_or_else(|| "demo state disappeared before destroy".to_owned())?;
    runtime::destroy(&state_dir, &mut final_state)
        .map_err(|error| format!("could not destroy demo factory: {error}"))?;
    println!("demo: destroy complete");
    for pod in final_state.pods.values() {
        println!(
            "pod {} status={} pid={}",
            pod.name,
            pod.status,
            display_pid(pod.pid)
        );
    }
    Ok(())
}

fn command_pod_process(arguments: &[String]) -> Result<(), String> {
    let state_dir = required_option(arguments, "--state-dir")?;
    let config_path = required_option(arguments, "--config")?;
    let state_dir = Path::new(&state_dir);
    let paths = state::StatePaths::new(state_dir);
    paths
        .ensure_layout()
        .map_err(|e| format!("could not initialize pod state: {e}"))?;
    let cfg: PodProcessConfig = serde_json::from_slice(
        &fs::read(&config_path)
            .map_err(|e| format!("could not read private worker config: {e}"))?,
    )
    .map_err(|e| format!("invalid private worker config: {e}"))?;
    if cfg.schema_version != state::SCHEMA_VERSION {
        return Err("unsupported private worker config version".into());
    }
    let pod = cfg.pod.name.clone();
    let session = cfg.session.clone();
    let generation = cfg.factory_gen;
    let fingerprint = cfg.launch_fingerprint.clone();
    let executable = cfg
        .pod
        .command
        .first()
        .ok_or("worker config missing executable")?;
    let mut child_cmd = Command::new(executable);
    for arg in cfg.pod.command.iter().skip(1) {
        child_cmd.arg(arg);
    }
    child_cmd.env_clear();
    for name in &cfg.pod.allowed_env {
        if let Ok(value) = env::var(name) {
            child_cmd.env(name, value);
        }
    }
    child_cmd
        .env("MONOLITH_WORKER_CONFIG", &config_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut child = ManagedWorker(
        child_cmd
            .spawn()
            .map_err(|e| format!("could not launch configured worker: {e}"))?,
    );
    let mut input = child.stdin.take().ok_or("worker stdin unavailable")?;
    let output = child.stdout.take().ok_or("worker stdout unavailable")?;
    let (tx, rx) = std::sync::mpsc::channel();
    let max = cfg.pod.max_frame_bytes;
    thread::spawn(move || {
        let mut reader = BufReader::new(output);
        loop {
            let mut line = Vec::new();
            let terminated = loop {
                let available = match reader.fill_buf() {
                    Ok(bytes) => bytes,
                    Err(_) => return,
                };
                if available.is_empty() {
                    break false;
                }
                let limit = (max + 1).saturating_sub(line.len()).min(available.len());
                let slice = &available[..limit];
                if let Some(newline) = slice.iter().position(|byte| *byte == b'\n') {
                    line.extend_from_slice(&slice[..newline]);
                    reader.consume(newline + 1);
                    break true;
                }
                line.extend_from_slice(slice);
                reader.consume(limit);
                if line.len() > max {
                    let _ = tx.send("{\"oversized\":true}".into());
                    return;
                }
            };
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if !terminated && line.is_empty() {
                return;
            }
            match String::from_utf8(line) {
                Ok(value) if value.len() <= max => {
                    if tx.send(value).is_err() {
                        return;
                    }
                }
                Ok(_) | Err(_) => {
                    let _ = tx.send("{\"malformed\":true}".into());
                    return;
                }
            }
            if !terminated {
                return;
            }
        }
    });
    let hello_line = rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| "worker did not send hello".to_owned())?;
    let hello = protocol::parse(hello_line.as_bytes(), max)
        .map_err(|_| "worker hello was malformed".to_owned())?;
    let identity = SessionIdentity {
        factory_generation: generation,
        pod: pod.clone(),
        session: session.clone(),
    };
    if validate_worker_frame(&hello, &identity).is_err()
        || hello.payload["launch_fingerprint"] != fingerprint
        || hello.payload["engine"] != cfg.pod.engine
    {
        let _ = child.kill();
        return Err("worker hello identity mismatch".into());
    }
    let mut machine = Machine {
        state: ControlState::AwaitHello,
        worker_seq: 0,
        session: session.clone(),
    };
    machine.accept(&hello).map_err(|e| e.to_string())?;
    let caps = cfg.pod.capabilities.clone();
    send_control_frame(
        &mut input,
        generation,
        &pod,
        &session,
        1,
        FrameType::HelloAck,
        None,
        None,
        serde_json::json!({"capabilities":caps,"max_frame_bytes":max}),
        max,
    )?;
    state::atomic_write(&paths.ready_file(&pod, &session), b"ready\n", 0o600)
        .map_err(|e| e.to_string())?;
    let mut control_seq = 2u64;
    loop {
        if let Ok(Some(_)) = child.try_wait() {
            return Err("worker exited unexpectedly".into());
        }
        let message_ids = state::pending_message_ids(state_dir, &pod)
            .map_err(|e| format!("could not read {pod} inbox: {e}"))?;
        for message_id in message_ids {
            if state::is_processed(state_dir, &pod, &message_id)
                .map_err(|e| format!("could not read processed marker: {e}"))?
            {
                continue;
            }
            let message = state::read_message(state_dir, &message_id).map_err(|e| e.to_string())?;
            if message.to != pod {
                continue;
            }
            machine.begin_work().map_err(|e| e.to_string())?;
            durability::record(state_dir, "delivery_started", &message.id, None, None)
                .map_err(|e| e.to_string())?;
            update_pod_delivery(
                state_dir,
                &identity,
                &pod,
                Some(&message.id),
                None,
                state::PodStatus::Working,
            )
            .map_err(|e| e.to_string())?;
            send_control_frame(
                &mut input,
                generation,
                &pod,
                &session,
                control_seq,
                FrameType::WorkRequest,
                Some(&message.id),
                None,
                serde_json::json!({"from":message.from,"kind":message.kind,"body":message.payload}),
                max,
            )?;
            let mut tool_calls = 0usize;
            control_seq += 1;
            let turn_deadline = Instant::now() + Duration::from_millis(cfg.pod.request_timeout_ms);
            loop {
                let remaining = turn_deadline.saturating_duration_since(Instant::now());
                let line = match rx.recv_timeout(remaining) {
                    Ok(line) => line,
                    Err(_) => {
                        machine.begin_cancel().map_err(|e| e.to_string())?;
                        let _ = send_control_frame(
                            &mut input,
                            generation,
                            &pod,
                            &session,
                            control_seq,
                            FrameType::Cancel,
                            Some(&message.id),
                            None,
                            serde_json::json!({"reason":"request_timeout"}),
                            max,
                        );
                        durability::record(state_dir, "delivery_failed", &message.id, None, None)
                            .map_err(|e| e.to_string())?;
                        update_pod_delivery(
                            state_dir,
                            &identity,
                            &pod,
                            Some(&message.id),
                            None,
                            state::PodStatus::Failed,
                        )
                        .map_err(|e| e.to_string())?;
                        return Err("worker request timed out".to_owned());
                    }
                };
                let frame = protocol::parse(line.as_bytes(), max)
                    .map_err(|_| "worker emitted malformed frame".to_owned())?;
                validate_worker_frame(&frame, &identity)?;
                if frame.request_id.as_deref() != Some(&message.id) {
                    return Err("worker frame request identity mismatch".into());
                }
                machine.accept(&frame).map_err(|e| e.to_string())?;
                match frame.kind {
                    FrameType::Heartbeat => {}
                    FrameType::ToolCall => {
                        let tool_id = frame
                            .tool_call_id
                            .as_deref()
                            .ok_or("tool call missing id")?;
                        tool_calls += 1;
                        if tool_calls > MAX_TOOL_CALLS_PER_TURN {
                            return Err("tool-call limit exceeded for turn".into());
                        }
                        let result = execute_tool(state_dir, &cfg, &identity, &message.id, &frame)?;
                        send_control_frame(
                            &mut input,
                            generation,
                            &pod,
                            &session,
                            control_seq,
                            FrameType::ToolResult,
                            Some(&message.id),
                            Some(tool_id),
                            result,
                            max,
                        )?;
                        control_seq += 1;
                    }
                    FrameType::Terminal => {
                        state::assert_worker_identity(
                            state_dir,
                            &pod,
                            identity.factory_generation,
                            &identity.session,
                        )
                        .map_err(|e| e.to_string())?;
                        let terminal = paths.terminal_file(&message.id);
                        let mut persisted_frame = frame.clone();
                        runtime::redact_terminal(&mut persisted_frame.payload);
                        let terminal_bytes = serde_json::to_vec_pretty(&persisted_frame)
                            .map_err(|e| e.to_string())?;
                        match state::atomic_create(&terminal, &terminal_bytes, 0o600) {
                            Ok(()) => {}
                            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                                // A terminal already exists for this delivery: a previous
                                // attempt persisted it before the delivery was marked
                                // processed. The first durable terminal is the truth — a
                                // non-deterministic worker may produce different output on
                                // replay, so accept the persisted terminal and complete the
                                // delivery instead of failing forever.
                                let old: Frame = serde_json::from_slice(
                                    &fs::read(&terminal).map_err(|e| e.to_string())?,
                                )
                                .map_err(|e| e.to_string())?;
                                if old.kind != FrameType::Terminal
                                    || old.request_id != persisted_frame.request_id
                                {
                                    return Err("conflicting terminal replay".into());
                                }
                            }
                            Err(error) => return Err(error.to_string()),
                        }
                        durability::record(
                            state_dir,
                            "terminal_persisted",
                            &message.id,
                            None,
                            None,
                        )
                        .map_err(|e| e.to_string())?;
                        update_pod_delivery(
                            state_dir,
                            &identity,
                            &pod,
                            Some(&message.id),
                            Some(&message.id),
                            state::PodStatus::TerminalPersisted,
                        )
                        .map_err(|e| e.to_string())?;
                        state::mark_processed(
                            state_dir,
                            &pod,
                            &message.id,
                            identity.factory_generation,
                            &identity.session,
                        )
                        .map_err(|e| e.to_string())?;
                        durability::record(
                            state_dir,
                            "delivery_completed",
                            &message.id,
                            None,
                            None,
                        )
                        .map_err(|e| e.to_string())?;
                        machine.terminal_durable().map_err(|e| e.to_string())?;
                        update_pod_delivery(
                            state_dir,
                            &identity,
                            &pod,
                            None,
                            Some(&message.id),
                            state::PodStatus::Ready,
                        )
                        .map_err(|e| e.to_string())?;
                        break;
                    }
                    _ => return Err("illegal worker frame in working state".into()),
                }
            }
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn send_control_frame(
    w: &mut impl Write,
    generation: u64,
    pod: &str,
    session: &str,
    seq: u64,
    kind: FrameType,
    request_id: Option<&str>,
    tool_call_id: Option<&str>,
    payload: serde_json::Value,
    max_frame_bytes: usize,
) -> Result<(), String> {
    let frame = Frame {
        protocol: protocol::VERSION.into(),
        direction: Direction::ControlToWorker,
        kind,
        factory_gen: generation,
        pod: pod.into(),
        session: session.into(),
        seq,
        request_id: request_id.map(str::to_owned),
        tool_call_id: tool_call_id.map(str::to_owned),
        payload,
    };
    let bytes = serde_json::to_vec(&frame).map_err(|e| e.to_string())?;
    if bytes.len() > max_frame_bytes {
        return Err("control frame exceeds configured limit".into());
    }
    w.write_all(&bytes)
        .and_then(|_| w.write_all(b"\n"))
        .and_then(|_| w.flush())
        .map_err(|e| e.to_string())
}

fn execute_tool(
    root: &Path,
    cfg: &PodProcessConfig,
    identity: &SessionIdentity,
    request: &str,
    frame: &Frame,
) -> Result<serde_json::Value, String> {
    let id = frame
        .tool_call_id
        .as_deref()
        .ok_or("tool call missing id")?;
    validate_stable_id(id, "tool call id")?;
    state::assert_worker_identity(
        root,
        &identity.pod,
        identity.factory_generation,
        &identity.session,
    )
    .map_err(|e| e.to_string())?;
    let record = durability::tool_result_path(root, &identity.session, id);
    let canonical = serde_json::to_vec(&frame.payload).map_err(|e| e.to_string())?;
    if record.exists() {
        let old: serde_json::Value =
            serde_json::from_slice(&fs::read(&record).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if old["args_digest"] != format!("{:x}", sha2::Sha256::digest(&canonical)) {
            return Err("conflicting tool_call_id reuse".into());
        }
        return Ok(old["result"].clone());
    }
    let name = frame.payload["name"]
        .as_str()
        .ok_or("tool call missing capability")?;
    validate_stable_id(name, "capability name")?;
    let policy = CapabilityPolicy {
        capabilities: cfg.pod.capabilities.iter().cloned().collect(),
        destinations: cfg.pod.destinations.iter().cloned().collect(),
        kinds: cfg.pod.message_kinds.iter().cloned().collect(),
        max_payload_bytes: cfg.pod.max_payload_bytes,
    };
    let result = match name {
        "factory.read_state" => {
            policy.authorize_read_state()?;
            durability::record(root, "effect_requested", request, Some(id), None)
                .map_err(|e| e.to_string())?;
            let s = state::read_state(root)
                .map_err(|e| e.to_string())?
                .ok_or("state unavailable")?;
            let pods = s
                .pods
                .values()
                .map(|p| SafePod {
                    name: &p.name,
                    role: &p.role,
                    engine: &p.engine,
                    status: p.status.to_string(),
                })
                .collect::<Vec<_>>();
            serde_json::json!({"ok":true,"factory":{"name":cfg.factory,"generation":identity.factory_generation},"pods":pods})
        }
        "pod.send_message" => {
            let args =
                serde_json::from_value::<SendMessageArgs>(frame.payload["arguments"].clone())
                    .map_err(|_| "invalid arguments".to_owned())?;
            policy.authorize_send(&args)?;
            durability::record(root, "effect_requested", request, Some(id), None)
                .map_err(|e| e.to_string())?;
            // The effect key must be deterministic across replays. The worker-chosen
            // tool_call_id is NOT stable (a real LLM generates a new id on replay), so
            // it must not participate in the key — otherwise a replay enqueues a
            // duplicate effect. Two identical send_message effects for the same
            // delivery are the same effect and collapse to one.
            let effect = durability::effect_id(&serde_json::json!({
                "pod":identity.pod,
                "delivery":request,
                "to":args.to,
                "kind":args.kind,
                "payload":args.payload
            }))
            .map_err(|e| e.to_string())?;
            let m = MessageEnvelope {
                schema_version: state::SCHEMA_VERSION,
                id: format!("effect-{effect}"),
                from: identity.pod.clone(),
                to: args.to,
                kind: args.kind,
                payload: args.payload,
                reply_to: Some(request.into()),
                effect_id: Some(effect.clone()),
            };
            state::enqueue_message_for_worker(
                root,
                &m,
                &identity.pod,
                identity.factory_generation,
                &identity.session,
            )
            .map_err(|e| e.to_string())?;
            durability::record(root, "effect_applied", request, Some(id), Some(&effect))
                .map_err(|e| e.to_string())?;
            serde_json::json!({"ok":true,"message_id":m.id,"effect_id":effect})
        }
        _ => return Err("capability denied".into()),
    };
    let rec = serde_json::json!({
        "schema_version":2,
        "args_digest":format!("{:x}",sha2::Sha256::digest(canonical)),
        "result":result
    });
    state::atomic_create(
        &record,
        &serde_json::to_vec_pretty(&rec).map_err(|e| e.to_string())?,
        0o600,
    )
    .map_err(|e| e.to_string())?;
    durability::record(
        root,
        "effect_result_persisted",
        request,
        Some(id),
        rec["result"]["effect_id"].as_str(),
    )
    .map_err(|e| e.to_string())?;
    Ok(rec["result"].clone())
}

fn validate_worker_frame(frame: &Frame, identity: &SessionIdentity) -> Result<(), String> {
    if frame.direction != Direction::WorkerToControl
        || frame.factory_gen != identity.factory_generation
        || frame.pod != identity.pod
        || frame.session != identity.session
    {
        return Err("stale, out-of-order, or wrong-session worker frame".into());
    }
    Ok(())
}

fn validate_stable_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 256
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c))
    {
        Err(format!("invalid {label}"))
    } else {
        Ok(())
    }
}

fn update_pod_delivery(
    root: &Path,
    identity: &SessionIdentity,
    pod: &str,
    active: Option<&str>,
    terminal: Option<&str>,
    status: state::PodStatus,
) -> std::io::Result<()> {
    let _lock = durability::FactoryLock::acquire(root)?;
    let mut current = state::read_state(root)?.ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "factory state unavailable")
    })?;
    if current.generation != identity.factory_generation {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "stale factory generation",
        ));
    }
    let value = current.pods.get_mut(pod).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "pod state unavailable")
    })?;
    if value.session.as_deref() != Some(identity.session.as_str()) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "stale worker session",
        ));
    }
    value.active_delivery = active.map(str::to_owned);
    if let Some(terminal) = terminal {
        value.terminal_result = Some(terminal.to_owned());
    }
    value.status = status;
    state::write_state(root, &current)
}

fn wait_for_processed(root: &Path, pod: &str, id: &str) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if state::is_processed(root, pod, id)
            .map_err(|e| format!("could not read processed marker: {e}"))?
        {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err(format!(
        "timed out waiting for {pod} to process message {id}"
    ))
}

fn load_manifest(path: &str) -> Result<FactoryManifest, String> {
    let source = fs::read_to_string(path)
        .map_err(|error| format!("could not read manifest '{path}': {error}"))?;
    let manifest = parse(&source).map_err(|error| format!("manifest parse error: {error}"))?;
    validate(&manifest).map_err(|errors| errors.join("; "))?;
    Ok(manifest)
}

fn manifest_state_dir(
    manifest_path: &str,
    manifest: &FactoryManifest,
    override_dir: Option<String>,
) -> PathBuf {
    let raw = override_dir
        .or_else(|| manifest.state_dir.clone())
        .unwrap_or_else(|| ".monolith".to_owned());
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        path
    } else {
        Path::new(manifest_path)
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(path)
    }
}

fn required_positional<'a>(
    arguments: &'a [String],
    index: usize,
    label: &str,
) -> Result<&'a str, String> {
    arguments
        .get(index)
        .map(String::as_str)
        .filter(|value| !value.starts_with("--"))
        .ok_or_else(|| format!("missing {label}. Run 'monolith help'."))
}

fn required_option(arguments: &[String], flag: &str) -> Result<String, String> {
    option_value(arguments, flag)?.ok_or_else(|| format!("missing {flag}. Run 'monolith help'."))
}

fn option_value(arguments: &[String], flag: &str) -> Result<Option<String>, String> {
    let Some(index) = arguments.iter().position(|argument| argument == flag) else {
        return Ok(None);
    };
    arguments
        .get(index + 1)
        .cloned()
        .map(Some)
        .ok_or_else(|| format!("missing value for {flag}"))
}

fn display_pid(pid: Option<u32>) -> String {
    pid.map(|value| value.to_string())
        .unwrap_or_else(|| "-".to_owned())
}
