//! Runtime delivery into a bound guest (U8), through the bind agent only
//! (KTD10): no SSH, no `pct exec`.
//!
//! The control plane packs the runtime's guest recipe into one tar.gz
//! bundle (the built runtime files plus the agent CA certificate, never a
//! key or a secret), uploads it with the per-guest credential, starts the
//! egress relay to the agent's credential proxy on this host, then asks the
//! bind agent to start the runtime as its unprivileged user with the proxy
//! variables pointing at the guest's loopback egress port.
use crate::process::ProcessIdentity;
use crate::runtimes::{GuestRecipe, LaunchRecipe, guest_path};
use crate::substrate::{self, CreateRequest, FabricError, Resource, ResourceJournal, ResourceKind, codes};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::net::Ipv4Addr;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// The loopback port inside the guest where the runtime's proxy variables
/// point; the bind agent carries each connection to the relay.
pub const GUEST_EGRESS_PORT: u16 = 7071;
/// Where the agent CA certificate lands in the bundle.
pub const GUEST_CA: &str = "trust/monolith-agent-ca.pem";

/// An authenticated client for one bound guest's bind agent.
pub struct GuestChannel {
    base: String,
    credential: String,
}

#[derive(Debug)]
pub enum ChannelError {
    /// The bind agent does not know the endpoint: the guest was cloned from
    /// a template that predates runtime delivery.
    Missing(String),
    Failed(String),
}

impl std::fmt::Display for ChannelError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChannelError::Missing(text) | ChannelError::Failed(text) => formatter.write_str(text),
        }
    }
}

fn http(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .proxy(None)
        .build()
        .new_agent()
}

