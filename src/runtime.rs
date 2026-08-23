use crate::manifest::{FactoryManifest, PodManifest};
use crate::process::{self, ProcessIdentity};
use crate::state::{self, FactoryState, PodStatus, StatePaths};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Serialize)]
struct WorkerConfig<'a> {
    schema_version: u32,
    factory_gen: u64,
    factory: &'a str,
    pod: &'a PodManifest,
    session: &'a str,
    launch_fingerprint: &'a str,
}

pub fn apply(root: &Path, manifest: &FactoryManifest) -> io::Result<FactoryState> {
    let paths = StatePaths::new(root);
    paths.ensure_layout()?;
    let _lock = crate::durability::FactoryLock::acquire(root)?;
    recover_incomplete_apply(root)?;
    let previous = state::read_state(root)?;
    let unchanged = previous.as_ref().is_some_and(|old| {
        old.factory_name == manifest.name
            && old.pods.len() == manifest.pods.len()
            && manifest.pods.iter().all(|pod| {
                let Ok(fp) = launch_fingerprint(pod) else {
                    return false;
                };
                old.pods.get(&pod.name).is_some_and(|existing| {
                    existing.launch_fingerprint.as_deref() == Some(&fp)
                        && existing.status != PodStatus::Failed
                        && process_identity(existing)
                            .is_some_and(|identity| process::identity_alive(&identity))
                })
            })
    });
    if unchanged {
        return Ok(previous.expect("unchanged state must exist"));
    }

    let generation = previous.as_ref().map_or(1, |s| s.generation + 1);
    let mut next = FactoryState::from_manifest(manifest, generation);
    let mut staged = Vec::new();
    append_journal(
        root,
        "apply-journal.jsonl",
        &serde_json::json!({"schema_version":2,"event":"intent","generation":generation}),
    )?;
    for pod in &manifest.pods {
        let fp = launch_fingerprint(pod)?;
        match spawn_supervisor(root, manifest, pod, generation, &fp) {
            Ok((pid, session)) => {
                let Some(process_start_time) = process::process_start_time(pid) else {
                    stop_staged(&staged);
                    return Err(io::Error::other("could not read managed worker start time"));
                };
                staged.push(ProcessIdentity {
                    pid,
                    process_group: pid as i32,
                    session: session.clone(),
                    launch_fingerprint: fp.clone(),
                    start_time: process_start_time,
                });
                if let Err(error) = append_journal(
                    root,
                    "apply-journal.jsonl",
                    &serde_json::json!({
                        "schema_version": 2,
                        "event": "spawned",
                        "generation": generation,
                        "identity": staged.last().expect("staged identity").clone(),
                    }),
                ) {
                    stop_staged(&staged);
                    return Err(error);
                }
                let p = next.pods.get_mut(&pod.name).unwrap();
                p.pid = Some(pid);
                p.process_group = Some(pid as i32);
                p.session = Some(session);
                p.launch_fingerprint = Some(fp);
                p.process_start_time = Some(process_start_time);
                p.status = PodStatus::Ready;
            }
            Err(e) => {
                stop_staged(&staged);
                let _ = append_journal(
                    root,
                    "apply-journal.jsonl",
                    &serde_json::json!({"schema_version":2,"event":"rollback","generation":generation,"error":bounded(&e.to_string())}),
                );
                return Err(e);
            }
        }
    }
    if let Some(old) = previous.as_ref() {
        for pod in old.pods.values() {
            if let Some(identity) = process_identity(pod) {
                append_journal(
                    root,
                    "apply-journal.jsonl",
                    &serde_json::json!({
                        "schema_version": 2,
                        "event": "retiring",
                        "generation": generation,
                        "identity": identity,
                    }),
                )?;
            }
        }
    }
    if let Err(e) = state::write_state(root, &next) {
        stop_staged(&staged);
        let _ = append_journal(
            root,
            "apply-journal.jsonl",
            &serde_json::json!({"schema_version":2,"event":"rollback","generation":generation,"error":bounded(&e.to_string())}),
        );
        return Err(e);
    }
    append_journal(
        root,
        "apply-journal.jsonl",
        &serde_json::json!({"schema_version":2,"event":"commit","generation":generation}),
    )?;
    if let Some(old) = previous {
        for p in old.pods.values() {
            if let Some(identity) = process_identity(p) {
                let _ = process::stop_group(&identity, Duration::from_secs(1));
            }
        }
    }
    append_journal(
        root,
        "apply-journal.jsonl",
        &serde_json::json!({"schema_version":2,"event":"cleanup","generation":generation}),
    )?;
    Ok(next)
}

