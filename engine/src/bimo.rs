//! Bimo names for the engine's operator settings, with the Monolith names
//! kept as aliases so existing environments and state keep working.
//!
//! - Environment: `BIMO_<NAME>` is read first, then `MONOLITH_<NAME>`.
//! - Local paths: `.bimo/<item>` is used unless only `.monolith/<item>`
//!   exists, so state written before the rename is still found.
//!
//! Variables the engine sets for a runtime, a proxy or a guest (for example
//! `MONOLITH_CONTROL_KEY` or `MONOLITH_WARM_TOKEN`) are part of the golden
//! template's contract and keep their names.
use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub const LOCAL_DIR: &str = ".bimo";
pub const LEGACY_LOCAL_DIR: &str = ".monolith";

/// `BIMO_<suffix>`, else `MONOLITH_<suffix>`.
pub fn var_os(suffix: &str) -> Option<OsString> {
    std::env::var_os(format!("BIMO_{suffix}")).or_else(|| std::env::var_os(format!("MONOLITH_{suffix}")))
}

/// `BIMO_<suffix>`, else `MONOLITH_<suffix>`, as UTF-8.
pub fn var(suffix: &str) -> Result<String, std::env::VarError> {
    match std::env::var(format!("BIMO_{suffix}")) {
        Err(std::env::VarError::NotPresent) => std::env::var(format!("MONOLITH_{suffix}")),
        other => other,
    }
}

/// `<base>/.bimo/<item>`, or `<base>/.monolith/<item>` when only that exists.
/// An empty `item` names the directory itself.
pub fn local_path_in(base: &Path, item: &str) -> PathBuf {
    let current = join(base.join(LOCAL_DIR), item);
    let legacy = join(base.join(LEGACY_LOCAL_DIR), item);
    if !current.exists() && legacy.exists() { legacy } else { current }
}

/// `local_path_in` relative to the working directory.
pub fn local_path(item: &str) -> PathBuf {
    local_path_in(Path::new(""), item)
}

fn join(dir: PathBuf, item: &str) -> PathBuf {
    if item.is_empty() { dir } else { dir.join(item) }
}
