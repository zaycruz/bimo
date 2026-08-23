use crate::manifest::FactoryManifest;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FactoryState {
    pub schema_version: u32,
    pub generation: u64,
    pub factory_name: String,
    pub pods: BTreeMap<String, PodState>,
}

impl FactoryState {
    pub fn from_manifest(manifest: &FactoryManifest, generation: u64) -> Self {
        let pods = manifest
            .pods
            .iter()
            .map(|p| {
                (
                    p.name.clone(),
                    PodState {
                        name: p.name.clone(),
                        role: p.role().into(),
                        engine: p.engine.clone(),
                        protocol: p.protocol.clone(),
                        pid: None,
                        process_group: None,
                        session: None,
                        launch_fingerprint: None,
                        process_start_time: None,
                        status: PodStatus::Stopped,
                        active_delivery: None,
                        terminal_result: None,
                        restart: RestartState::default(),
                        last_failure: None,
                    },
                )
            })
            .collect();
        Self {
            schema_version: SCHEMA_VERSION,
            generation,
            factory_name: manifest.name.clone(),
            pods,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PodState {
    pub name: String,
    pub role: String,
    pub engine: String,
    #[serde(default)]
    pub protocol: String,
    pub pid: Option<u32>,
    pub process_group: Option<i32>,
    pub session: Option<String>,
    pub launch_fingerprint: Option<String>,
    #[serde(default)]
    pub process_start_time: Option<u128>,
    pub status: PodStatus,
    pub active_delivery: Option<String>,
    pub terminal_result: Option<String>,
    #[serde(default)]
    pub restart: RestartState,
    #[serde(default)]
    pub last_failure: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields)]
pub struct RestartState {
    pub count: u32,
    pub backoff_ms: u64,
    pub restart_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PodStatus {
    Staging,
    Ready,
    Working,
    Cancelling,
    TerminalPersisted,
    Failed,
    CrashLoop,
    Stopped,
    Stale,
}
impl std::fmt::Display for PodStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}",
            serde_json::to_value(self).unwrap().as_str().unwrap()
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MessageEnvelope {
    #[serde(default = "schema")]
    pub schema_version: u32,
    pub id: String,
    pub from: String,
    pub to: String,
    pub kind: String,
    pub payload: String,
    #[serde(default)]
    pub reply_to: Option<String>,
    #[serde(default)]
    pub effect_id: Option<String>,
}
fn schema() -> u32 {
    SCHEMA_VERSION
}

pub struct StatePaths {
    pub root: PathBuf,
}
impl StatePaths {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
    pub fn state_file(&self) -> PathBuf {
        self.root.join("factory_state.json")
    }
    pub fn legacy_state_file(&self) -> PathBuf {
        self.root.join("state.json")
    }
    pub fn inbox_file(&self, p: &str) -> PathBuf {
        self.root.join("inbox").join(format!("{p}.jsonl"))
    }
    pub fn message_file(&self, id: &str) -> PathBuf {
        self.root.join("messages").join(format!("{id}.json"))
    }
    pub fn processed_file(&self, p: &str, id: &str) -> PathBuf {
        self.root.join("processed").join(p).join(id)
    }
    pub fn log_file(&self, p: &str) -> PathBuf {
        self.root.join("logs").join(format!("{p}.log"))
    }
    pub fn ready_file(&self, p: &str, s: &str) -> PathBuf {
        self.root.join("ready").join(format!("{p}-{s}"))
    }
    pub fn terminal_file(&self, id: &str) -> PathBuf {
        self.root.join("terminals").join(format!("{id}.json"))
    }
    pub fn ensure_layout(&self) -> io::Result<()> {
        ensure_no_symlink(&self.root)?;
        fs::create_dir_all(&self.root)?;
        fs::set_permissions(&self.root, fs::Permissions::from_mode(0o700))?;
        for d in [
            "inbox",
            "messages",
            "processed",
            "logs",
            "locks",
            "configs",
            "tool-results",
            "terminals",
            "ready",
        ] {
            let path = self.root.join(d);
            ensure_no_symlink(&path)?;
            fs::create_dir_all(&path)?;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }
}
pub fn ensure_no_symlink(path: &Path) -> io::Result<()> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("state path must not contain symlinks: {}", path.display()),
            ));
        }
    }
    Ok(())
}

