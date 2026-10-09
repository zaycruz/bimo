//! The substrate driver seam (KTD2, R10).
//!
//! A substrate creates, inspects and destroys the resources that make up a
//! running agent. The control plane in `fabric` owns intent, the journal and
//! readiness; a driver owns resources. `local` runs agents as supervised
//! process groups on this host; `proxmox` runs them in guests.
use crate::process::{self, ProcessIdentity};
use crate::proxy::{ProxyPlan, ProxyPorts};
use crate::runtimes::{Endpoint, GuestRecipe, LaunchRecipe};
use crate::state;
use crate::target::{DeploymentTarget, ResolvedTarget};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

/// Stable error codes. Callers match on these, never on messages.
pub mod codes {
    pub const SPEC_INVALID: &str = "spec_invalid";
    pub const TARGET_UNKNOWN: &str = "target_unknown";
    pub const TARGET_UNAVAILABLE: &str = "target_unavailable";
    pub const TENANT_CONFLICT: &str = "tenant_conflict";
    pub const NOT_FOUND: &str = "agent_not_found";
    pub const RUNTIME_UNAVAILABLE: &str = "runtime_unavailable";
    pub const SOURCE_FAILED: &str = "source_failed";
    pub const SUBSTRATE_FAILED: &str = "substrate_failed";
    /// The driver refused to touch a resource outside its scope.
    pub const SUBSTRATE_REFUSED: &str = "substrate_refused";
    pub const PROBE_FAILED: &str = "probe_failed";
    pub const RUNTIME_STATE: &str = "runtime_state_invalid";
    pub const SECRET_UNRESOLVED: &str = "secret_unresolved";
    pub const PROXY_FAILED: &str = "proxy_failed";
    pub const STATE_FAILED: &str = "state_failed";
    pub const USAGE: &str = "usage";
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FabricError {
    pub code: &'static str,
    pub message: String,
    pub next: Vec<String>,
    pub details: Vec<serde_json::Value>,
}

impl FabricError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            next: Vec::new(),
            details: Vec::new(),
        }
    }

    pub fn next(mut self, hint: impl Into<String>) -> Self {
        self.next.push(hint.into());
        self
    }

    pub fn io(code: &'static str, context: &str, error: io::Error) -> Self {
        Self::new(code, format!("{context}: {error}"))
    }
}

