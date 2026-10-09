//! The per-tenant warm pool (U6, KTD1, KTD5, KTD10).
//!
//! A pool holds started, unbound guests cloned from the golden template, per
//! tenant. A claim takes one, binds it with a per-claim payload through the
//! bind agent in the guest and hands it to the agent journal. The claim path
//! makes no Proxmox API call; refilling happens off the request path.
//!
//! Pool state lives in `<pool dir>/<target>.json` (default `.monolith/pools`,
//! override with `MONOLITH_POOL_DIR`) under an exclusive file lock, so
//! separate CLI invocations share it. Every guest is recorded before it is
//! cloned (`cloning`, with the filler's pid), so a filler that dies leaves a
//! record the next fill clears.
use super::delivery::GuestChannel;
use super::{hostname, ProxmoxDriver};
use crate::runtimes::WarmRecipe;
use crate::substrate::{codes, FabricError, Resource, ResourceJournal};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::net::Ipv4Addr;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::time::{Duration, Instant};

pub const POOL_SCHEMA_VERSION: u32 = 1;
const CLONE_TIMEOUT: Duration = Duration::from_secs(240);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GuestState {
    /// Reserved and being cloned by `owner_pid`.
    Cloning,
    /// Started, bind agent answering, unbound.
    Ready,
    /// Bound to an agent; the agent journal owns it now.
    Claimed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PoolGuest {
    pub vmid: u32,
    pub node: String,
    pub tenant: String,
    pub address: Ipv4Addr,
    pub state: GuestState,
    /// Template version the guest was cloned from (drift detection).
    #[serde(default)]
    pub template_version: Option<String>,
    pub created_at_ms: u64,
    #[serde(default)]
    pub owner_pid: Option<u32>,
    #[serde(default)]
    pub owner_start: Option<u128>,
    #[serde(default)]
    pub claimed_by: Option<String>,
    #[serde(default)]
    pub claimed_at_ms: Option<u64>,
    /// Set when the guest runs a warm runtime (its `WarmRecipe` key). Such a
    /// guest was bound to its tenant's pool when it was warmed; a claim
    /// sends its go request instead of binding it. Its credential and go
    /// token are kept beside the pool state, not in it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warm: Option<String>,
}

/// What the control plane keeps for a warm guest (mode 0600, one file per
/// guest under `<pool dir>/<target>-warm/`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WarmSecrets {
    claim_id: String,
    credential: String,
    go_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PoolState {
    pub schema_version: u32,
    pub target: String,
    /// The template version as of the last fill.
    #[serde(default)]
    pub template_version: Option<String>,
    #[serde(default)]
    pub guests: Vec<PoolGuest>,
}

/// A bound guest, handed to the caller.
#[derive(Debug, Clone)]
pub struct Claim {
    pub resource: Resource,
    pub vmid: u32,
    pub address: Ipv4Addr,
    pub claim_id: String,
    /// The per-guest credential minted at claim (KTD10). Never shared.
    pub credential: String,
    /// True when the guest came from the warm pool, false for a cold clone.
    pub pooled: bool,
    pub template_version: String,
    /// The bind agent's `/status` reply after the bind.
    pub status: Value,
    /// For a warm guest: the token its warm runtime takes go with.
    pub go_token: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct FillReport {
    pub target: String,
    pub tenant: String,
    pub size: u32,
    pub template_version: Option<String>,
    pub created: Vec<u32>,
    pub retired: Vec<u32>,
    pub cleared: Vec<u32>,
    pub ready: Vec<u32>,
    /// Guests that now run a warm runtime (`fill_warm`).
    pub warmed: Vec<u32>,
    pub errors: Vec<String>,
}

pub fn pool_dir() -> PathBuf {
    std::env::var_os("MONOLITH_POOL_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".monolith").join("pools"))
}

struct Locked {
    _lock: File,
    path: PathBuf,
    state: PoolState,
}

impl Locked {
    fn open(target: &str) -> Result<Self, FabricError> {
        let failed = |context: &str, error: std::io::Error| FabricError::io(codes::STATE_FAILED, context, error);
        let dir = pool_dir();
        fs::create_dir_all(&dir).map_err(|e| failed("could not create the pool directory", e))?;
        let lock_path = dir.join(format!("{target}.lock"));
        crate::state::ensure_no_symlink(&lock_path).map_err(|e| failed("unsafe pool lock", e))?;
        let lock = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(&lock_path)
            .map_err(|e| failed("could not open the pool lock", e))?;
        lock.lock_exclusive().map_err(|e| failed("could not lock the pool", e))?;
        let path = dir.join(format!("{target}.json"));
        let state = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).map_err(|error| {
                FabricError::new(codes::STATE_FAILED, format!("pool state {} is invalid: {error}", path.display()))
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => PoolState {
                schema_version: POOL_SCHEMA_VERSION,
                target: target.to_owned(),
                template_version: None,
                guests: Vec::new(),
            },
            Err(error) => return Err(failed("could not read the pool state", error)),
        };
        if state.schema_version != POOL_SCHEMA_VERSION {
            return Err(FabricError::new(
                codes::STATE_FAILED,
                format!("pool state {} has schema {}", path.display(), state.schema_version),
            ));
        }
        Ok(Self { _lock: lock, path, state })
    }

    fn save(&self) -> Result<(), FabricError> {
        let text = serde_json::to_string_pretty(&self.state).unwrap_or_default();
        crate::state::atomic_write(&self.path, text.as_bytes(), 0o600)
            .map_err(|e| FabricError::io(codes::STATE_FAILED, "could not write the pool state", e))
    }
}

impl ProxmoxDriver {
    fn locked(&self) -> Result<Locked, FabricError> {
        Locked::open(&self.target_name)
    }

    /// The pool state as recorded (no API call).
    pub fn pool_state(&self) -> Result<PoolState, FabricError> {
        Ok(self.locked()?.state)
    }

    /// Drop a destroyed guest from the pool state.
    pub fn forget(&self, vmid: u32) -> Result<(), FabricError> {
        let _ = fs::remove_file(self.warm_secrets_path(vmid));
        let mut locked = self.locked()?;
        let before = locked.state.guests.len();
        locked.state.guests.retain(|g| g.vmid != vmid);
        if locked.state.guests.len() != before {
            locked.save()?;
        }
        Ok(())
    }

    /// Claim a guest for `agent`: a ready pooled guest when there is one,
    /// otherwise a cold clone. The guest is journaled before it is touched
    /// and recorded as created once it is bound.
    pub fn claim(
        &self,
        tenant: &str,
        agent: &str,
        generation: u64,
        journal: &mut dyn ResourceJournal,
    ) -> Result<Claim, FabricError> {
        self.claim_for(tenant, agent, generation, None, journal)
    }

    /// `claim`, preferring a guest of this tenant whose warm runtime has the
    /// key `warm` (the caller then sends it go), then an unwarmed pooled
    /// guest, then a cold clone. A guest warmed for another runtime is never
    /// taken, and nothing ever crosses tenants.
    pub fn claim_for(
        &self,
        tenant: &str,
        agent: &str,
        generation: u64,
        warm: Option<&str>,
        journal: &mut dyn ResourceJournal,
    ) -> Result<Claim, FabricError> {
        self.tenant_vlan(tenant)?;
        loop {
            let picked = {
                let mut locked = self.locked()?;
                let current = locked.state.template_version.clone();
                let usable = |g: &PoolGuest| {
                    g.tenant == tenant
                        && g.state == GuestState::Ready
                        && current.is_some()
                        && g.template_version == current
                };
                let index = warm
                    .and_then(|key| {
                        locked
                            .state
                            .guests
                            .iter()
                            .position(|g| usable(g) && g.warm.as_deref() == Some(key))
                    })
                    .or_else(|| locked.state.guests.iter().position(|g| usable(g) && g.warm.is_none()));
                match index {
                    None => None,
                    Some(index) => {
                        let guest = locked.state.guests[index].clone();
                        let version = guest.template_version.clone().unwrap_or_default();
                        let resource = self.resource(guest.vmid, guest.address, &version)?;
                        journal.touching(&resource)?;
                        let entry = &mut locked.state.guests[index];
                        entry.state = GuestState::Claimed;
                        entry.claimed_by = Some(agent.to_owned());
                        entry.claimed_at_ms = Some(now_ms());
                        locked.save()?;
                        Some((guest, resource, version))
                    }
                }
            };
            let Some((guest, resource, version)) = picked else {
                return self.cold_claim(tenant, agent, generation, journal);
            };
            let bound = match &guest.warm {
                Some(key) => self.check_warm(&guest, key).map(|(secrets, status)| {
                    (secrets.claim_id, secrets.credential, status, Some(secrets.go_token))
                }),
                None => self
                    .bind(&guest, agent, generation, &version)
                    .map(|(claim_id, credential, status)| (claim_id, credential, status, None)),
            };
            match bound {
                Ok((claim_id, credential, status, go_token)) => {
                    journal.created(&resource)?;
                    return Ok(Claim {
                        resource,
                        vmid: guest.vmid,
                        address: guest.address,
                        claim_id,
                        credential,
                        pooled: true,
                        template_version: version,
                        status,
                        go_token,
                    });
                }
                Err(_) => {
                    // A pooled guest that will not bind, or a warm guest
                    // that lost its warm runtime, is never retried and never
                    // handed out. It becomes a dead record (Cloning, no
                    // owner) that the next fill or drain destroys, so the
                    // destroy (about 2 s) stays off the request path; try
                    // the next one.
                    self.mark(guest.vmid, GuestState::Cloning, None)?;
                }
            }
        }
    }

    /// Clone, start and bind a guest for `agent` without the pool.
    pub fn cold_claim(
        &self,
        tenant: &str,
        agent: &str,
        generation: u64,
        journal: &mut dyn ResourceJournal,
    ) -> Result<Claim, FabricError> {
        let version = self.template_version()?;
        let guest = self.reserve(tenant, Some(agent), &version)?;
        let resource = self.resource(guest.vmid, guest.address, &version)?;
        let cleanup = |error: FabricError| {
            let _ = self.destroy_guest(guest.vmid);
            let _ = self.forget(guest.vmid);
            error
        };
        if let Err(error) = journal.touching(&resource) {
            let _ = self.forget(guest.vmid);
            return Err(error);
        }
        self.clone_and_start(guest.vmid, guest.address, tenant, CLONE_TIMEOUT)
            .map_err(cleanup)?;
        let (claim_id, credential, status) = self
            .bind(&guest, agent, generation, &version)
            .map_err(|message| {
                cleanup(FabricError::new(
                    codes::SUBSTRATE_FAILED,
                    format!("guest {} would not bind: {message}", guest.vmid),
                ))
            })?;
        self.mark(guest.vmid, GuestState::Claimed, Some(agent)).map_err(cleanup)?;
        journal.created(&resource)?;
        Ok(Claim {
            resource,
            vmid: guest.vmid,
            address: guest.address,
            claim_id,
            credential,
            pooled: false,
            template_version: version,
            status,
            go_token: None,
        })
    }

    /// Bring the tenant's pool up to the target's `warm_pool_size`: clear
    /// records of dead fillers, retire guests from an older template or that
    /// stopped, then clone the shortfall one at a time.
    pub fn fill(&self, tenant: &str) -> Result<FillReport, FabricError> {
        self.tenant_vlan(tenant)?;
        let size = self.settings()?.warm_pool_size;
        let version = self.template_version()?;
        let mut report = FillReport {
            target: self.target_name.clone(),
            tenant: tenant.to_owned(),
            size,
            template_version: Some(version.clone()),
            ..FillReport::default()
        };
        let (dead, stale, ready) = {
            let mut locked = self.locked()?;
            locked.state.template_version = Some(version.clone());
            locked.save()?;
            let dead: Vec<u32> = locked
                .state
                .guests
                .iter()
                .filter(|g| g.state == GuestState::Cloning && !owner_alive(g))
                .map(|g| g.vmid)
                .collect();
            let stale: Vec<u32> = locked
                .state
                .guests
                .iter()
                .filter(|g| g.state == GuestState::Ready && g.template_version.as_deref() != Some(&version))
                .map(|g| g.vmid)
                .collect();
            let ready: Vec<u32> = locked
                .state
                .guests
                .iter()
                .filter(|g| g.state == GuestState::Ready && g.tenant == tenant)
                .map(|g| g.vmid)
                .collect();
            (dead, stale, ready)
        };
        for vmid in dead {
            self.destroy_guest(vmid)?;
            self.forget(vmid)?;
            report.cleared.push(vmid);
        }
        for vmid in stale {
            self.destroy_guest(vmid)?;
            self.forget(vmid)?;
            report.retired.push(vmid);
        }
        for vmid in ready {
            if !report.retired.contains(&vmid) && !self.guest_running(vmid)? {
                self.destroy_guest(vmid)?;
                self.forget(vmid)?;
                report.retired.push(vmid);
            }
        }
        loop {
            let held = self
                .locked()?
                .state
                .guests
                .iter()
                .filter(|g| {
                    g.tenant == tenant
                        && g.claimed_by.is_none()
                        && (g.state == GuestState::Ready || (g.state == GuestState::Cloning && owner_alive(g)))
                })
                .count() as u32;
            if held >= size {
                break;
            }
            let guest = match self.reserve(tenant, None, &version) {
                Ok(guest) => guest,
                Err(error) => {
                    report.errors.push(error.message);
                    break;
                }
            };
            match self.clone_and_start(guest.vmid, guest.address, tenant, CLONE_TIMEOUT) {
                Ok(()) => {
                    self.mark(guest.vmid, GuestState::Ready, None)?;
                    report.created.push(guest.vmid);
                }
                Err(error) => {
                    let _ = self.destroy_guest(guest.vmid);
                    let _ = self.forget(guest.vmid);
                    report.errors.push(error.message);
                    break;
                }
            }
        }
        report.ready = self
            .locked()?
            .state
            .guests
            .iter()
            .filter(|g| g.tenant == tenant && g.state == GuestState::Ready)
            .map(|g| g.vmid)
            .collect();
        Ok(report)
    }

    /// `fill`, then start the warm runtime `recipe` in every ready, unwarmed
    /// guest of the tenant. Warming binds the guest to the tenant's pool (a
    /// payload with the tenant and the warm key, no agent), uploads the
    /// launcher and starts it under the egress lock with a go token minted
    /// for that guest. A guest that fails to warm is destroyed.
    pub fn fill_warm(&self, tenant: &str, recipe: &WarmRecipe) -> Result<FillReport, FabricError> {
        let mut report = self.fill(tenant)?;
        let version = self.template_version()?;
        let work = pool_dir().join(format!("{}-warm", self.target_name));
        fs::create_dir_all(&work)
            .map_err(|e| FabricError::io(codes::STATE_FAILED, "could not create the warm pool directory", e))?;
        let stage = work.join(format!("stage-{}", std::process::id()));
        fs::create_dir_all(&stage)
            .map_err(|e| FabricError::io(codes::STATE_FAILED, "could not create the warm staging directory", e))?;
        let bundle = super::delivery::stage_warm_bundle(recipe, &stage)
            .map_err(|message| FabricError::new(codes::SOURCE_FAILED, message));
        let bundle = match bundle {
            Ok(bundle) => bundle,
            Err(error) => {
                let _ = fs::remove_dir_all(&stage);
                return Err(error);
            }
        };
        // Guests warmed with an older launcher for this runtime are never
        // claimed again; retire them.
        let family = recipe.key.rsplit_once('-').map_or(recipe.key.as_str(), |(family, _)| family);
        let outdated: Vec<u32> = self
            .locked()?
            .state
            .guests
            .iter()
            .filter(|g| g.tenant == tenant && g.state == GuestState::Ready)
            .filter(|g| {
                g.warm.as_deref().is_some_and(|key| {
                    key != recipe.key && key.rsplit_once('-').map_or(key, |(f, _)| f) == family
                })
            })
            .map(|g| g.vmid)
            .collect();
        for vmid in outdated {
            self.destroy_guest(vmid)?;
            self.forget(vmid)?;
            report.retired.push(vmid);
        }
        // A guest restarted since it was warmed has lost its binding and its
        // runtime (both live in tmpfs). Mark it unwarmed so the loop below
        // binds and warms it again; one that cannot be rebound is destroyed
        // there. (Seen on pve-node-a: something outside Monolith restarts every
        // new container about three minutes after its first start.)
        let warmed: Vec<PoolGuest> = self
            .locked()?
            .state
            .guests
            .iter()
            .filter(|g| g.tenant == tenant && g.state == GuestState::Ready && g.warm.as_deref() == Some(&recipe.key))
            .cloned()
            .collect();
        for guest in warmed {
            if self.check_warm(&guest, &recipe.key).is_err() {
                let mut locked = self.locked()?;
                if let Some(entry) = locked
                    .state
                    .guests
                    .iter_mut()
                    .find(|g| g.vmid == guest.vmid && g.state == GuestState::Ready)
                {
                    entry.warm = None;
                }
                locked.save()?;
                let _ = fs::remove_file(self.warm_secrets_path(guest.vmid));
            }
        }
        let mut retried = BTreeSet::new();
        loop {
            // Take one unwarmed guest at a time under the lock, marked as
            // being worked on by this process, so a concurrent claim cannot
            // bind it while it is warmed.
            let picked = {
                let mut locked = self.locked()?;
                let pid = std::process::id();
                let found = locked.state.guests.iter_mut().find(|g| {
                    g.tenant == tenant
                        && g.state == GuestState::Ready
                        && g.warm.is_none()
                        && g.template_version.as_deref() == Some(version.as_str())
                });
                match found {
                    None => None,
                    Some(guest) => {
                        guest.state = GuestState::Cloning;
                        guest.owner_pid = Some(pid);
                        guest.owner_start = crate::process::process_start_time(pid);
                        let guest = guest.clone();
                        locked.save()?;
                        Some(guest)
                    }
                }
            };
            let Some(guest) = picked else { break };
            match self.warm_guest(&guest, recipe, &bundle, &version) {
                Ok(()) => {
                    let mut locked = self.locked()?;
                    if let Some(entry) = locked.state.guests.iter_mut().find(|g| g.vmid == guest.vmid) {
                        entry.state = GuestState::Ready;
                        entry.owner_pid = None;
                        entry.owner_start = None;
                        entry.warm = Some(recipe.key.clone());
                    }
                    locked.save()?;
                    report.warmed.push(guest.vmid);
                }
                Err(message) => {
                    // A guest restarted while it was being warmed comes back
                    // unbound and empty: warm it once more. Anything else,
                    // or a second failure, retires it.
                    let port = self.settings()?.bind_port;
                    let restarted = !retried.contains(&guest.vmid)
                        && wait_for_bind_agent(guest.address, port, &hostname(guest.vmid), Instant::now() + Duration::from_secs(60))
                            .is_ok();
                    if restarted {
                        retried.insert(guest.vmid);
                        let _ = fs::remove_file(self.warm_secrets_path(guest.vmid));
                        self.mark(guest.vmid, GuestState::Ready, None)?;
                    } else {
                        let _ = self.destroy_guest(guest.vmid);
                        let _ = self.forget(guest.vmid);
                        report.errors.push(format!("guest {} would not warm: {message}", guest.vmid));
                    }
                }
            }
        }
        let _ = fs::remove_dir_all(&stage);
        report.ready = self
            .locked()?
            .state
            .guests
            .iter()
            .filter(|g| g.tenant == tenant && g.state == GuestState::Ready)
            .map(|g| g.vmid)
            .collect();
        Ok(report)
    }

    fn warm_guest(&self, guest: &PoolGuest, recipe: &WarmRecipe, bundle: &std::path::Path, version: &str) -> Result<(), String> {
        let settings = self.settings().map_err(|e| e.message)?.clone();
        if recipe.memory_mb > settings.memory_mb {
            self.set_memory(guest.vmid, recipe.memory_mb).map_err(|e| e.message)?;
        }
        let claim_id = format!("warm-{}-{}", guest.vmid, random_hex(8)?);
        let (claim_id, credential, _status) = self.bind_with(
            guest,
            claim_id,
            json!({
                "tenant": guest.tenant,
                "warm": recipe.key,
                "target": self.target_name,
                "template_version": version,
                "issued_at_ms": now_ms(),
            }),
        )?;
        let go_token = random_hex(32)?;
        let secrets = WarmSecrets {
            claim_id,
            credential: credential.clone(),
            go_token: go_token.clone(),
        };
        let text = serde_json::to_vec(&secrets).map_err(|e| e.to_string())?;
        crate::state::atomic_write(&self.warm_secrets_path(guest.vmid), &text, 0o600)
            .map_err(|e| format!("could not record the warm guest's credential: {e}"))?;
        let channel = GuestChannel::new(guest.address, settings.bind_port, &credential);
        channel.put_bundle(bundle).map_err(|e| e.to_string())?;
        channel
            .start(&super::delivery::warm_start_body(recipe, &go_token))
            .map_err(|e| e.to_string())?;
        // A guest counts as warm only once its runtime has loaded and listens
        // for go; a claim of a guest still loading would wait for it.
        wait_until_warm(guest.address, recipe.port, Duration::from_secs(90))
    }

    /// Before a warm guest is handed out: its bind agent must still hold the
    /// pool binding this control plane made, for this tenant and this warm
    /// key, and its warm runtime must be running.
    fn check_warm(&self, guest: &PoolGuest, key: &str) -> Result<(WarmSecrets, Value), String> {
        let text = fs::read(self.warm_secrets_path(guest.vmid))
            .map_err(|e| format!("the warm guest's credential is missing: {e}"))?;
        let secrets: WarmSecrets =
            serde_json::from_slice(&text).map_err(|e| format!("the warm guest's credential is unreadable: {e}"))?;
        let port = self.settings().map_err(|e| e.message)?.bind_port;
        let channel = GuestChannel::new(guest.address, port, &secrets.credential);
        let status = channel.status().map_err(|e| e.to_string())?;
        if status.get("claim_id").and_then(Value::as_str) != Some(secrets.claim_id.as_str())
            || status["payload"]["tenant"].as_str() != Some(guest.tenant.as_str())
            || status["payload"]["warm"].as_str() != Some(key)
        {
            return Err(format!("the warm guest's binding does not match: {status}"));
        }
        let runtime = channel.runtime().map_err(|e| e.to_string())?;
        if runtime.get("state").and_then(Value::as_str) != Some("running") {
            return Err(format!("the warm runtime is not running: {runtime}"));
        }
        Ok((secrets, status))
    }

    fn warm_secrets_path(&self, vmid: u32) -> PathBuf {
        pool_dir().join(format!("{}-warm", self.target_name)).join(format!("{vmid}.json"))
    }

    /// Destroy the tenant's unclaimed guests (all tenants when `None`).
    /// Claimed guests belong to agents and are left alone.
    pub fn drain(&self, tenant: Option<&str>) -> Result<Vec<u32>, FabricError> {
        let victims: Vec<u32> = self
            .locked()?
            .state
            .guests
            .iter()
            .filter(|g| tenant.is_none_or(|t| g.tenant == t))
            .filter(|g| g.state == GuestState::Ready || (g.state == GuestState::Cloning && !owner_alive(g)))
            .map(|g| g.vmid)
            .collect();
        for vmid in &victims {
            self.destroy_guest(*vmid)?;
            self.forget(*vmid)?;
        }
        Ok(victims)
    }

    /// Reserve a VMID and an address under the pool lock and record the
    /// guest as `cloning` before anything is created.
    fn reserve(&self, tenant: &str, agent: Option<&str>, version: &str) -> Result<PoolGuest, FabricError> {
        let settings = self.settings()?.clone();
        let visible = self.visible_guests()?;
        let mut used_addresses = self.addresses_in_use(&visible)?;
        let visible_ids: BTreeSet<u32> = visible
            .iter()
            .filter_map(|g| g.get("vmid").and_then(Value::as_u64))
            .map(|v| v as u32)
            .collect();
        let mut locked = self.locked()?;
        let recorded: BTreeSet<u32> = locked.state.guests.iter().map(|g| g.vmid).collect();
        used_addresses.extend(locked.state.guests.iter().map(|g| g.address));
        let address = settings.addresses.allocate(&used_addresses).ok_or_else(|| {
            FabricError::new(
                codes::SUBSTRATE_FAILED,
                format!(
                    "no free address in {}-{} on target '{}'",
                    settings.addresses.first, settings.addresses.last, self.target_name
                ),
            )
            .next("drain an idle pool (monolith pool drain) or widen address_range")
        })?;
        let mut vmid = None;
        for candidate in settings.vmid_low..=settings.vmid_high {
            if recorded.contains(&candidate) || visible_ids.contains(&candidate) {
                continue;
            }
            if self.vmid_free(candidate)? {
                vmid = Some(candidate);
                break;
            }
        }
        let vmid = vmid.ok_or_else(|| {
            FabricError::new(
                codes::SUBSTRATE_FAILED,
                format!("no free VMID in {}-{}", settings.vmid_low, settings.vmid_high),
            )
        })?;
        self.check_scope(vmid)?;
        let pid = std::process::id();
        let guest = PoolGuest {
            vmid,
            node: settings.node.clone(),
            tenant: tenant.to_owned(),
            address,
            state: GuestState::Cloning,
            template_version: Some(version.to_owned()),
            created_at_ms: now_ms(),
            owner_pid: Some(pid),
            owner_start: crate::process::process_start_time(pid),
            claimed_by: agent.map(str::to_owned),
            claimed_at_ms: agent.map(|_| now_ms()),
            warm: None,
        };
        locked.state.guests.push(guest.clone());
        locked.save()?;
        Ok(guest)
    }

    fn mark(&self, vmid: u32, state: GuestState, agent: Option<&str>) -> Result<(), FabricError> {
        let mut locked = self.locked()?;
        if let Some(guest) = locked.state.guests.iter_mut().find(|g| g.vmid == vmid) {
            guest.state = state;
            guest.owner_pid = None;
            guest.owner_start = None;
            if let Some(agent) = agent {
                guest.claimed_by = Some(agent.to_owned());
            }
        }
        locked.save()
    }

    /// Bind a started guest: mint the claim id and the per-guest credential,
    /// post the payload, then read it back with the credential. Returns the
    /// claim id, the credential and the authenticated status.
    fn bind(
        &self,
        guest: &PoolGuest,
        agent: &str,
        generation: u64,
        version: &str,
    ) -> Result<(String, String, Value), String> {
        let claim_id = format!("claim-{}-{}", guest.vmid, random_hex(8)?);
        self.bind_with(
            guest,
            claim_id,
            json!({
                "agent": agent,
                "tenant": guest.tenant,
                "generation": generation,
                "target": self.target_name,
                "template_version": version,
                "issued_at_ms": now_ms(),
            }),
        )
    }

    fn bind_with(&self, guest: &PoolGuest, claim_id: String, payload: Value) -> Result<(String, String, Value), String> {
        let port = self.settings().map_err(|e| e.message)?.bind_port;
        let credential = random_hex(32)?;
        let expected = hostname(guest.vmid);
        let agent_http = bind_http(Duration::from_secs(3));
        let base = format!("http://{}:{port}", guest.address);
        let mut response = agent_http
            .post(format!("{base}/bind"))
            .send_json(json!({
                "claim_id": claim_id,
                "credential": credential,
                "payload": payload,
            }))
            .map_err(|e| format!("bind request failed: {e}"))?;
        let status = response.status().as_u16();
        let body: Value = response.body_mut().read_json().unwrap_or_default();
        if status != 200 {
            return Err(format!("bind refused with HTTP {status}: {body}"));
        }
        if body.get("hostname").and_then(Value::as_str) != Some(expected.as_str()) {
            return Err(format!("the guest at {} is not {expected}: {body}", guest.address));
        }
        let mut response = agent_http
            .get(format!("{base}/status"))
            .header("Authorization", format!("Bearer {credential}"))
            .call()
            .map_err(|e| format!("status request failed: {e}"))?;
        let status = response.status().as_u16();
        let body: Value = response.body_mut().read_json().unwrap_or_default();
        if status != 200
            || body.get("state").and_then(Value::as_str) != Some("bound")
            || body.get("claim_id").and_then(Value::as_str) != Some(claim_id.as_str())
        {
            return Err(format!("the bound guest did not confirm the claim: HTTP {status} {body}"));
        }
        Ok((claim_id, credential, body))
    }
}

fn bind_http(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .proxy(None)
        .build()
        .new_agent()
}

/// Wait until the guest's bind agent answers `/health` as the expected,
/// unbound guest.
pub fn wait_for_bind_agent(address: Ipv4Addr, port: u16, hostname: &str, deadline: Instant) -> Result<(), String> {
    let agent = bind_http(Duration::from_millis(1500));
    let url = format!("http://{address}:{port}/health");
    let mut last;
    loop {
        match agent.get(&url).call() {
            Ok(mut response) => {
                let status = response.status().as_u16();
                let body: Value = response.body_mut().read_json().unwrap_or_default();
                if status == 200 && body.get("hostname").and_then(Value::as_str) == Some(hostname) {
                    if body.get("state").and_then(Value::as_str) == Some("unbound") {
                        return Ok(());
                    }
                    return Err(format!("the guest is already bound: {body}"));
                }
                last = format!("HTTP {status} {body}");
            }
            Err(error) => last = error.to_string(),
        }
        if Instant::now() > deadline {
            return Err(last);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Start `monolith pool fill` for the tenant as a detached process so the
/// pool is replenished off the request path. Only the CLI binary does this;
/// library callers (and the live suites) fill explicitly. Set
/// `MONOLITH_POOL_REFILL=0` to turn it off.
pub fn spawn_refill(target: &str, tenant: &str, warm_runtime: Option<&str>) {
    if std::env::var("MONOLITH_POOL_REFILL").as_deref() == Ok("0") {
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    if exe.file_name().and_then(|n| n.to_str()) != Some("monolith") {
        return;
    }
    let mut command = std::process::Command::new(exe);
    command.args(["pool", "fill", "--target", target, "--tenant", tenant]);
    if let Some(runtime) = warm_runtime {
        command.args(["--warm", runtime]);
    }
    let args: Vec<String> = std::env::args().collect();
    if let Some(index) = args.iter().position(|a| a == "--targets-config") {
        if let Some(path) = args.get(index + 1) {
            command.args(["--targets-config", path]);
        }
    }
    let log = pool_dir().join(format!("{target}-refill.log"));
    let output = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(&log)
        .ok();
    command.stdin(std::process::Stdio::null());
    match output {
        Some(file) => {
            let err = file.try_clone().ok();
            command.stdout(file);
            if let Some(err) = err {
                command.stderr(err);
            }
        }
        None => {
            command.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        }
    }
    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    if let Ok(mut child) = command.spawn() {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
}

fn owner_alive(guest: &PoolGuest) -> bool {
    let Some(pid) = guest.owner_pid else { return false };
    match (crate::process::process_start_time(pid), guest.owner_start) {
        (Some(now), Some(then)) => now == then,
        (Some(_), None) => true,
        (None, _) => false,
    }
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buffer = vec![0u8; bytes];
    File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buffer))
        .map_err(|e| format!("could not read /dev/urandom: {e}"))?;
    Ok(buffer.iter().map(|b| format!("{b:02x}")).collect())
}

/// Wait until the warm runtime on `address:port` answers as warm: HTTP 503
/// with `{"state": "warm"}`, which it sends only after loading and while it
/// waits for go.
fn wait_until_warm(address: Ipv4Addr, port: u16, limit: Duration) -> Result<(), String> {
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(3)))
        .http_status_as_error(false)
        .proxy(None)
        .build()
        .new_agent();
    let started = Instant::now();
    let mut last = String::from("no answer yet");
    while started.elapsed() < limit {
        match agent.get(format!("http://{address}:{port}/")).call() {
            Ok(mut response) => {
                let status = response.status().as_u16();
                let body: Value = response.body_mut().read_json().unwrap_or_default();
                if status == 503 && body["state"] == "warm" {
                    return Ok(());
                }
                last = format!("HTTP {status}: {body}");
            }
            Err(error) => last = error.to_string(),
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!("the warm runtime did not come up within {}s ({last})", limit.as_secs()))
}

fn now_ms() -> u64 {
    crate::state::timestamp_millis() as u64
}
