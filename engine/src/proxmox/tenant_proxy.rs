//! The tenant proxy guest (U7 stage 2, KTD4, KTD5, KTD10).
//!
//! Each tenant's credential proxies run in one long-lived LXC guest of that
//! tenant: cloned from the golden template into the target's pool and VMID
//! range with the ownership marker, `role=proxy` and the `monolith-proxy`
//! tag, and never part of the warm pool (its record lives in
//! `<pool dir>/<target>-proxies/<tenant>.json`, mode 0600, not in the pool
//! state; pool fill, drain and claim never see it). The control plane holds
//! no iron-proxy and no relay.
//!
//! The guest is bound like any guest (payload role "proxy"), gets a bundle
//! with the supervisor (`tenant_proxy.py`) and the Linux iron-proxy build
//! through its bind agent, and runs the supervisor as the runtime user under
//! the "upstream" egress lock: it may reach public addresses and DNS, never
//! a private, link-local or carrier-grade NAT range.
//!
//! Every agent generation gets a route there: its own iron-proxy instance
//! with its own CA, secrets and allowlist (delivered over the supervisor's
//! control API, kept in tmpfs in the guest and in memory here), and a front
//! credential (route id and token) that its HTTP clients send as
//! Proxy-Authorization. The front refuses any connection without a valid
//! credential, or from another address than the route's agent guest. An
//! agent of another tenant is never given a route here, so tenant B's agents
//! cannot use tenant A's proxy guest, with or without a credential.
//!
//! Agent guests are locked to their tenant proxy's address and front port.
//! With `tenant_vlans` set, the proxy guest gets a second NIC on the tenant's
//! VLAN (no gateway) and that is the address agents are locked to; agent
//! guests attach only to that VLAN.
//!
//! A restart of the proxy guest (on pve-node-a something outside Monolith
//! restarts every new container about three minutes after its first start)
//! empties tmpfs: the binding, the supervisor and every route. The control
//! plane notices a new boot id or an unbound guest, provisions the guest
//! again (`ensure_proxy`), and the agents whose routes were lost fail closed
//! (their proxy refuses them, `status` reports the route dead) until they are
//! applied again. Secrets are never re-sent without an apply.
use super::delivery::{run_tar, GuestChannel};
use super::pool::{now_ms, pool_dir, random_hex};
use super::{hostname, ProxmoxDriver, GuestRole};
use crate::proxy::{ProxyPlan, ProxyPorts};
use crate::substrate::{codes, FabricError, GuestRef, Resource, ResourceKind};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::net::Ipv4Addr;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// The supervisor the proxy guest runs.
pub const SUPERVISOR: &str = include_str!("tenant_proxy.py");
pub const SUPERVISOR_FILE: &str = "tenant-proxy.py";
pub const IRON_PROXY_FILE: &str = "iron-proxy";
/// The supervisor's control API (also the bind agent's runtime port).
pub const CONTROL_PORT: u16 = 8080;
/// Where agents connect (Proxy-Authorization required).
pub const FRONT_PORT: u16 = 3128;
pub const PROXY_TAG: &str = "monolith-proxy";
pub const PROXY_MEMORY_MB: u32 = 384;
/// The bind agent API that knows egress modes (no relay).
pub const MIN_BIND_API: u64 = 3;
/// Route directories in the guest (tmpfs).
pub const GUEST_ROUTES_DIR: &str = "/dev/shm/monolith-proxy/routes";
/// iron-proxy 0.52.0 linux_amd64, the extracted binary (the release tarball
/// is pinned in scripts/e2e-tools.sh).
pub const IRON_PROXY_LINUX_SHA256: &str = "7ba02c22ccd7de2a53bcb173011e013d0a3a93aa918b45f61df689eee330af96";
pub const IRON_PROXY_LINUX_DEFAULT: &str = "target/e2e-tools/iron-proxy-0.52.0-linux_amd64/iron-proxy";
/// Upstream ranges the proxy guest's runtime user and every route's
/// iron-proxy refuse: loopback, link-local and cloud metadata, the private
/// ranges (the LAN, the cluster, other tenants), carrier-grade NAT (where
/// Tailscale lives) and the unique-local IPv6 range.
pub const DENY_CIDRS: &[&str] = &[
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "224.0.0.0/4",
    "::1/128",
    "fc00::/7",
    "fe80::/10",
];
const RECORD_SCHEMA: u32 = 1;
const CLONE_TIMEOUT: Duration = Duration::from_secs(240);
const RESTART_WAIT: Duration = Duration::from_secs(120);

/// The address and port an agent guest's egress lock admits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Egress {
    pub address: Ipv4Addr,
    pub port: u16,
}