impl std::fmt::Display for FabricError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    /// The runtime process (local) or the runtime inside a guest.
    AgentProcess,
    /// The agent's iron-proxy instance.
    ProxyProcess,
    /// A Proxmox guest.
    Guest,
    /// Retired: the control-plane end of a guest's egress tunnel to a
    /// proxy on this host (bind agent API 2). Kept so old records load; a
    /// driver destroys one as a local process.
    RelayProcess,
    /// One agent generation's route in its tenant's proxy guest: the
    /// agent's own iron-proxy instance there and its front credential.
    ProxyRoute,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GuestRef {
    pub node: String,
    pub vmid: u32,
    pub guest_type: String,
    #[serde(default)]
    pub address: Option<String>,
    #[serde(default)]
    pub template_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Resource {
    pub kind: ResourceKind,
    /// Unique within the substrate: `local:<session>` or `pve:<node>:<vmid>`.
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<ProcessIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guest: Option<GuestRef>,
}

/// Records resource ids in the agent journal. A driver calls `touching`
/// before it creates anything and `created` once the resource exists, so a
/// crash in between leaves the id on record.
pub trait ResourceJournal {
    fn touching(&mut self, resource: &Resource) -> Result<(), FabricError>;
    fn created(&mut self, resource: &Resource) -> Result<(), FabricError>;
}

/// One step of an apply, timed from the apply request (the R3 clock).
#[derive(Debug, Clone, Serialize)]
pub struct Phase {
    pub phase: String,
    /// Milliseconds from the apply request to the end of this step.
    pub at_ms: f64,
    /// Milliseconds this step took (since the previous mark).
    pub ms: f64,
}

/// Marks the end of each apply step against the request's clock, so the
/// result shows where the time to ready went instead of one total.
pub struct PhaseClock {
    started: std::time::Instant,
    marks: std::cell::RefCell<Vec<Phase>>,
}

impl PhaseClock {
    pub fn new(started: std::time::Instant) -> Self {
        Self {
            started,
            marks: Default::default(),
        }
    }

    pub fn mark(&self, phase: &str) {
        let at = self.started.elapsed().as_secs_f64() * 1000.0;
        let mut marks = self.marks.borrow_mut();
        let previous = marks.last().map_or(0.0, |m| m.at_ms);
        marks.push(Phase {
            phase: phase.to_owned(),
            at_ms: (at * 10.0).round() / 10.0,
            ms: ((at - previous) * 10.0).round() / 10.0,
        });
    }

    pub fn elapsed(&self) -> std::time::Duration {
        self.started.elapsed()
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    pub fn phases(&self) -> Vec<Phase> {
        self.marks.borrow().clone()
    }
}

/// What a driver needs to start one agent generation.
pub struct CreateRequest<'a> {
    pub agent: &'a str,
    pub tenant: &'a str,
    /// The spec's runtime name (a `runtimes::lookup` key).
    pub runtime: &'a str,
    pub generation: u64,
    /// Per-generation directory owned by the control plane.
    pub generation_dir: &'a Path,
    pub log_path: &'a Path,
    /// Builds the runtime's launch recipe once the driver knows the port.
    pub recipe: &'a dyn Fn(&str, u16) -> Result<LaunchRecipe, FabricError>,
    /// Builds the runtime's guest recipe (guest substrates) for the port the
    /// runtime serves on inside the guest. Placeholders are already merged.
    pub guest_recipe: &'a dyn Fn(u16) -> Result<GuestRecipe, FabricError>,
    pub control_key: &'a str,
    /// The agent's credential proxy. The driver starts it before the agent,
    /// points the agent's traffic at it and confines the agent so it cannot
    /// connect anywhere else or read the proxy's files.
    pub proxy: &'a ProxyPlan,
    /// The apply's phase clock; drivers mark their own steps on it.
    pub clock: &'a PhaseClock,
}

pub struct Created {
    pub resources: Vec<Resource>,
    pub endpoint: Endpoint,
    /// A local proxy's management API, used to reload rotated secrets.
    /// None when the proxy runs elsewhere (the driver rotates through its
    /// own channel).
    pub proxy_management: Option<String>,
}

pub trait Substrate {
    fn kind(&self) -> &'static str;
    fn create(
        &self,
        request: &CreateRequest<'_>,
        journal: &mut dyn ResourceJournal,
    ) -> Result<Created, FabricError>;
    fn alive(&self, resource: &Resource) -> Result<bool, FabricError>;
    /// Remove a resource this control plane owns. Destroying something that
    /// is already gone succeeds.
    fn destroy(&self, resource: &Resource) -> Result<(), FabricError>;
    /// Copy runtime output kept on the substrate into the agent log, for a
    /// substrate whose runtime does not write `log_path` directly. Best
    /// effort: a failure leaves the log as it was.
    fn collect_logs(&self, _generation_dir: &Path, _resources: &[Resource], _log_path: &Path) {}
    /// Where this substrate runs an agent's credential proxy. A remote
    /// proxy's CA key and secrets are never written on this host.
    fn proxy_placement(&self) -> crate::proxy::Placement {
        crate::proxy::Placement::Local
    }
    /// Rotate secret values in a running agent's proxy without restarting
    /// the agent. The default rewrites a local proxy's secret files and
    /// reloads it through its management API.
    fn rotate_secrets(
        &self,
        generation_dir: &Path,
        _resources: &[Resource],
        management: Option<&str>,
        secrets: &[(String, String)],
    ) -> Result<(), FabricError> {
        let management = management.ok_or_else(|| {
            FabricError::new(
                codes::PROXY_FAILED,
                "the running agent has no credential proxy on record, so its secrets cannot be rotated in place",
            )
        })?;
        crate::proxy::rotate(&generation_dir.join("proxy"), management, secrets)
    }
    /// Copy a remote proxy's audit records into `audit_path`, for a
    /// substrate whose proxy does not write it directly. Best effort.
    fn collect_audit(&self, _resources: &[Resource], _audit_path: &Path) {}
}

/// Pick the driver for a target. Unconfigured or unusable targets fail with a
/// plain reason and a next step.
pub fn driver_for(target: &ResolvedTarget) -> Result<Box<dyn Substrate>, FabricError> {
    match target.kind {
        DeploymentTarget::Local => match &target.support {
            crate::target::DeploySupport::Available => Ok(Box::new(LocalDriver)),
            crate::target::DeploySupport::Unavailable(reason) => Err(FabricError::new(
                codes::TARGET_UNAVAILABLE,
                format!("target '{}' is unavailable: {reason}", target.name),
            )),
        },
        DeploymentTarget::Proxmox => {
            crate::proxmox::ProxmoxDriver::from_target(target).map(|d| Box::new(d) as Box<dyn Substrate>)
        }
        DeploymentTarget::Ssh => Err(FabricError::new(
            codes::TARGET_UNAVAILABLE,
            format!(
                "target '{}' is an ssh target; the ssh substrate is reserved and has no driver",
                target.name
            ),
        )
        .next("place the agent on 'local' or a configured proxmox target")),
    }
}

/// Runs each agent as a supervised process group on this host.
pub struct LocalDriver;

impl Substrate for LocalDriver {
    fn kind(&self) -> &'static str {
        "local"
    }

    fn create(
        &self,
        request: &CreateRequest<'_>,
        journal: &mut dyn ResourceJournal,
    ) -> Result<Created, FabricError> {
        let port_error =
            |error: io::Error| FabricError::io(codes::SUBSTRATE_FAILED, "could not allocate a port", error);
        let session = format!(
            "{}-g{}-{}",
            request.agent,
            request.generation,
            state::timestamp_millis()
        );

        // The proxy first: the agent must never run without its boundary.
        let (proxy, ports) = start_local_proxy(request, journal, &session)?;
        request.clock.mark("proxy_start");

        let port = free_local_port().map_err(port_error)?;
        let mut recipe = (request.recipe)("127.0.0.1", port)?;
        recipe
            .env
            .extend(request.proxy.agent_env(&format!("http://127.0.0.1:{}", ports.tunnel)));
        let recipe = confine(recipe, request, ports.tunnel)?;
        let pending = Resource {
            kind: ResourceKind::AgentProcess,
            id: format!("local:{session}"),
            process: None,
            guest: None,
        };
        journal.touching(&pending)?;
        let identity = spawn_group(&recipe, request.log_path, &session).map_err(|error| {
            FabricError::io(
                codes::SUBSTRATE_FAILED,
                &format!("could not start '{}'", recipe.program.display()),
                error,
            )
        })?;
        let resource = Resource {
            process: Some(identity),
            ..pending
        };
        journal.created(&resource)?;
        request.clock.mark("runtime_start");
        Ok(Created {
            resources: vec![proxy, resource],
            endpoint: Endpoint {
                base_url: format!("http://127.0.0.1:{port}"),
                control_key: request.control_key.to_owned(),
            },
            proxy_management: Some(format!("http://127.0.0.1:{}", ports.management)),
        })
    }

    fn alive(&self, resource: &Resource) -> Result<bool, FabricError> {
        Ok(process_alive(resource))
    }

    fn destroy(&self, resource: &Resource) -> Result<(), FabricError> {
        stop_process(resource)
    }
}