fn stop_staged(staged: &[ProcessIdentity]) {
    for identity in staged {
        let _ = process::stop_group(identity, Duration::from_secs(1));
    }
}

fn spawn_supervisor(
    root: &Path,
    m: &FactoryManifest,
    p: &PodManifest,
    g: u64,
    fp: &str,
) -> io::Result<(u32, String)> {
    let executable = preflight(m, p)?;
    let mut worker_pod = p.clone();
    worker_pod.command[0] = executable.to_string_lossy().into_owned();
    let session = format!(
        "{}-{}-{}",
        p.name,
        state::timestamp_millis(),
        std::process::id()
    );
    let cp = StatePaths::new(root)
        .root
        .join("configs")
        .join(&p.name)
        .join(format!("{fp}.json"));
    let bytes = serde_json::to_vec(&WorkerConfig {
        schema_version: 2,
        factory_gen: g,
        factory: &m.name,
        pod: &worker_pod,
        session: &session,
        launch_fingerprint: fp,
    })
    .map_err(json_error)?;
    state::atomic_write(&cp, &bytes, 0o600)?;
    fs::set_permissions(&cp, fs::Permissions::from_mode(0o600))?;
    let log_path = StatePaths::new(root).log_file(&p.name);
    state::ensure_no_symlink(&log_path)?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(&log_path)?;
    let err = log.try_clone()?;
    let exe = std::env::current_exe()?;
    let mut c = Command::new(exe);
    c.arg("pod-process")
        .arg("--state-dir")
        .arg(root)
        .arg("--config")
        .arg(&cp)
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(err);
    unsafe {
        c.pre_exec(|| {
            if libc::setsid() == -1 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let mut child = c.spawn()?;
    let pid = child.id();
    let ready = StatePaths::new(root).ready_file(&p.name, &session);
    let deadline = Instant::now() + Duration::from_millis(p.heartbeat_timeout_ms.max(1000));
    while Instant::now() < deadline {
        if ready.exists() {
            return Ok((pid, session));
        }
        // try_wait reaps the child, so an exited pod-process is detected
        // immediately instead of lingering as a zombie that kill(pid, 0)
        // reports as alive.
        if let Ok(Some(_)) = child.try_wait() {
            return Err(io::Error::other(format!(
                "worker {} exited before handshake",
                p.name
            )));
        }
        thread::sleep(Duration::from_millis(20));
    }
    let _ = process::stop_group(
        &ProcessIdentity {
            pid,
            process_group: pid as i32,
            session: session.clone(),
            launch_fingerprint: fp.to_owned(),
            start_time: process::process_start_time(pid)
                .ok_or_else(|| io::Error::other("could not read managed worker start time"))?,
        },
        Duration::from_secs(1),
    );
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        format!("worker {} handshake timed out", p.name),
    ))
}
fn preflight(m: &FactoryManifest, p: &PodManifest) -> io::Result<PathBuf> {
    let executable = p
        .command
        .first()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "worker command must not be empty",
            )
        })?;
    let path = Path::new(executable);
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "worker executable must not be a symlink",
        ));
    }
    let exe = fs::canonicalize(path)?;
    let md = fs::metadata(&exe)?;
    if !md.is_file() || md.permissions().mode() & 0o111 == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "worker executable is not an executable regular file",
        ));
    }
    if !m.trusted_executable_roots.is_empty()
        && !m
            .trusted_executable_roots
            .iter()
            .filter_map(|root| fs::canonicalize(root).ok())
            .any(|root| exe.starts_with(root))
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "worker executable is outside trusted roots",
        ));
    }
    Ok(exe)
}
pub fn refresh(_: &Path, s: &mut FactoryState) -> bool {
    let mut changed = false;
    for p in s.pods.values_mut() {
        if p.pid.is_some() {
            if !process_identity(p).is_some_and(|id| process::identity_alive(&id)) {
                if let Some(identity) = process_identity(p) {
                    let _ = process::stop_group(&identity, Duration::from_secs(1));
                }
                p.pid = None;
                p.process_group = None;
                p.status = PodStatus::Failed;
                p.last_failure = Some("managed worker process exited".into());
                let mut policy = process::RestartPolicy {
                    failures: p.restart.count,
                    restart_required: p.restart.restart_required,
                };
                let backoff = policy.record_failure();
                p.restart.count = policy.failures;
                p.restart.backoff_ms = backoff.map_or(0, |v| v.as_millis() as u64);
                p.restart.restart_required = policy.restart_required;
                if policy.restart_required {
                    p.status = PodStatus::CrashLoop;
                }
                changed = true;
            }
        }
    }
    changed
}
pub fn destroy(root: &Path, s: &mut FactoryState) -> io::Result<()> {
    let _lock = crate::durability::FactoryLock::acquire(root)?;
    for p in s.pods.values_mut() {
        if let Some(identity) = process_identity(p) {
            process::stop_group(&identity, Duration::from_secs(1))?;
        }
        p.process_group = None;
        p.pid = None;
        p.status = PodStatus::Stopped;
    }
    state::write_state(root, s)
}
pub fn logs(root: &Path, pod: &str) -> io::Result<String> {
    let current = state::read_state(root)?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "factory state unavailable"))?;
    if !current.pods.contains_key(pod) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "pod is not declared",
        ));
    }
    let p = StatePaths::new(root).log_file(pod);
    state::ensure_no_symlink(&p)?;
    if !p.exists() {
        return Ok(String::new());
    }
    let mut s = String::new();
    File::open(p)?.take(256 * 1024).read_to_string(&mut s)?;
    Ok(redact(&s))
}
pub fn process_is_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}
pub fn managed_process_is_alive(pod: &crate::state::PodState) -> bool {
    process_identity(pod).is_some_and(|identity| process::identity_alive(&identity))
}
fn process_identity(p: &crate::state::PodState) -> Option<ProcessIdentity> {
    Some(ProcessIdentity {
        pid: p.pid?,
        process_group: p.process_group?,
        session: p.session.clone()?,
        launch_fingerprint: p.launch_fingerprint.clone()?,
        start_time: p.process_start_time?,
    })
}
fn append_journal(root: &Path, name: &str, v: &serde_json::Value) -> io::Result<()> {
    use std::io::Write;
    let p = StatePaths::new(root).root.join(name);
    state::ensure_no_symlink(&p)?;
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(&p)?;
    fs::set_permissions(&p, fs::Permissions::from_mode(0o600))?;
    serde_json::to_writer(&mut f, v).map_err(json_error)?;
    f.write_all(b"\n")?;
    f.sync_all()
}
fn recover_incomplete_apply(root: &Path) -> io::Result<()> {
    state::ensure_no_symlink(&StatePaths::new(root).root)?;
    let p = StatePaths::new(root).root.join("apply-journal.jsonl");
    state::ensure_no_symlink(&p)?;
    if !p.exists() {
        return Ok(());
    }
    let text = fs::read_to_string(&p)?;
    let mut intent = None;
    let mut closed = std::collections::HashSet::new();
    let mut committed = std::collections::HashSet::new();
    let mut cleaned = std::collections::HashSet::new();
    let mut spawned = Vec::new();
    let mut retiring = Vec::new();
    for line in text.lines() {
        let value: serde_json::Value = serde_json::from_str(line).map_err(json_error)?;
        if value["event"] == "intent" {
            intent = value["generation"].as_u64();
            spawned.clear();
            retiring.clear();
        }
        if value["event"] == "spawned" && value["generation"].as_u64() == intent {
            if let Ok(identity) =
                serde_json::from_value::<ProcessIdentity>(value["identity"].clone())
            {
                spawned.push(identity);
            }
        }
        if value["event"] == "retiring" && value["generation"].as_u64() == intent {
            if let Ok(identity) =
                serde_json::from_value::<ProcessIdentity>(value["identity"].clone())
            {
                retiring.push(identity);
            }
        }
        if let Some(generation) = value["generation"].as_u64() {
            match value["event"].as_str() {
                Some("commit") => {
                    closed.insert(generation);
                    committed.insert(generation);
                }
                Some("rollback") => {
                    closed.insert(generation);
                }
                Some("cleanup") => {
                    cleaned.insert(generation);
                }
                _ => {}
            }
        }
    }
    if let Some(generation) = intent {
        if !closed.contains(&generation) {
            for identity in spawned {
                let _ = process::stop_group(&identity, Duration::from_secs(1));
            }
            append_journal(
                root,
                "apply-journal.jsonl",
                &serde_json::json!({
                    "schema_version": 2,
                    "event": "rollback",
                    "generation": generation,
                    "recovered": true
                }),
            )?;
        } else if committed.contains(&generation) && !cleaned.contains(&generation) {
            for identity in retiring {
                let _ = process::stop_group(&identity, Duration::from_secs(1));
            }
            append_journal(
                root,
                "apply-journal.jsonl",
                &serde_json::json!({
                    "schema_version": 2,
                    "event": "cleanup",
                    "generation": generation,
                    "recovered": true
                }),
            )?;
        }
    }
    Ok(())
}
pub fn launch_fingerprint(p: &PodManifest) -> io::Result<String> {
    let b = serde_json::to_vec(p).map_err(json_error)?;
    Ok(format!("{:x}", Sha256::digest(b)))
}
fn bounded(s: &str) -> String {
    s.chars().take(256).collect()
}
pub fn redact_terminal(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(text) => {
            *text = bounded(&redact(text)).trim_end_matches('\n').to_owned();
        }
        serde_json::Value::Array(values) => {
            for value in values {
                redact_terminal(value);
            }
        }
        serde_json::Value::Object(values) => {
            for value in values.values_mut() {
                redact_terminal(value);
            }
        }
        _ => {}
    }
}
fn redact(s: &str) -> String {
    s.lines()
        .map(|line| {
            let upper = line.to_ascii_uppercase();
            let marked = [
                "API_KEY",
                "APIKEY",
                "TOKEN",
                "SECRET",
                "PASSWORD",
                "BEARER ",
                "AUTHORIZATION",
                "COOKIE",
                "PRIVATE_KEY",
                "CREDENTIAL",
                "ACCESS_KEY",
                "CLIENT_SECRET",
                "PROVIDER",
            ]
            .iter()
            .any(|marker| upper.contains(marker));
            let tokenized = line
                .split(|c: char| !c.is_ascii_alphanumeric() && !"-_".contains(c))
                .any(|token| {
                    [
                        "sk-",
                        "sk_",
                        "pk-",
                        "pk_",
                        "ghp_",
                        "github_pat_",
                        "xoxb-",
                        "xapp-",
                        "AIza",
                    ]
                    .iter()
                    .any(|prefix| token.starts_with(prefix))
                });
            if marked || tokenized {
                "[redacted]"
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_redaction_removes_marked_and_provider_tokens() {
        let mut value = serde_json::json!({
            "error": "provider failed with sk-live-secret",
            "nested": ["safe", "Authorization: Bearer secret"],
        });
        redact_terminal(&mut value);
        assert_eq!(value["error"], "[redacted]");
        assert_eq!(value["nested"][0], "safe");
        assert_eq!(value["nested"][1], "[redacted]");
    }
}
fn json_error(e: serde_json::Error) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e)
}