impl Egress {
    /// The bind agent's `egress` object for an agent guest.
    pub fn lock(&self) -> Value {
        json!({"mode": "proxy", "address": self.address.to_string(), "port": self.port})
    }
}

impl std::fmt::Display for Egress {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}:{}", self.address, self.port)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProxyState {
    /// Reserved; being cloned or provisioned by `owner_pid`.
    Provisioning,
    Ready,
}

/// What the control plane keeps for a tenant's proxy guest. Holds the bind
/// credential and the control token: mode 0600, never printed.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProxyRecord {
    pub schema_version: u32,
    pub target: String,
    pub tenant: String,
    pub vmid: u32,
    pub node: String,
    /// `net0`: the control plane and the proxy's upstream traffic.
    pub address: Ipv4Addr,
    /// Where agents connect: `net1` on the tenant VLAN, else `address`.
    pub agent_address: Ipv4Addr,
    #[serde(default)]
    pub vlan: Option<u16>,
    #[serde(default)]
    pub template_version: Option<String>,
    pub state: ProxyState,
    #[serde(default)]
    pub owner_pid: Option<u32>,
    #[serde(default)]
    pub credential: Option<String>,
    #[serde(default)]
    pub control_token: Option<String>,
    /// The supervisor's boot id when it was provisioned; a different one
    /// means the routes it held are gone.
    #[serde(default)]
    pub boot_id: Option<String>,
    pub created_at_ms: u64,
    #[serde(default)]
    pub provisioned_at_ms: Option<u64>,
    /// How many times the guest was provisioned (more than one: it was
    /// restarted and recovered).
    #[serde(default)]
    pub provisions: u32,
}

impl std::fmt::Debug for ProxyRecord {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProxyRecord")
            .field("tenant", &self.tenant)
            .field("vmid", &self.vmid)
            .field("address", &self.address)
            .field("agent_address", &self.agent_address)
            .field("state", &self.state)
            .field("credential", &"<redacted>")
            .field("control_token", &"<redacted>")
            .finish()
    }
}

impl ProxyRecord {
    pub fn egress(&self) -> Egress {
        Egress {
            address: self.agent_address,
            port: FRONT_PORT,
        }
    }

    /// The bind agent channel (proxy guest), for audits.
    pub fn channel(&self, bind_port: u16) -> Option<GuestChannel> {
        self.credential
            .as_deref()
            .map(|credential| GuestChannel::new(self.address, bind_port, credential))
    }

    /// The public view: no credential, no token.
    pub fn summary(&self) -> Value {
        json!({
            "tenant": self.tenant,
            "vmid": self.vmid,
            "node": self.node,
            "address": self.address.to_string(),
            "agent_address": self.agent_address.to_string(),
            "front_port": FRONT_PORT,
            "vlan": self.vlan,
            "state": self.state,
            "template_version": self.template_version,
            "boot_id": self.boot_id,
            "created_at_ms": self.created_at_ms,
            "provisioned_at_ms": self.provisioned_at_ms,
            "provisions": self.provisions,
        })
    }
}

/// One agent generation's route: its id and front token. The token goes
/// only into that agent's proxy URL; the proxy guest keeps its SHA-256.
pub struct Route {
    pub id: String,
    token: String,
}

impl Route {
    pub fn new(agent: &str, generation: u64) -> Result<Self, FabricError> {
        let slug: String = super::tag_slug(agent).chars().filter(|c| *c != '_').take(32).collect();
        let suffix = random_hex(4).map_err(|e| FabricError::new(codes::PROXY_FAILED, e))?;
        let token = random_hex(24).map_err(|e| FabricError::new(codes::PROXY_FAILED, e))?;
        Ok(Self {
            id: format!("{}-g{generation}-{suffix}", slug.trim_start_matches('-')),
            token,
        })
    }

    /// `http://<route>:<token>@<proxy>:<port>`: every common client sends
    /// the userinfo as Proxy-Authorization: Basic.
    pub fn url(&self, egress: Egress) -> String {
        format!("http://{}:{}@{}:{}", self.id, self.token, egress.address, egress.port)
    }