/// Whether a process resource on this host is still running.
pub fn process_alive(resource: &Resource) -> bool {
    resource
        .process
        .as_ref()
        .is_some_and(process::identity_alive)
}

/// Stop a process resource on this host. Already gone is success.
pub fn stop_process(resource: &Resource) -> Result<(), FabricError> {
    let Some(identity) = resource.process.as_ref() else {
        // Journaled before spawn and never created: nothing to stop.
        return Ok(());
    };
    if !process::identity_alive(identity) {
        return Ok(());
    }
    process::stop_group(identity, Duration::from_secs(3)).map_err(|error| {
        FabricError::io(
            codes::SUBSTRATE_FAILED,
            &format!("could not stop {}", resource.id),
            error,
        )
    })
}

/// Start the agent's iron-proxy on this host, listening on loopback only,
/// journaled before it is spawned. Returns the resource and its ports. Used
/// by every driver: the proxy, its CA key and the real secrets never leave
/// the control-plane host.
pub fn start_local_proxy(
    request: &CreateRequest<'_>,
    journal: &mut dyn ResourceJournal,
    session: &str,
) -> Result<(Resource, ProxyPorts), FabricError> {
    let port_error =
        |error: io::Error| FabricError::io(codes::SUBSTRATE_FAILED, "could not allocate a port", error);
    let ports = ProxyPorts {
        tunnel: free_local_port().map_err(port_error)?,
        http: free_local_port().map_err(port_error)?,
        https: free_local_port().map_err(port_error)?,
        management: free_local_port().map_err(port_error)?,
        metrics: free_local_port().map_err(port_error)?,
    };
    let proxy_recipe = request.proxy.launch("127.0.0.1", ports)?;
    let proxy_session = format!("{session}-proxy");
    let pending_proxy = Resource {
        kind: ResourceKind::ProxyProcess,
        id: format!("local:{proxy_session}"),
        process: None,
        guest: None,
    };
    journal.touching(&pending_proxy)?;
    let proxy_identity = spawn_group(&proxy_recipe, &request.proxy.audit_log, &proxy_session)
        .map_err(|error| FabricError::io(codes::PROXY_FAILED, "could not start iron-proxy", error))?;
    let proxy = Resource {
        process: Some(proxy_identity.clone()),
        ..pending_proxy
    };
    journal.created(&proxy)?;
    wait_for_port(ports.tunnel, &proxy_identity, Duration::from_secs(15)).map_err(|message| {
        FabricError::new(codes::PROXY_FAILED, message)
            .next(format!("monolith agent logs {} --stream egress", request.agent))
    })?;
    Ok((proxy, ports))
}