impl GuestChannel {
    pub fn new(address: Ipv4Addr, port: u16, credential: &str) -> Self {
        Self {
            base: format!("http://{address}:{port}"),
            credential: credential.to_owned(),
        }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    fn bearer(&self) -> String {
        format!("Bearer {}", self.credential)
    }

    fn check(path: &str, mut response: ureq::http::Response<ureq::Body>) -> Result<ureq::http::Response<ureq::Body>, ChannelError> {
        let status = response.status().as_u16();
        match status {
            200..=299 => Ok(response),
            404 => Err(ChannelError::Missing(format!("{path}: the bind agent has no such endpoint"))),
            _ => {
                let body = response.body_mut().read_to_string().unwrap_or_default();
                Err(ChannelError::Failed(format!(
                    "{path}: HTTP {status}: {}",
                    body.chars().take(400).collect::<String>()
                )))
            }
        }
    }

    pub fn put_bundle(&self, bundle: &Path) -> Result<Value, ChannelError> {
        let file = fs::File::open(bundle)
            .map_err(|e| ChannelError::Failed(format!("could not open the bundle: {e}")))?;
        let response = http(Duration::from_secs(300))
            .put(format!("{}/runtime/bundle", self.base))
            .header("Authorization", self.bearer())
            .header("Content-Type", "application/gzip")
            .send(file)
            .map_err(|e| ChannelError::Failed(format!("bundle upload failed: {e}")))?;
        let mut response = Self::check("/runtime/bundle", response)?;
        Ok(response.body_mut().read_json().unwrap_or_default())
    }

    pub fn start(&self, body: &Value) -> Result<Value, ChannelError> {
        let response = http(Duration::from_secs(30))
            .post(format!("{}/runtime/start", self.base))
            .header("Authorization", self.bearer())
            .send_json(body)
            .map_err(|e| ChannelError::Failed(format!("runtime start failed: {e}")))?;
        let mut response = Self::check("/runtime/start", response)?;
        Ok(response.body_mut().read_json().unwrap_or_default())
    }

    pub fn runtime(&self) -> Result<Value, ChannelError> {
        self.get_json("/runtime")
    }

    pub fn status(&self) -> Result<Value, ChannelError> {
        self.get_json("/status")
    }

    fn get_json(&self, path: &str) -> Result<Value, ChannelError> {
        let response = http(Duration::from_secs(5))
            .get(format!("{}{path}", self.base))
            .header("Authorization", self.bearer())
            .call()
            .map_err(|e| ChannelError::Failed(format!("{path}: {e}")))?;
        let mut response = Self::check(path, response)?;
        response
            .body_mut()
            .read_json()
            .map_err(|e| ChannelError::Failed(format!("{path}: reply is not JSON: {e}")))
    }

    /// The tail of the runtime's output inside the guest.
    pub fn log(&self) -> Result<String, ChannelError> {
        let response = http(Duration::from_secs(10))
            .get(format!("{}/runtime/log", self.base))
            .header("Authorization", self.bearer())
            .call()
            .map_err(|e| ChannelError::Failed(format!("/runtime/log: {e}")))?;
        let mut response = Self::check("/runtime/log", response)?;
        response
            .body_mut()
            .read_to_string()
            .map_err(|e| ChannelError::Failed(format!("/runtime/log: {e}")))
    }

    /// Try a direct connection from inside the guest as the runtime user.
    pub fn probe_egress(&self, host: &str, port: u16) -> Result<Value, ChannelError> {
        let response = http(Duration::from_secs(30))
            .post(format!("{}/probe/egress", self.base))
            .header("Authorization", self.bearer())
            .send_json(json!({"host": host, "port": port}))
            .map_err(|e| ChannelError::Failed(format!("/probe/egress: {e}")))?;
        let mut response = Self::check("/probe/egress", response)?;
        Ok(response.body_mut().read_json().unwrap_or_default())
    }

    /// Download the guest's audit tar (writable state, every process's
    /// environment and command line) to `out`. Returns its size.
    pub fn inspect(&self, out: &Path) -> Result<u64, ChannelError> {
        let response = http(Duration::from_secs(300))
            .get(format!("{}/inspect", self.base))
            .header("Authorization", self.bearer())
            .call()
            .map_err(|e| ChannelError::Failed(format!("/inspect: {e}")))?;
        let mut response = Self::check("/inspect", response)?;
        let mut file = fs::File::create(out)
            .map_err(|e| ChannelError::Failed(format!("could not create {}: {e}", out.display())))?;
        let size = std::io::copy(&mut response.body_mut().as_reader(), &mut file)
            .map_err(|e| ChannelError::Failed(format!("/inspect: {e}")))?;
        file.flush().ok();
        Ok(size)
    }
}

fn relative(path: &str) -> Result<&Path, String> {
    let candidate = Path::new(path);
    if path.is_empty()
        || candidate
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(format!("bundle path '{path}' must be relative and stay inside the runtime root"));
    }
    Ok(candidate)
}

/// Pack the recipe's files, its empty directories and the agent CA
/// certificate into `<work_dir>/runtime-bundle.tgz`.
pub fn stage_bundle(recipe: &GuestRecipe, agent_ca: &Path, work_dir: &Path) -> Result<PathBuf, String> {
    let staging = work_dir.join("bundle-staging");
    let bundle = work_dir.join("runtime-bundle.tgz");
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_file(&bundle);
    fs::create_dir_all(&staging).map_err(|e| format!("could not create the bundle staging directory: {e}"))?;
    let result = (|| {
        for (source, target) in &recipe.files {
            let destination = staging.join(relative(target)?);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("could not stage {target}: {e}"))?;
            }
            // cp -R keeps symlinks as symlinks; the bind agent's extraction
            // refuses any that would point outside the runtime root.
            let status = Command::new("cp")
                .arg("-R")
                .arg(source)
                .arg(&destination)
                .status()
                .map_err(|e| format!("could not run cp: {e}"))?;
            if !status.success() {
                return Err(format!("could not stage {} as {target}", source.display()));
            }
        }
        for dir in &recipe.dirs {
            fs::create_dir_all(staging.join(relative(dir)?)).map_err(|e| format!("could not stage {dir}: {e}"))?;
        }
        let ca = staging.join(GUEST_CA);
        fs::create_dir_all(ca.parent().unwrap_or(&staging)).map_err(|e| format!("could not stage the CA: {e}"))?;
        fs::copy(agent_ca, &ca).map_err(|e| format!("could not stage the agent CA certificate: {e}"))?;
        let output = Command::new("tar")
            .env("COPYFILE_DISABLE", "1")
            .arg("-czf")
            .arg(&bundle)
            .arg("-C")
            .arg(&staging)
            .arg(".")
            .output()
            .map_err(|e| format!("could not run tar: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "tar failed: {}",
                String::from_utf8_lossy(&output.stderr).chars().take(400).collect::<String>()
            ));
        }
        Ok(bundle.clone())
    })();
    let _ = fs::remove_dir_all(&staging);
    result
}