    fn token_sha256(&self) -> String {
        sha256_hex(self.token.as_bytes())
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn http(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .proxy(None)
        .build()
        .new_agent()
}

fn proxy_error(message: impl Into<String>) -> FabricError {
    FabricError::new(codes::PROXY_FAILED, message)
}

/// Where the Linux iron-proxy build comes from: `MONOLITH_IRON_PROXY_GUEST_BIN`,
/// else the pinned download `scripts/e2e-tools.sh` makes. Its SHA-256 must
/// match the pinned build.
pub fn guest_iron_proxy() -> Result<PathBuf, FabricError> {
    let path = std::env::var_os("MONOLITH_IRON_PROXY_GUEST_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(IRON_PROXY_LINUX_DEFAULT));
    let missing = || {
        proxy_error(format!(
            "the proxy guest needs iron-proxy 0.52.0 for linux_amd64, and '{}' is not a file",
            path.display()
        ))
        .next("run sh scripts/e2e-tools.sh (it prints IRON_PROXY_LINUX_BIN) and set MONOLITH_IRON_PROXY_GUEST_BIN to that path")
    };
    let mut file = fs::File::open(&path).map_err(|_| missing())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer).map_err(|_| missing())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let got: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if got != IRON_PROXY_LINUX_SHA256 {
        return Err(proxy_error(format!(
            "'{}' is not the pinned iron-proxy 0.52.0 linux_amd64 build (sha256 {got})",
            path.display()
        ))
        .next("point MONOLITH_IRON_PROXY_GUEST_BIN at the IRON_PROXY_LINUX_BIN that scripts/e2e-tools.sh prints"));
    }
    Ok(path)
}

/// The proxy guest's bundle (supervisor and iron-proxy), packed once per
/// content and cached under the build cache.
fn proxy_bundle() -> Result<PathBuf, FabricError> {
    let binary = guest_iron_proxy()?;
    let key = sha256_hex(format!("monolith-proxy-bundle/v1\n{IRON_PROXY_LINUX_SHA256}\n{}", sha256_hex(SUPERVISOR.as_bytes())).as_bytes());
    let dir = crate::runtimes::build_cache_dir().join("proxy-bundles");
    let bundle = dir.join(format!("{}.tgz", &key[..24]));
    if bundle.is_file() {
        return Ok(bundle);
    }
    let fail = |context: &str, error: std::io::Error| FabricError::io(codes::PROXY_FAILED, context, error);
    let staging = dir.join(format!("staging-{}", std::process::id()));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|e| fail("could not stage the proxy bundle", e))?;
    let result = (|| {
        fs::write(staging.join(SUPERVISOR_FILE), SUPERVISOR).map_err(|e| fail("could not stage the supervisor", e))?;
        fs::copy(&binary, staging.join(IRON_PROXY_FILE)).map_err(|e| fail("could not stage iron-proxy", e))?;
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(staging.join(IRON_PROXY_FILE), fs::Permissions::from_mode(0o755))
            .map_err(|e| fail("could not stage iron-proxy", e))?;
        let partial = dir.join(format!("{}.tgz.{}", &key[..24], std::process::id()));
        run_tar(&["-czf"], &partial, &staging).map_err(proxy_error)?;
        fs::rename(&partial, &bundle).map_err(|e| fail("could not store the proxy bundle", e))?;
        Ok(bundle.clone())
    })();
    let _ = fs::remove_dir_all(&staging);
    result
}

/// An exclusive per-tenant lock, held while a proxy guest is provisioned or
/// taken down.
struct TenantLock {
    _file: fs::File,
}

impl ProxmoxDriver {
    fn proxies_dir(&self) -> PathBuf {
        pool_dir().join(format!("{}-proxies", self.target_name))
    }

    fn proxy_record_path(&self, tenant: &str) -> PathBuf {
        self.proxies_dir().join(format!("{}.json", super::tag_slug(tenant)))
    }

    fn tenant_lock(&self, tenant: &str) -> Result<TenantLock, FabricError> {
        let failed = |context: &str, error: std::io::Error| FabricError::io(codes::STATE_FAILED, context, error);
        let dir = self.proxies_dir();
        fs::create_dir_all(&dir).map_err(|e| failed("could not create the proxy record directory", e))?;
        let path = dir.join(format!("{}.lock", super::tag_slug(tenant)));
        crate::state::ensure_no_symlink(&path).map_err(|e| failed("unsafe proxy lock", e))?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| failed("could not open the proxy lock", e))?;
        file.lock_exclusive().map_err(|e| failed("could not lock the proxy record", e))?;
        Ok(TenantLock { _file: file })
    }

    /// The tenant's proxy record, if any (no API call).
    pub fn proxy_record(&self, tenant: &str) -> Result<Option<ProxyRecord>, FabricError> {
        read_record(&self.proxy_record_path(tenant))
    }

    /// Every tenant's proxy record on this target (reservations see these).
    pub fn proxy_records(&self) -> Vec<ProxyRecord> {
        let Ok(entries) = fs::read_dir(self.proxies_dir()) else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
            .filter_map(|e| read_record(&e.path()).ok().flatten())
            .collect()
    }