/// Start a program as the leader of a new session and process group, with a
/// cleared environment, logging to `log_path`.
pub fn spawn_group(recipe: &LaunchRecipe, log_path: &Path, session: &str) -> io::Result<ProcessIdentity> {
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent)?;
    }
    state::ensure_no_symlink(log_path)?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(log_path)?;
    fs::set_permissions(log_path, fs::Permissions::from_mode(0o600))?;
    let err = log.try_clone()?;
    let mut command = Command::new(&recipe.program);
    command
        .args(&recipe.args)
        .env_clear()
        .envs(&recipe.env)
        .current_dir(&recipe.cwd)
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(err);
    if !recipe.env.contains_key("PATH") {
        command.env("PATH", default_path(&recipe.program));
    }
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let mut child = command.spawn()?;
    let pid = child.id();
    // Reap the child if it exits while this control-plane process is still
    // running, so a dead runtime never lingers as a zombie that looks alive.
    // After the control plane exits, init reaps it instead.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    let start_time = process::process_start_time(pid)
        .ok_or_else(|| io::Error::other("could not read the started process's start time"))?;
    Ok(ProcessIdentity {
        pid,
        process_group: pid as i32,
        session: session.to_owned(),
        launch_fingerprint: session.to_owned(),
        start_time,
    })
}

fn default_path(program: &Path) -> String {
    let mut entries: Vec<PathBuf> = Vec::new();
    if let Some(dir) = program.parent() {
        entries.push(dir.to_path_buf());
    }
    for dir in ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"] {
        entries.push(PathBuf::from(dir));
    }
    std::env::join_paths(entries)
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/usr/bin:/bin".to_owned())
}

