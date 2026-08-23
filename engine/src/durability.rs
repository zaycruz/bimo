use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
pub struct FactoryLock(File);
impl FactoryLock {
    pub fn acquire(root: &Path) -> io::Result<Self> {
        reject_symlinks(root)?;
        std::fs::create_dir_all(root.join("locks"))?;
        let path = root.join("locks/factory.lock");
        reject_symlinks(&path)?;
        let f = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(&path)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        f.lock_exclusive()?;
        Ok(Self(f))
    }
}
impl Drop for FactoryLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}
fn reject_symlinks(path: &Path) -> io::Result<()> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "durable path must not contain symlinks",
            ));
        }
    }
    Ok(())
}
pub fn effect_id<T: Serialize>(value: &T) -> io::Result<String> {
    let b = serde_json::to_vec(value).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok(format!("{:x}", Sha256::digest(b)))
}
pub fn append<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    reject_symlinks(path)?;
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p)?
    }
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    serde_json::to_writer(&mut f, value)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    f.write_all(b"\n")?;
    f.sync_all()
}
pub fn tool_result_path(root: &Path, session: &str, id: &str) -> PathBuf {
    root.join("tool-results")
        .join(session)
        .join(format!("{id}.json"))
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JournalRecord {
    pub schema_version: u32,
    pub event: String,
    pub delivery_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect_id: Option<String>,
    pub timestamp_ms: u128,
}

pub fn record(
    root: &Path,
    event: &str,
    delivery_id: &str,
    tool_call_id: Option<&str>,
    effect_id: Option<&str>,
) -> io::Result<()> {
    let _lock = FactoryLock::acquire(root)?;
    append(
        &root.join("effect-journal.jsonl"),
        &JournalRecord {
            schema_version: crate::state::SCHEMA_VERSION,
            event: event.to_owned(),
            delivery_id: delivery_id.to_owned(),
            tool_call_id: tool_call_id.map(str::to_owned),
            effect_id: effect_id.map(str::to_owned),
            timestamp_ms: crate::state::timestamp_millis(),
        },
    )
}
