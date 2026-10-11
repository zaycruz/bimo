//! Runtime adapters. Each runtime Monolith can deploy lives in this directory
//! and is listed in `ADAPTERS`; nothing outside `src/runtimes/` names a
//! specific runtime.
//!
//! An adapter supplies a launch recipe, a placeholder rule (which environment
//! variables get placeholders and in what shape) and a first-task readiness
//! probe. "Ready" means the runtime accepted a first task (KTD7).
use crate::spec::{AgentSpec, SecretRef, SourceKind};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub mod eve;
pub mod hermes;
pub mod workerd;

pub use workerd::WorkerRecipe;

/// Inputs an adapter needs to build its launch recipe.
pub struct LaunchContext<'a> {
    pub spec: &'a AgentSpec,
    /// The materialized source: a private copy of the config directory, or a
    /// checkout of the git repository at the pinned revision.
    pub source_dir: &'a Path,
    /// A writable directory owned by this agent generation.
    pub home_dir: &'a Path,
    /// Address and port the runtime must serve its task API on.
    pub bind_host: &'a str,
    pub port: u16,
    /// Bearer credential the control plane uses for the readiness probe.
    pub control_key: &'a str,
    /// True when the agent will run in a guest (only the guest recipe's
    /// files travel), false on the local substrate.
    pub guest: bool,
}

#[derive(Debug, Clone)]
pub struct LaunchRecipe {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
}

/// Where the control plane reaches a running agent.
#[derive(Debug, Clone)]
pub struct Endpoint {
    pub base_url: String,
    pub control_key: String,
}

/// Where a runtime's files land inside a substrate guest, and the port its
/// task API listens on there. The bind agent in the golden template unpacks
/// the per-agent bundle under this root and runs the runtime as an
/// unprivileged user (templates/README.md).
pub const GUEST_RUNTIME_ROOT: &str = "/srv/monolith/runtime";
pub const GUEST_RUNTIME_PORT: u16 = 8080;

/// An absolute path under the guest runtime root.
pub fn guest_path(relative: &str) -> String {
    format!("{GUEST_RUNTIME_ROOT}/{}", relative.trim_start_matches('/'))
}

/// The kind of guest a runtime needs on a guest substrate. The class picks
/// how the driver acquires the guest; delivery into it (bundle push and
/// launch through the bind agent) is the same for every class.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GuestClass {
    /// A small container cloned from the golden template and taken from the
    /// tenant's warm pool; one agent per guest.
    PooledContainer,
    /// Reserved for a heavy platform runtime: a VM created on demand, never
    /// pooled, whose one deployment hosts many agents (for example a
    /// k3s-based multiplayer platform). No driver builds this class yet; see
    /// docs/agent-spec.md, "Guest classes".
    PlatformVm,
}

/// Inputs an adapter needs to describe its runtime inside a guest.
pub struct GuestContext<'a> {
    pub spec: &'a AgentSpec,
    /// The materialized and prepared source on the control-plane host.
    pub source_dir: &'a Path,
    pub control_key: &'a str,
    /// Port the runtime must serve its task API on inside the guest.
    pub port: u16,
}

/// How a runtime is delivered into and run inside a guest. Built on the
/// control plane after `prepare`; nothing in it is a real secret (secrets
/// appear only as placeholders, added by the control plane).
#[derive(Debug, Clone)]
pub struct GuestRecipe {
    pub class: GuestClass,
    /// Control-plane files or directories, each copied to a path relative
    /// to `GUEST_RUNTIME_ROOT` in the bundle.
    pub files: Vec<(PathBuf, String)>,
    /// Empty directories to create under the root (homes, state).
    pub dirs: Vec<String>,
    /// Absolute program path inside the guest (baked into the template).
    pub program: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    /// Absolute working directory inside the guest, under the root.
    pub cwd: String,
    pub port: u16,
    /// Memory the guest needs while this runtime runs. A pooled guest with
    /// less is raised to this at claim.
    pub memory_mb: u32,
    /// Set when `files` and `dirs` are fully determined by this key (a
    /// build of a pinned revision): the driver may reuse a packed copy.
    pub cache_key: Option<String>,
}

/// Where build outputs and packed bundles are kept between applies
/// (`BIMO_BUILD_CACHE`, default `.bimo/cache`). Entries are keyed by
/// content, never by agent, and hold no secret.
pub fn build_cache_dir() -> PathBuf {
    crate::bimo::var_os("BUILD_CACHE")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::bimo::local_path("cache"))
}