/// The body of `POST /runtime/start`: the recipe plus the proxy variables,
/// which point at the guest's loopback egress port and the CA in the bundle.
pub fn start_body(recipe: &GuestRecipe, proxy_env: BTreeMap<String, String>) -> Value {
    let mut env = recipe.env.clone();
    env.extend(proxy_env);
    json!({
        "program": recipe.program,
        "args": recipe.args,
        "env": env,
        "cwd": recipe.cwd,
        "port": recipe.port,
        "egress_port": GUEST_EGRESS_PORT,
        "require_egress_lock": true,
    })
}

pub fn guest_proxy_url() -> String {
    format!("http://127.0.0.1:{GUEST_EGRESS_PORT}")
}

pub fn guest_ca_path() -> String {
    guest_path(GUEST_CA)
}

/// The `monolith` binary that runs the relay: this executable when it is the
/// CLI, otherwise `MONOLITH_BIN`.
fn monolith_bin() -> Result<PathBuf, FabricError> {
    if let Ok(exe) = std::env::current_exe() {
        if exe.file_name().and_then(|n| n.to_str()) == Some("monolith") {
            return Ok(exe);
        }
    }
    if let Some(path) = std::env::var_os("MONOLITH_BIN").map(PathBuf::from) {
        if path.is_file() {
            return Ok(path);
        }
    }
    Err(FabricError::new(
        codes::SUBSTRATE_FAILED,
        "the egress relay needs the monolith binary, and this process is not it",
    )
    .next("run through the monolith CLI, or set MONOLITH_BIN to its path"))
}

/// Start the relay between the guest's tunnel endpoint and the proxy's
/// loopback tunnel listener, journaled like any other process.
pub fn start_relay(
    request: &CreateRequest<'_>,
    journal: &mut dyn ResourceJournal,
    session: &str,
    guest: &str,
    credential_file: &Path,
    proxy_tunnel_port: u16,
) -> Result<Resource, FabricError> {
    let recipe = LaunchRecipe {
        program: monolith_bin()?,
        args: vec![
            "relay".to_owned(),
            "--guest".to_owned(),
            guest.to_owned(),
            "--credential-file".to_owned(),
            credential_file.to_string_lossy().into_owned(),
            "--upstream".to_owned(),
            proxy_tunnel_port.to_string(),
        ],
        env: BTreeMap::new(),
        cwd: request.generation_dir.to_path_buf(),
    };
    let relay_session = format!("{session}-relay");
    let pending = Resource {
        kind: ResourceKind::RelayProcess,
        id: format!("local:{relay_session}"),
        process: None,
        guest: None,
    };
    journal.touching(&pending)?;
    let identity: ProcessIdentity =
        substrate::spawn_group(&recipe, &request.generation_dir.join("relay.log"), &relay_session)
            .map_err(|error| FabricError::io(codes::PROXY_FAILED, "could not start the egress relay", error))?;
    let relay = Resource {
        process: Some(identity),
        ..pending
    };
    journal.created(&relay)?;
    Ok(relay)
}
