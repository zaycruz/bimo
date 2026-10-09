//! The gate for live Proxmox suites (U1, U5 to U9).
//!
//! A live suite runs only when `MONOLITH_PROXMOX_LIVE=1`, a targets file
//! with a proxmox target is present (`MONOLITH_PROXMOX_TARGETS`, default
//! `.monolith/targets.toml`), and that target's token variable is set. Every
//! run writes a dated JSON report to `.monolith/reports/`, including runs that
//! did not reach the cluster, so a NOT RUN is never mistaken for a pass.
#![allow(dead_code)]
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

pub enum Gate {
    /// Not attempted; the reason says which precondition is missing.
    NotRun(String),
    /// `MONOLITH_PROXMOX_LIVE=1` was set but a precondition is missing. The
    /// suite fails so a requested live run never shows as passed.
    Requested(String),
    /// Every precondition is present.
    Live { targets: PathBuf, target: String, token_env: String },
}

pub fn gate() -> Gate {
    if std::env::var("MONOLITH_PROXMOX_LIVE").as_deref() != Ok("1") {
        return Gate::NotRun("MONOLITH_PROXMOX_LIVE is not 1".to_owned());
    }
    let targets = std::env::var_os("MONOLITH_PROXMOX_TARGETS")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo().join(".monolith/targets.toml"));
    let Ok(text) = fs::read_to_string(&targets) else {
        return Gate::Requested(format!(
            "no targets file at {} (set MONOLITH_PROXMOX_TARGETS)",
            targets.display()
        ));
    };
    let Ok(parsed) = text.parse::<toml::Table>() else {
        return Gate::Requested(format!("{} is not valid TOML", targets.display()));
    };
    let wanted = std::env::var("MONOLITH_PROXMOX_TARGET").ok();
    let target = parsed
        .get("targets")
        .and_then(|t| t.as_array())
        .into_iter()
        .flatten()
        .filter_map(|t| t.as_table())
        .find(|t| {
            t.get("kind").and_then(|k| k.as_str()) == Some("proxmox")
                && wanted
                    .as_deref()
                    .is_none_or(|w| t.get("name").and_then(|n| n.as_str()) == Some(w))
        });
    let Some(target) = target else {
        return Gate::Requested(format!("{} has no proxmox target", targets.display()));
    };
    let name = target.get("name").and_then(|n| n.as_str()).unwrap_or_default().to_owned();
    let token_env = target
        .get("token_env")
        .and_then(|n| n.as_str())
        .unwrap_or_default()
        .to_owned();
    if std::env::var(&token_env).map(|v| v.is_empty()).unwrap_or(true) {
        return Gate::Requested(format!(
            "the pool-scoped write token for target '{name}' is not in {token_env}"
        ));
    }
    Gate::Live { targets, target: name, token_env }
}

/// Write `.monolith/reports/<UTC timestamp>-<suite>.json` and return its path.
pub fn write_report(suite: &str, status: &str, body: Value) -> PathBuf {
    let stamp = Command::new("date")
        .args(["-u", "+%Y%m%dT%H%M%SZ"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .unwrap_or_else(|_| "unknown-time".to_owned());
    let dir = repo().join(".monolith/reports");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{stamp}-{suite}-{}.json", std::process::id()));
    let report = json!({
        "suite": suite,
        "status": status,
        "generated_at": stamp,
        "git_head": git_head(&repo()),
        "detail": body,
    });
    fs::write(&path, serde_json::to_string_pretty(&report).unwrap()).unwrap();
    path
}

/// The live target's Proxmox driver, built the way the CLI builds it.
pub fn live_driver(targets: &Path, target: &str) -> monolith::proxmox::ProxmoxDriver {
    let arguments = vec!["--targets-config".to_owned(), targets.to_string_lossy().into_owned()];
    let loaded = monolith::target::load_catalog_from_cli(&arguments).expect("targets file loads");
    let resolved = loaded.catalog.resolve(Some(target)).expect("live target resolves");
    monolith::proxmox::ProxmoxDriver::from_target(&resolved).expect("driver builds")
}

/// A journal that records what the driver touched and created, the way the
/// control plane's journal does.
#[derive(Default)]
pub struct Recorder {
    pub touched: Vec<monolith::substrate::Resource>,
    pub created: Vec<monolith::substrate::Resource>,
    /// Make `created` fail, as a control plane killed after the guest
    /// exists but before it is recorded.
    pub fail_created: bool,
}

impl monolith::substrate::ResourceJournal for Recorder {
    fn touching(&mut self, resource: &monolith::substrate::Resource) -> Result<(), monolith::substrate::FabricError> {
        self.touched.push(resource.clone());
        Ok(())
    }
    fn created(&mut self, resource: &monolith::substrate::Resource) -> Result<(), monolith::substrate::FabricError> {
        if self.fail_created {
            return Err(monolith::substrate::FabricError::new(
                monolith::substrate::codes::STATE_FAILED,
                "injected: the control plane died before recording the guest",
            ));
        }
        self.created.push(resource.clone());
        Ok(())
    }
}

/// Destroys every guest it was told about when dropped, so a failing live
/// run leaves nothing behind on the cluster.
pub struct Sweeper<'a> {
    pub driver: &'a monolith::proxmox::ProxmoxDriver,
    pub vmids: std::cell::RefCell<Vec<u32>>,
    pub tenants: Vec<String>,
}

impl<'a> Sweeper<'a> {
    pub fn new(driver: &'a monolith::proxmox::ProxmoxDriver, tenants: &[&str]) -> Self {
        Self {
            driver,
            vmids: Default::default(),
            tenants: tenants.iter().map(|t| (*t).to_owned()).collect(),
        }
    }
    pub fn track(&self, vmid: u32) {
        self.vmids.borrow_mut().push(vmid);
    }
}

impl Drop for Sweeper<'_> {
    fn drop(&mut self) {
        for vmid in self.vmids.borrow().iter() {
            if let Err(error) = self.driver.destroy_guest(*vmid) {
                eprintln!("sweeper: could not destroy {vmid}: {error}");
            }
            let _ = self.driver.forget(*vmid);
        }
        for tenant in &self.tenants {
            if let Err(error) = self.driver.drain(Some(tenant)) {
                eprintln!("sweeper: could not drain {tenant}: {error}");
            }
        }
    }
}

fn git_head(dir: &Path) -> Option<String> {
    let output = Command::new("git").args(["rev-parse", "HEAD"]).current_dir(dir).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}