/// A runtime started in a pooled guest before any agent is claimed (a warm
/// runtime). It is generic per (tenant, runtime): it holds no secret, no
/// control key and no agent configuration, and it serves no task. At claim
/// the control plane sends it one authenticated go request
/// (`WARM_GO_PATH` on its task port, bearer: the per-guest go token) with
/// the agent's files, environment and CA, and only then does it start
/// serving. See templates/README.md, "Warm runtimes".
#[derive(Debug, Clone)]
pub struct WarmRecipe {
    /// Names what the pool holds; a claim takes only a guest warmed with
    /// the same key. Changes when the launcher changes.
    pub key: String,
    /// Files written into the warm bundle, by path under the runtime root.
    pub files: Vec<(String, Vec<u8>)>,
    pub dirs: Vec<String>,
    pub program: String,
    pub args: Vec<String>,
    /// No secret and nothing agent-specific belongs here.
    pub env: BTreeMap<String, String>,
    pub cwd: String,
    pub port: u16,
    pub memory_mb: u32,
}

/// Where a warm runtime takes its go request.
pub const WARM_GO_PATH: &str = "/monolith/warm/go";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Probe {
    /// The runtime accepted the first task. Carries the task id it returned.
    Accepted(String),
    /// Not answering yet, for example the port is not open.
    NotReady(String),
    /// Answering but refusing the task; retrying will not help.
    Rejected(String),
}

pub trait RuntimeAdapter: Sync {
    /// The value of `runtime` in an agent spec.
    fn name(&self) -> &'static str;
    /// Which source kinds the runtime can launch from.
    fn source_kinds(&self) -> &'static [SourceKind];
    /// One-time build steps inside the materialized source, before launch.
    fn prepare(&self, _context: &LaunchContext<'_>) -> Result<(), String> {
        Ok(())
    }
    fn launch(&self, context: &LaunchContext<'_>) -> Result<LaunchRecipe, String>;
    /// How the runtime runs inside a guest substrate (Proxmox). A runtime
    /// without a guest recipe can only be placed on the local substrate.
    fn guest(&self, _context: &GuestContext<'_>) -> Result<GuestRecipe, String> {
        Err(format!(
            "runtime '{}' has no guest recipe, so it can only run on the local substrate",
            self.name()
        ))
    }
    /// How the runtime runs as a Cloudflare Dynamic Worker (the
    /// `cloudflare` substrate). Only runtimes made of Worker modules have
    /// one.
    fn worker(&self, _source_dir: &Path, _control_key: &str) -> Result<WorkerRecipe, String> {
        Err(format!(
            "runtime '{}' does not run as a Worker; place it on 'local' or a proxmox target",
            self.name()
        ))
    }
    /// A warm runtime the pool can start before claim, when the runtime has
    /// a generic part worth starting early. `None` (the default) means a
    /// claim delivers and starts the whole runtime.
    fn warm(&self, _port: u16) -> Option<WarmRecipe> {
        None
    }
    /// The placeholder value the agent sees in place of a secret. Its shape
    /// must keep the runtime in the auth mode a real key would select.
    fn placeholder(&self, secret: &SecretRef, nonce: &str) -> String {
        format!("monolith-placeholder-{}-{nonce}", secret.env.to_ascii_lowercase())
    }
    /// Submit a trivial first task and report whether it was accepted.
    fn probe(&self, endpoint: &Endpoint) -> Probe;
    /// After ready is recorded: wind down the probe's task (for example stop
    /// a run so it spends no model tokens). Not part of the ready clock.
    fn settle(&self, _endpoint: &Endpoint, _task_id: &str) {}
    /// After a successful probe: confirm the runtime is in the expected mode.
    /// Returns a description of what is wrong when it is not.
    fn state_check(&self, _endpoint: &Endpoint, _spec: &AgentSpec) -> Result<(), String> {
        Ok(())
    }
}

static ADAPTERS: &[&dyn RuntimeAdapter] = &[&hermes::Hermes, &eve::Eve, &workerd::Workerd];

pub fn lookup(name: &str) -> Option<&'static dyn RuntimeAdapter> {
    ADAPTERS.iter().copied().find(|adapter| adapter.name() == name)
}

pub fn names() -> Vec<&'static str> {
    ADAPTERS.iter().map(|adapter| adapter.name()).collect()
}

/// Find a runtime executable: an explicit override variable, then PATH.
/// `override_suffix` names `BIMO_<suffix>` (alias `MONOLITH_<suffix>`).
pub fn find_program(override_suffix: &str, name: &str) -> Result<PathBuf, String> {
    let override_env = format!("BIMO_{override_suffix}");
    if let Some(value) = crate::bimo::var_os(override_suffix) {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!(
            "{override_env} points at '{}', which is not a file",
            path.display()
        ));
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "runtime executable '{name}' was not found; install it or set {override_env}"
    ))
}

pub(crate) fn http_agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .proxy(None)
        .build()
        .new_agent()
}