    fn save_record(&self, record: &ProxyRecord) -> Result<(), FabricError> {
        let text = serde_json::to_vec_pretty(record).unwrap_or_default();
        crate::state::atomic_write(&self.proxy_record_path(&record.tenant), &text, 0o600)
            .map_err(|e| FabricError::io(codes::STATE_FAILED, "could not write the proxy record", e))
    }

    fn drop_record(&self, tenant: &str) {
        let _ = fs::remove_file(self.proxy_record_path(tenant));
    }

    fn record_by_vmid(&self, vmid: u32) -> Option<ProxyRecord> {
        self.proxy_records().into_iter().find(|r| r.vmid == vmid)
    }

    /// The tenant's proxy guest, ready for routes: the existing one when its
    /// supervisor still answers with the boot id on record, else the same
    /// guest provisioned again (it restarted), else a new guest.
    pub fn ensure_proxy(&self, tenant: &str) -> Result<ProxyRecord, FabricError> {
        let vlan = self.tenant_vlan(tenant)?;
        let _lock = self.tenant_lock(tenant)?;
        if let Some(mut record) = self.proxy_record(tenant)? {
            if record.state == ProxyState::Ready && record.boot_id.is_some() {
                if let Ok(health) = control_health(record.address, Duration::from_millis(1500)) {
                    if health.get("boot_id").and_then(Value::as_str) == record.boot_id.as_deref() {
                        return Ok(record);
                    }
                }
            }
            match self.recover_proxy(&mut record) {
                Ok(()) => return Ok(record),
                Err(error) if error.code == codes::TARGET_UNAVAILABLE => return Err(error),
                Err(_) => {
                    // Gone, stopped or unrecoverable: replace it.
                    let _ = self.destroy_guest(record.vmid);
                    self.drop_record(tenant);
                }
            }
        }
        self.create_proxy(tenant, vlan)
    }