pub fn read_state(root: &Path) -> io::Result<Option<FactoryState>> {
    let p = StatePaths::new(root);
    ensure_no_symlink(&p.root)?;
    let file = p.state_file();
    let legacy = p.legacy_state_file();
    ensure_no_symlink(&file)?;
    ensure_no_symlink(&legacy)?;
    if !file.exists() {
        if legacy.exists() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "pre-release state.json requires reset or migration to schema_version 2",
            ));
        }
        return Ok(None);
    }
    let value: serde_json::Value = serde_json::from_slice(&fs::read(file)?).map_err(json_error)?;
    match value.get("schema_version").and_then(|v| v.as_u64()) {
        Some(v) if v == SCHEMA_VERSION as u64 => {}
        Some(v) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unsupported factory state schema version {v}; expected {SCHEMA_VERSION}"),
            ));
        }
        None => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "factory state is missing schema_version; reset or migrate it",
            ));
        }
    }
    serde_json::from_value(value).map(Some).map_err(json_error)
}
pub fn write_state(root: &Path, s: &FactoryState) -> io::Result<()> {
    if s.schema_version != SCHEMA_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "refusing to write unsupported state version",
        ));
    }
    let p = StatePaths::new(root);
    p.ensure_layout()?;
    atomic_write(
        &p.state_file(),
        &serde_json::to_vec_pretty(s).map_err(json_error)?,
        0o600,
    )
}
pub fn enqueue_message(root: &Path, m: &MessageEnvelope) -> io::Result<bool> {
    let _lock = crate::durability::FactoryLock::acquire(root)?;
    enqueue_message_locked(root, m)
}
pub fn enqueue_message_for_worker(
    root: &Path,
    m: &MessageEnvelope,
    expected_pod: &str,
    expected_generation: u64,
    expected_session: &str,
) -> io::Result<bool> {
    let _lock = crate::durability::FactoryLock::acquire(root)?;
    assert_worker_identity_locked(root, expected_pod, expected_generation, expected_session)?;
    enqueue_message_locked(root, m)
}
pub fn assert_worker_identity(
    root: &Path,
    expected_pod: &str,
    expected_generation: u64,
    expected_session: &str,
) -> io::Result<()> {
    let _lock = crate::durability::FactoryLock::acquire(root)?;
    assert_worker_identity_locked(root, expected_pod, expected_generation, expected_session)
}
fn assert_worker_identity_locked(
    root: &Path,
    expected_pod: &str,
    expected_generation: u64,
    expected_session: &str,
) -> io::Result<()> {
    let current = read_state(root)?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "factory state unavailable"))?;
    let matches = current.generation == expected_generation
        && current
            .pods
            .get(expected_pod)
            .and_then(|pod| pod.session.as_deref())
            == Some(expected_session);
    if matches {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "stale worker identity",
        ))
    }
}
fn enqueue_message_locked(root: &Path, m: &MessageEnvelope) -> io::Result<bool> {
    validate_message(m, None)?;
    validate_component(&m.id, "message id")?;
    validate_component(&m.from, "source pod")?;
    validate_component(&m.to, "destination pod")?;
    if m.payload.len() > 32 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "message payload exceeds 32 KiB",
        ));
    }
    if m.kind.is_empty()
        || m.kind.len() > 128
        || !m
            .kind
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid message kind",
        ));
    }
    let current = read_state(root)?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "factory state unavailable"))?;
    if !current.pods.contains_key(&m.to) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "destination pod is not declared",
        ));
    }
    let p = StatePaths::new(root);
    p.ensure_layout()?;
    let mp = p.message_file(&m.id);
    let bytes = serde_json::to_vec_pretty(m).map_err(json_error)?;
    let already_exists = if mp.exists() {
        let old = fs::read(&mp)?;
        if old != bytes {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "message id reused with different content",
            ));
        }
        true
    } else {
        atomic_write(&mp, &bytes, 0o600)?;
        false
    };
    let ip = p.inbox_file(&m.to);
    let mut ids = pending_message_ids(root, &m.to)?;
    if !ids.contains(&m.id) && ids.len() >= 4096 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "pending message queue is full",
        ));
    }
    if !ids.contains(&m.id) {
        ids.push(m.id.clone());
        let body = ids
            .into_iter()
            .map(|v| format!("{v}\n"))
            .collect::<String>();
        atomic_write(&ip, body.as_bytes(), 0o600)?;
    }
    Ok(!already_exists)
}
pub fn read_message(root: &Path, id: &str) -> io::Result<MessageEnvelope> {
    validate_component(id, "message id")?;
    let path = StatePaths::new(root).message_file(id);
    ensure_no_symlink(&path)?;
    let message: MessageEnvelope = serde_json::from_slice(&fs::read(path)?).map_err(json_error)?;
    validate_message(&message, Some(id))?;
    Ok(message)
}
pub fn pending_message_ids(root: &Path, pod: &str) -> io::Result<Vec<String>> {
    validate_component(pod, "pod")?;
    let f = StatePaths::new(root).inbox_file(pod);
    ensure_no_symlink(&f)?;
    if !f.exists() {
        return Ok(vec![]);
    }
    let ids = BufReader::new(File::open(f)?)
        .lines()
        .filter(|line| line.as_ref().map(|v| !v.trim().is_empty()).unwrap_or(true))
        .take(4097)
        .collect::<Result<Vec<_>, _>>()?;
    if ids.len() > 4096 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "pending message queue exceeds 4096 entries",
        ));
    }
    Ok(ids)
}
pub fn is_processed(root: &Path, p: &str, id: &str) -> io::Result<bool> {
    validate_component(p, "pod")?;
    validate_component(id, "message id")?;
    let path = StatePaths::new(root).processed_file(p, id);
    ensure_no_symlink(&path)?;
    Ok(path.exists())
}
pub fn mark_processed(
    root: &Path,
    p: &str,
    id: &str,
    expected_generation: u64,
    expected_session: &str,
) -> io::Result<()> {
    let _lock = crate::durability::FactoryLock::acquire(root)?;
    validate_component(p, "pod")?;
    validate_component(id, "message id")?;
    let current = read_state(root)?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "factory state unavailable"))?;
    let pod = current
        .pods
        .get(p)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "pod state unavailable"))?;
    if current.generation != expected_generation || pod.session.as_deref() != Some(expected_session)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "stale worker identity",
        ));
    }
    atomic_write(
        &StatePaths::new(root).processed_file(p, id),
        format!("{}\n", timestamp_millis()).as_bytes(),
        0o600,
    )
}
pub fn new_message_id(prefix: &str) -> String {
    format!("{prefix}-{}-{}", timestamp_millis(), std::process::id())
}
pub fn timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
pub fn atomic_write(path: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    ensure_no_symlink(path)?;
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(p) = path.parent() {
        fs::create_dir_all(p)?;
    }
    let tmp = path.with_file_name(format!(
        ".{}.tmp-{}-{}",
        path.file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("record"),
        std::process::id(),
        timestamp_millis()
    ));
    let mut f = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(mode)
        .open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    fs::rename(&tmp, path)?;
    if let Some(p) = path.parent() {
        File::open(p)?.sync_all()?;
    }
    Ok(())
}
pub fn atomic_create(path: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    ensure_no_symlink(path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if path.exists() {
        return if fs::read(path)? == bytes {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "immutable record already contains different content",
            ))
        };
    }
    let tmp = path.with_file_name(format!(
        ".{}.create-{}-{}",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("record"),
        std::process::id(),
        timestamp_millis()
    ));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(mode)
        .open(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    match fs::hard_link(&tmp, path) {
        Ok(()) => {
            fs::remove_file(&tmp)?;
            if let Some(parent) = path.parent() {
                File::open(parent)?.sync_all()?;
            }
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let _ = fs::remove_file(&tmp);
            if fs::read(path)? == bytes {
                Ok(())
            } else {
                Err(error)
            }
        }
        Err(error) => {
            let _ = fs::remove_file(&tmp);
            Err(error)
        }
    }
}
fn validate_message(message: &MessageEnvelope, expected_id: Option<&str>) -> io::Result<()> {
    if message.schema_version != SCHEMA_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "unsupported message schema version {}; expected {SCHEMA_VERSION}",
                message.schema_version
            ),
        ));
    }
    if let Some(expected_id) = expected_id {
        if expected_id != message.id {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "message id does not match its filename",
            ));
        }
    }
    validate_component(&message.id, "message id")?;
    validate_component(&message.from, "source pod")?;
    validate_component(&message.to, "destination pod")?;
    if message.kind.is_empty()
        || message.kind.len() > 128
        || !message
            .kind
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid message kind",
        ));
    }
    if message.payload.len() > 32 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "message payload exceeds 32 KiB",
        ));
    }
    if let Some(reply_to) = &message.reply_to {
        validate_component(reply_to, "reply message id")?;
    }
    if let Some(effect_id) = &message.effect_id {
        validate_component(effect_id, "effect id")?;
    }
    Ok(())
}
fn validate_component(v: &str, label: &str) -> io::Result<()> {
    if v.is_empty() || v == "." || v == ".." || v.contains('/') || v.contains('\\') {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{label} must be a safe path component"),
        ))
    } else {
        Ok(())
    }
}
fn json_error(e: serde_json::Error) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: &str) -> MessageEnvelope {
        MessageEnvelope {
            schema_version: SCHEMA_VERSION,
            id: id.to_owned(),
            from: "planner".into(),
            to: "worker".into(),
            kind: "work.completed".into(),
            payload: "{}".into(),
            reply_to: None,
            effect_id: None,
        }
    }

    #[test]
    fn message_filename_validation_rejects_traversal() {
        assert!(validate_message(&message("../outside"), Some("msg-1")).is_err());
        assert!(validate_message(&message("msg-1"), Some("msg-1")).is_ok());
    }

    #[test]
    fn message_validation_rejects_oversized_payload() {
        let mut value = message("msg-1");
        value.payload = "x".repeat(32 * 1024 + 1);
        assert!(validate_message(&value, Some("msg-1")).is_err());
    }
}