fn wait_for_port(port: u16, owner: &ProcessIdentity, timeout: Duration) -> Result<(), String> {
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if std::net::TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok() {
            return Ok(());
        }
        if !process::identity_alive(owner) {
            return Err("iron-proxy exited before its listener opened".to_owned());
        }
        if std::time::Instant::now() > deadline {
            return Err(format!(
                "iron-proxy did not open 127.0.0.1:{port} within {} ms",
                timeout.as_millis()
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Network-layer confinement for a local agent (macOS): the agent runs under
/// a sandbox profile that permits outbound connections only to its proxy's
/// listener (plus local Unix sockets) and denies reading or writing anything
/// under the state root except its own generation, and nothing in the
/// proxy's directory. A client that ignores the proxy variables therefore
/// fails to connect instead of leaking.
///
/// On Linux the local substrate has no confinement; it is a development
/// substrate there, and the proxy variables are the only routing. See
/// docs/credential-boundary.md.
fn confine(recipe: LaunchRecipe, request: &CreateRequest<'_>, proxy_port: u16) -> Result<LaunchRecipe, FabricError> {
    if !cfg!(target_os = "macos") {
        return Ok(recipe);
    }
    let canonical = |path: &Path| {
        fs::canonicalize(path).map_err(|error| {
            FabricError::io(codes::SUBSTRATE_FAILED, &format!("could not resolve {}", path.display()), error)
        })
    };
    let generation = canonical(request.generation_dir)?;
    let proxy_dir = canonical(&request.proxy.dir)?;
    // <state-root>/<agent>/gen-<n>
    let state_root = generation
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| FabricError::new(codes::SUBSTRATE_FAILED, "generation directory has no state root"))?
        .to_path_buf();
    let profile = sandbox_profile(&state_root, &generation, &proxy_dir, proxy_port);
    let profile_path = generation.join("sandbox.sb");
    state::atomic_write(&profile_path, profile.as_bytes(), 0o600)
        .map_err(|error| FabricError::io(codes::SUBSTRATE_FAILED, "could not write the sandbox profile", error))?;
    let mut args = vec![
        "-f".to_owned(),
        profile_path.to_string_lossy().into_owned(),
        recipe.program.to_string_lossy().into_owned(),
    ];
    args.extend(recipe.args);
    let mut env = recipe.env;
    if !env.contains_key("PATH") {
        env.insert("PATH".to_owned(), default_path(&recipe.program));
    }
    Ok(LaunchRecipe {
        program: PathBuf::from("/usr/bin/sandbox-exec"),
        args,
        env,
        cwd: recipe.cwd,
    })
}

fn sbpl_string(path: &Path) -> String {
    let text = path.to_string_lossy();
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        if ch == '"' || ch == '\\' {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('"');
    out
}

pub fn sandbox_profile(state_root: &Path, generation: &Path, proxy_dir: &Path, proxy_port: u16) -> String {
    format!(
        "(version 1)\n\
         (allow default)\n\
         ; Outbound network: only the agent's credential proxy.\n\
         (deny network-outbound)\n\
         (allow network-outbound (remote ip \"localhost:{proxy_port}\"))\n\
         (allow network-outbound (remote unix-socket))\n\
         ; Files: nothing under the state root except this generation,\n\
         ; and never the proxy's directory (CA key, secrets, config).\n\
         ; A rule naming an operation outranks a wildcard rule, so the\n\
         ; proxy rule names file-read-data explicitly.\n\
         (deny file-read-data file-write* (subpath {root}))\n\
         (allow file-read-data file-write* (subpath {generation}))\n\
         (deny file-read* file-read-data file-write* (subpath {proxy}))\n",
        root = sbpl_string(state_root),
        generation = sbpl_string(generation),
        proxy = sbpl_string(proxy_dir),
    )
}

pub fn free_local_port() -> io::Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}