    /// The record's guest exists but its supervisor did not answer with the
    /// recorded boot id: wait for it (a restart in progress), then provision
    /// it again when it came back unbound, or adopt the supervisor's new
    /// boot id when only the supervisor restarted.
    fn recover_proxy(&self, record: &mut ProxyRecord) -> Result<(), FabricError> {
        let settings = self.settings()?.clone();
        if !self.guest_running(record.vmid)? {
            return Err(proxy_error(format!("proxy guest {} is not running", record.vmid)));
        }
        let deadline = Instant::now() + RESTART_WAIT;
        loop {
            match bind_health(record.address, settings.bind_port) {
                Ok(health) if health.get("hostname").and_then(Value::as_str) == Some(hostname(record.vmid).as_str()) => {
                    if health.get("state").and_then(Value::as_str) == Some("unbound") {
                        return self.provision(record);
                    }
                    if let Ok(control) = control_health(record.address, Duration::from_millis(1500)) {
                        if let Some(boot) = control.get("boot_id").and_then(Value::as_str) {
                            record.boot_id = Some(boot.to_owned());
                            record.state = ProxyState::Ready;
                            self.save_record(record)?;
                            return Ok(());
                        }
                    }
                }
                Ok(_) => return Err(proxy_error(format!("the guest at {} is not proxy guest {}", record.address, record.vmid))),
                Err(_) => {}
            }
            if Instant::now() > deadline {
                return Err(proxy_error(format!("proxy guest {} did not come back", record.vmid)));
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    fn create_proxy(&self, tenant: &str, vlan: Option<u16>) -> Result<ProxyRecord, FabricError> {
        // Fail before cloning when there is nothing to deliver.
        proxy_bundle()?;
        let settings = self.settings()?.clone();
        let version = self.template_version()?;
        let count = if vlan.is_some() { 2 } else { 1 };
        let pid = std::process::id();
        let mut created = None;
        self.reserve_slot(count, |_locked, vmid, addresses| {
            let record = ProxyRecord {
                schema_version: RECORD_SCHEMA,
                target: self.target_name.clone(),
                tenant: tenant.to_owned(),
                vmid,
                node: settings.node.clone(),
                address: addresses[0],
                agent_address: *addresses.last().unwrap_or(&addresses[0]),
                vlan,
                template_version: Some(version.clone()),
                state: ProxyState::Provisioning,
                owner_pid: Some(pid),
                credential: None,
                control_token: None,
                boot_id: None,
                created_at_ms: now_ms(),
                provisioned_at_ms: None,
                provisions: 0,
            };
            self.save_record(&record)?;
            created = Some(record);
            Ok(())
        })?;
        let mut record = created.ok_or_else(|| proxy_error("the proxy reservation recorded nothing"))?;
        let role = GuestRole::Proxy {
            agent_address: vlan.map(|_| record.agent_address),
        };
        let result = self
            .clone_guest(record.vmid, record.address, tenant, role, CLONE_TIMEOUT)
            .and_then(|()| self.provision(&mut record));
        if let Err(error) = result {
            let _ = self.destroy_guest(record.vmid);
            self.drop_record(tenant);
            return Err(error);
        }
        Ok(record)
    }

    /// Bind a started, unbound proxy guest, deliver the supervisor and
    /// iron-proxy, start the supervisor under the upstream egress lock and
    /// wait for it.
    fn provision(&self, record: &mut ProxyRecord) -> Result<(), FabricError> {
        let settings = self.settings()?.clone();
        let bundle = proxy_bundle()?;
        let failed = |message: String| proxy_error(format!("proxy guest {}: {message}", record.vmid));
        let claim_id = format!("proxy-{}-{}", record.vmid, random_hex(8).map_err(proxy_error)?);
        let (_claim, credential, status) = self
            .bind_at(
                record.address,
                record.vmid,
                claim_id,
                json!({
                    "role": "proxy",
                    "tenant": record.tenant,
                    "target": self.target_name,
                    "template_version": record.template_version,
                    "issued_at_ms": now_ms(),
                }),
            )
            .map_err(&failed)?;
        check_bind_api(&status, record.vmid, &self.target_name)?;
        record.credential = Some(credential.clone());
        let control_token = random_hex(32).map_err(proxy_error)?;
        record.control_token = Some(control_token.clone());
        record.state = ProxyState::Provisioning;
        self.save_record(record)?;
        let channel = GuestChannel::new(record.address, settings.bind_port, &credential);
        channel.put_bundle(&bundle).map_err(|e| failed(e.to_string()))?;
        let runtime = crate::runtimes::GUEST_RUNTIME_ROOT;
        let mut env = std::collections::BTreeMap::new();
        env.insert("PATH".to_owned(), "/usr/bin:/bin".to_owned());
        env.insert("HOME".to_owned(), runtime.to_owned());
        env.insert("PYTHONDONTWRITEBYTECODE".to_owned(), "1".to_owned());
        env.insert("MONOLITH_PROXY_CONTROL_PORT".to_owned(), CONTROL_PORT.to_string());
        env.insert("MONOLITH_PROXY_FRONT_PORT".to_owned(), FRONT_PORT.to_string());
        env.insert("MONOLITH_PROXY_CONTROL_SHA256".to_owned(), sha256_hex(control_token.as_bytes()));
        env.insert("MONOLITH_IRON_PROXY".to_owned(), format!("{runtime}/{IRON_PROXY_FILE}"));
        env.insert("MONOLITH_PROXY_STATE".to_owned(), "/dev/shm/monolith-proxy".to_owned());
        channel
            .start(&json!({
                "program": "/usr/bin/python3",
                "args": [format!("{runtime}/{SUPERVISOR_FILE}")],
                "env": env,
                "cwd": runtime,
                "port": CONTROL_PORT,
                "egress": {"mode": "upstream", "deny_cidrs": DENY_CIDRS},
                "require_egress_lock": true,
            }))
            .map_err(|e| failed(format!("could not start the supervisor: {e}")))?;
        let deadline = Instant::now() + Duration::from_secs(30);
        let health = loop {
            match control_health(record.address, Duration::from_secs(2)) {
                Ok(health) => break health,
                Err(error) if Instant::now() > deadline => {
                    let log = channel.log().unwrap_or_default();
                    let tail: String = log.chars().rev().take(600).collect::<Vec<_>>().into_iter().rev().collect();
                    return Err(failed(format!("the supervisor did not answer: {error}; log tail: {tail}")));
                }
                Err(_) => std::thread::sleep(Duration::from_millis(100)),
            }
        };
        record.boot_id = health.get("boot_id").and_then(Value::as_str).map(str::to_owned);
        record.state = ProxyState::Ready;
        record.owner_pid = None;
        record.provisioned_at_ms = Some(now_ms());
        record.provisions += 1;
        self.save_record(record)
    }

    /// Stop the tenant's proxy guest. Refused while it serves routes unless
    /// `force`.
    pub fn proxy_down(&self, tenant: &str, force: bool) -> Result<Value, FabricError> {
        let _lock = self.tenant_lock(tenant)?;
        let Some(record) = self.proxy_record(tenant)? else {
            return Ok(json!({"tenant": tenant, "destroyed": Value::Null}));
        };
        if !force {
            if let Ok(status) = self.control_get(&record, "/status") {
                let routes = status["routes"].as_object().map(|r| r.len()).unwrap_or(0);
                if routes > 0 {
                    return Err(FabricError::new(
                        codes::USAGE,
                        format!("tenant '{tenant}' proxy guest {} still serves {routes} route(s)", record.vmid),
                    )
                    .next("destroy the tenant's agents first (monolith agent destroy <name>), or pass --force"));
                }
            }
        }
        self.destroy_guest(record.vmid)?;
        self.drop_record(tenant);
        Ok(json!({"tenant": tenant, "destroyed": record.vmid}))
    }

    /// Every proxy record on this target (or one tenant's), with a live
    /// health check. Never shows a credential or token.
    pub fn proxy_status(&self, tenant: Option<&str>) -> Result<Vec<Value>, FabricError> {
        let records = match tenant {
            Some(tenant) => self.proxy_record(tenant)?.into_iter().collect(),
            None => self.proxy_records(),
        };
        Ok(records
            .iter()
            .map(|record| {
                let mut view = record.summary();
                let live = self.control_get(record, "/status").ok();
                view["supervisor"] = match live {
                    Some(status) => json!({
                        "boot_id": status["boot_id"],
                        "boot_matches": status["boot_id"].as_str() == record.boot_id.as_deref(),
                        "routes": status["routes"].as_object().map(|r| r.keys().cloned().collect::<Vec<_>>()),
                    }),
                    None => Value::Null,
                };
                view
            })
            .collect())
    }

    fn control_get(&self, record: &ProxyRecord, path: &str) -> Result<Value, String> {
        let token = record.control_token.as_deref().ok_or("the proxy record has no control token")?;
        let mut response = http(Duration::from_secs(5))
            .get(format!("http://{}:{CONTROL_PORT}{path}", record.address))
            .header("Authorization", format!("Bearer {token}"))
            .call()
            .map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let body: Value = response.body_mut().read_json().unwrap_or_default();
        if status != 200 {
            return Err(format!("HTTP {status}: {body}"));
        }
        Ok(body)
    }

    /// The journal resource for a route (before it exists).
    pub fn route_resource(&self, record: &ProxyRecord, route: &Route) -> Resource {
        Resource {
            kind: ResourceKind::ProxyRoute,
            id: format!("pve:{}:{}:route:{}", record.node, record.vmid, route.id),
            process: None,
            guest: Some(GuestRef {
                node: record.node.clone(),
                vmid: record.vmid,
                guest_type: "lxc".to_owned(),
                address: Some(record.address.to_string()),
                template_version: record.template_version.clone(),
            }),
        }
    }

    /// Start the agent's route in its tenant's proxy guest: the agent's own
    /// iron-proxy with its CA, secrets and allowlist, admitted only with the
    /// route's token and only from `source`.
    pub fn put_route(
        &self,
        record: &ProxyRecord,
        route: &Route,
        source: Option<Ipv4Addr>,
        plan: &ProxyPlan,
    ) -> Result<(), FabricError> {
        let token = record.control_token.as_deref().ok_or_else(|| proxy_error("the proxy record has no control token"))?;
        let files = plan
            .remote_files()
            .ok_or_else(|| proxy_error("the proxy plan holds no remote material"))?;
        let deny: Vec<String> = DENY_CIDRS.iter().map(|c| (*c).to_owned()).collect();
        let dir = Path::new(GUEST_ROUTES_DIR).join(&route.id);
        let mut last = String::new();
        for _ in 0..4 {
            let ports = random_ports()?;
            let config = plan.render_at(&dir, "127.0.0.1", ports, Some(&deny));
            let body = json!({
                "token_sha256": route.token_sha256(),
                "source": source.map(|a| a.to_string()),
                "ports": {
                    "tunnel": ports.tunnel,
                    "http": ports.http,
                    "https": ports.https,
                    "management": ports.management,
                    "metrics": ports.metrics,
                },
                "config": config,
                "files": files,
            });
            let data = serde_json::to_vec(&body).map_err(|e| proxy_error(format!("could not encode the route: {e}")))?;
            let mut response = http(Duration::from_secs(30))
                .put(format!("http://{}:{CONTROL_PORT}/routes/{}", record.address, route.id))
                .header("Authorization", format!("Bearer {token}"))
                .header("Content-Type", "application/json")
                .send(&data[..])
                .map_err(|e| proxy_error(format!("proxy guest {}: route request failed: {e}", record.vmid)))?;
            let status = response.status().as_u16();
            let reply: Value = response.body_mut().read_json().unwrap_or_default();
            match status {
                200 => return Ok(()),
                409 => last = format!("{reply}"),
                _ => {
                    return Err(proxy_error(format!(
                        "proxy guest {} refused the route with HTTP {status}: {}",
                        record.vmid,
                        reply.to_string().chars().take(600).collect::<String>()
                    )))
                }
            }
        }
        Err(proxy_error(format!("proxy guest {} had no free ports for the route: {last}", record.vmid)))
    }

    /// The route's state, or None when it (or its guest) is gone.
    fn route_state(&self, resource: &Resource) -> Result<Option<Value>, FabricError> {
        let Some((vmid, route)) = parse_route(resource) else {
            return Ok(None);
        };
        let Some(record) = self.record_by_vmid(vmid) else {
            return Ok(None);
        };
        let token = record.control_token.clone().unwrap_or_default();
        match http(Duration::from_secs(5))
            .get(format!("http://{}:{CONTROL_PORT}/routes/{route}", record.address))
            .header("Authorization", format!("Bearer {token}"))
            .call()
        {
            Ok(mut response) => {
                let status = response.status().as_u16();
                let body: Value = response.body_mut().read_json().unwrap_or_default();
                Ok((status == 200).then_some(body))
            }
            Err(_) => Ok(None),
        }
    }

    pub fn route_alive(&self, resource: &Resource) -> Result<bool, FabricError> {
        Ok(self
            .route_state(resource)?
            .is_some_and(|state| state.get("state").and_then(Value::as_str) == Some("running")))
    }

    /// Remove a route. Gone (no record, no guest, a restarted guest or
    /// supervisor, or the route itself missing) is success; a running guest
    /// whose bind agent and supervisor both stay silent is an error.
    pub fn delete_route(&self, resource: &Resource) -> Result<(), FabricError> {
        let Some((vmid, route)) = parse_route(resource) else {
            return Ok(());
        };
        let Some(record) = self.record_by_vmid(vmid) else {
            return Ok(());
        };
        let token = record.control_token.clone().unwrap_or_default();
        let attempt = http(Duration::from_secs(10))
            .delete(format!("http://{}:{CONTROL_PORT}/routes/{route}", record.address))
            .header("Authorization", format!("Bearer {token}"))
            .call();
        if let Ok(response) = &attempt {
            if response.status().as_u16() == 200 {
                return Ok(());
            }
        }
        if !self.guest_running(vmid)? {
            return Ok(());
        }
        let port = self.settings()?.bind_port;
        if bind_health(record.address, port).is_ok() {
            // The bind agent answers but the supervisor does not, or it no
            // longer knows our token: the guest or its supervisor restarted,
            // and the route went with its tmpfs.
            return Ok(());
        }
        Err(proxy_error(format!(
            "could not remove route {route} from proxy guest {vmid}: the guest runs but does not answer"
        ))
        .next("retry the destroy; if the proxy guest is wedged, monolith proxy down --force"))
    }

    /// Send rotated secret values to the agent's route; its iron-proxy
    /// reloads them without a restart.
    pub fn rotate_route(&self, resources: &[Resource], secrets: &[(String, String)]) -> Result<(), FabricError> {
        let resource = resources
            .iter()
            .find(|r| r.kind == ResourceKind::ProxyRoute)
            .ok_or_else(|| proxy_error("the agent has no proxy route on record"))?;
        let (vmid, route) = parse_route(resource).ok_or_else(|| proxy_error("the route id is malformed"))?;
        let record = self
            .record_by_vmid(vmid)
            .ok_or_else(|| proxy_error(format!("no proxy record for guest {vmid}")))?;
        let token = record.control_token.clone().unwrap_or_default();
        let files: serde_json::Map<String, Value> = secrets
            .iter()
            .map(|(env, value)| (format!("secrets/{env}.secret"), Value::String(value.clone())))
            .collect();
        let data = serde_json::to_vec(&json!({ "files": files })).map_err(|e| proxy_error(e.to_string()))?;
        let mut response = http(Duration::from_secs(15))
            .post(format!("http://{}:{CONTROL_PORT}/routes/{route}/secrets", record.address))
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json")
            .send(&data[..])
            .map_err(|e| proxy_error(format!("rotation request failed: {e}")))?;
        let status = response.status().as_u16();
        if status != 200 {
            let body = response.body_mut().read_to_string().unwrap_or_default();
            return Err(proxy_error(format!(
                "the proxy guest refused the rotation with HTTP {status}: {}; the route kept its previous values",
                body.chars().take(300).collect::<String>()
            )));
        }
        Ok(())
    }

    /// Copy the route's audit records (iron-proxy JSON log) to
    /// `<audit dir>/egress-audit.d/<route>.jsonl` and rebuild `audit_path`
    /// from every route kept there, oldest first. Best effort.
    pub fn collect_route_audit(&self, resources: &[Resource], audit_path: &Path) {
        let Some(resource) = resources.iter().find(|r| r.kind == ResourceKind::ProxyRoute) else {
            return;
        };
        let Some((vmid, route)) = parse_route(resource) else { return };
        let Some(record) = self.record_by_vmid(vmid) else { return };
        let token = record.control_token.clone().unwrap_or_default();
        let Ok(mut response) = http(Duration::from_secs(15))
            .get(format!("http://{}:{CONTROL_PORT}/routes/{route}/audit", record.address))
            .header("Authorization", format!("Bearer {token}"))
            .call()
        else {
            return;
        };
        if response.status().as_u16() != 200 {
            return;
        }
        let Ok(text) = response.body_mut().read_to_string() else { return };
        let Some(parent) = audit_path.parent() else { return };
        let kept = parent.join("egress-audit.d");
        if fs::create_dir_all(&kept).is_err() {
            return;
        }
        let _ = crate::state::atomic_write(&kept.join(format!("{route}.jsonl")), text.as_bytes(), 0o600);
        let mut parts: Vec<(std::time::SystemTime, PathBuf)> = fs::read_dir(&kept)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
            .collect();
        parts.sort();
        let mut all = Vec::new();
        for (_, path) in parts {
            if let Ok(bytes) = fs::read(&path) {
                all.extend_from_slice(&bytes);
            }
        }
        let _ = crate::state::atomic_write(audit_path, &all, 0o600);
    }
}

/// `pve:<node>:<vmid>:route:<route>` -> (vmid, route)
fn parse_route(resource: &Resource) -> Option<(u32, String)> {
    let mut parts = resource.id.split(':');
    let (Some("pve"), Some(_node), Some(vmid), Some("route"), Some(route), None) =
        (parts.next(), parts.next(), parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return None;
    };
    Some((vmid.parse().ok()?, route.to_owned()))
}

fn read_record(path: &Path) -> Result<Option<ProxyRecord>, FabricError> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|error| {
            FabricError::new(codes::STATE_FAILED, format!("proxy record {} is invalid: {error}", path.display()))
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(FabricError::io(codes::STATE_FAILED, "could not read a proxy record", error)),
    }
}

/// A guest whose bind agent predates API 3 cannot lock egress to a proxy
/// guest or run one.
pub fn check_bind_api(status: &Value, vmid: u32, target: &str) -> Result<(), FabricError> {
    let api = status.get("api").and_then(Value::as_u64).unwrap_or(0);
    if api >= MIN_BIND_API {
        return Ok(());
    }
    Err(FabricError::new(
        codes::TARGET_UNAVAILABLE,
        format!(
            "guest {vmid} runs bind agent API {api}; the tenant proxy guest needs API {MIN_BIND_API} (egress modes, no relay)"
        ),
    )
    .next("rebuild the golden template with scripts/build-template.sh (templates/README.md, 'Build it')")
    .next(format!("monolith pool drain --target {target}")))
}

fn control_health(address: Ipv4Addr, timeout: Duration) -> Result<Value, String> {
    let mut response = http(timeout)
        .get(format!("http://{address}:{CONTROL_PORT}/health"))
        .call()
        .map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let body: Value = response.body_mut().read_json().map_err(|e| e.to_string())?;
    if status != 200 || body.get("state").and_then(Value::as_str) != Some("ready") {
        return Err(format!("HTTP {status}: {body}"));
    }
    Ok(body)
}

fn bind_health(address: Ipv4Addr, port: u16) -> Result<Value, String> {
    let mut response = http(Duration::from_millis(1500))
        .get(format!("http://{address}:{port}/health"))
        .call()
        .map_err(|e| e.to_string())?;
    response.body_mut().read_json().map_err(|e| e.to_string())
}

/// Five distinct loopback ports for a route's iron-proxy listeners, picked
/// at random; the supervisor refuses ports in use and the caller retries.
fn random_ports() -> Result<ProxyPorts, FabricError> {
    let hex = random_hex(10).map_err(proxy_error)?;
    let mut ports = Vec::new();
    for chunk in hex.as_bytes().chunks(4) {
        let value = u16::from_str_radix(std::str::from_utf8(chunk).unwrap_or("0"), 16).unwrap_or(0);
        let port = 20_000 + (value % 40_000);
        if !ports.contains(&port) {
            ports.push(port);
        }
    }
    while ports.len() < 5 {
        let next = ports.last().copied().unwrap_or(20_000) + 1;
        ports.push(next);
    }
    Ok(ProxyPorts {
        tunnel: ports[0],
        http: ports[1],
        https: ports[2],
        management: ports[3],
        metrics: ports[4],
    })
}
