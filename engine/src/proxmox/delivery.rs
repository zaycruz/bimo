//! Runtime delivery into a bound guest (U8), through the bind agent only
//! (KTD10): no SSH, no `pct exec`.
//!
//! The control plane packs the runtime's guest recipe into one tar.gz
//! bundle (the built runtime files plus the agent CA certificate, never a
//! key or a secret), uploads it with the per-guest credential, then asks the
//! bind agent to start the runtime as its unprivileged user, with the proxy
//! variables naming the agent's route in its tenant's proxy guest and an
//! egress lock that admits only that proxy (`tenant_proxy.rs`).
use super::tenant_proxy::Egress;
use crate::runtimes::{GuestRecipe, WARM_GO_PATH, WarmRecipe, guest_path};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::net::Ipv4Addr;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;

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

    /// Every process in the guest: pid, uid and command line, without its
    /// environment (bind agent API 3).
    pub fn processes(&self) -> Result<Value, ChannelError> {
        self.get_json("/processes")
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
///
/// The bundle is two gzip members back to back, which `tar xzf` and the
/// bind agent's extraction read as one archive: the recipe's files without
/// the end-of-archive marker, then the per-generation CA with it. When the
/// recipe names a cache key (an eve build, for example), the first member is
/// packed once and reused, so a re-apply of the same build packs only the
/// CA.
pub fn stage_bundle(recipe: &GuestRecipe, agent_ca: &Path, work_dir: &Path) -> Result<PathBuf, String> {
    let bundle = work_dir.join("runtime-bundle.tgz");
    let _ = fs::remove_file(&bundle);
    let files_member = match &recipe.cache_key {
        Some(key) => {
            let mut digest = Sha256::new();
            digest.update(b"monolith-bundle-files/v1\n");
            digest.update(key.as_bytes());
            for (_, target) in &recipe.files {
                digest.update(b"\nfile ");
                digest.update(target.as_bytes());
            }
            for dir in &recipe.dirs {
                digest.update(b"\ndir ");
                digest.update(dir.as_bytes());
            }
            let name: String = digest.finalize().iter().map(|b| format!("{b:02x}")).collect();
            let dir = crate::runtimes::build_cache_dir().join("bundles");
            let cached = dir.join(format!("{name}.tgz"));
            if !cached.is_file() {
                fs::create_dir_all(&dir).map_err(|e| format!("could not create the bundle cache: {e}"))?;
                let partial = dir.join(format!("{name}.tgz.{}", std::process::id()));
                pack_files(recipe, work_dir, &partial)?;
                fs::rename(&partial, &cached).map_err(|e| format!("could not store the packed bundle: {e}"))?;
            }
            cached
        }
        None => {
            let member = work_dir.join("runtime-bundle-files.tgz");
            pack_files(recipe, work_dir, &member)?;
            member
        }
    };
    let ca_member = work_dir.join("runtime-bundle-ca.tgz");
    let staging = work_dir.join("bundle-ca-staging");
    let _ = fs::remove_dir_all(&staging);
    let result = (|| {
        let ca = staging.join(GUEST_CA);
        fs::create_dir_all(ca.parent().unwrap_or(&staging)).map_err(|e| format!("could not stage the CA: {e}"))?;
        fs::copy(agent_ca, &ca).map_err(|e| format!("could not stage the agent CA certificate: {e}"))?;
        run_tar(&["-czf"], &ca_member, &staging)?;
        let mut out = fs::File::create(&bundle).map_err(|e| format!("could not create the bundle: {e}"))?;
        for member in [&files_member, &ca_member] {
            let mut input = fs::File::open(member).map_err(|e| format!("could not read {}: {e}", member.display()))?;
            std::io::copy(&mut input, &mut out).map_err(|e| format!("could not write the bundle: {e}"))?;
        }
        out.flush().map_err(|e| format!("could not write the bundle: {e}"))?;
        Ok(bundle.clone())
    })();
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_file(&ca_member);
    if recipe.cache_key.is_none() {
        let _ = fs::remove_file(&files_member);
    }
    if result.is_err() {
        let _ = fs::remove_file(&bundle);
    }
    result
}

pub(super) fn run_tar(mode: &[&str], archive: &Path, dir: &Path) -> Result<(), String> {
    let output = Command::new("tar")
        .env("COPYFILE_DISABLE", "1")
        .args(mode)
        .arg(archive)
        .arg("-C")
        .arg(dir)
        .arg(".")
        .output()
        .map_err(|e| format!("could not run tar: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "tar failed: {}",
            String::from_utf8_lossy(&output.stderr).chars().take(400).collect::<String>()
        ));
    }
    Ok(())
}

/// Pack the recipe's files and directories as a gzip member that holds a
/// tar stream without its end-of-archive blocks, so another member can
/// follow it.
fn pack_files(recipe: &GuestRecipe, work_dir: &Path, out: &Path) -> Result<(), String> {
    let staging = work_dir.join("bundle-staging");
    let tar_path = work_dir.join("runtime-bundle-files.tar");
    let _ = fs::remove_dir_all(&staging);
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
        run_tar(&["-cf"], &tar_path, &staging)?;
        let data = fs::read(&tar_path).map_err(|e| format!("could not read the packed files: {e}"))?;
        let end = tar_content_len(&data)?;
        let file = fs::File::create(out).map_err(|e| format!("could not create {}: {e}", out.display()))?;
        let mut gzip = Command::new("gzip")
            .arg("-c")
            .stdin(std::process::Stdio::piped())
            .stdout(file)
            .spawn()
            .map_err(|e| format!("could not run gzip: {e}"))?;
        let mut stdin = gzip.stdin.take().ok_or("gzip has no stdin")?;
        let written = stdin.write_all(&data[..end]);
        drop(stdin);
        let status = gzip.wait().map_err(|e| format!("gzip failed: {e}"))?;
        written.map_err(|e| format!("could not compress the bundle: {e}"))?;
        if !status.success() {
            return Err(format!("gzip exited with {status}"));
        }
        Ok(())
    })();
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_file(&tar_path);
    if result.is_err() {
        let _ = fs::remove_file(out);
    }
    result
}

/// The length of a tar stream up to (not including) its end-of-archive
/// blocks: walk the 512-byte headers, skipping each entry's data.
fn tar_content_len(data: &[u8]) -> Result<usize, String> {
    let mut position = 0usize;
    while position + 512 <= data.len() {
        let header = &data[position..position + 512];
        if header.iter().all(|byte| *byte == 0) {
            return Ok(position);
        }
        let field = &header[124..136];
        let size = if field[0] & 0x80 != 0 {
            field[1..].iter().fold(0usize, |acc, byte| (acc << 8) | usize::from(*byte))
        } else {
            let text: String = field
                .iter()
                .map(|byte| *byte as char)
                .filter(|c| c.is_ascii_digit())
                .collect();
            usize::from_str_radix(if text.is_empty() { "0" } else { &text }, 8)
                .map_err(|e| format!("bad tar header size: {e}"))?
        };
        position += 512 + size.div_ceil(512) * 512;
    }
    Err("the packed files have no end-of-archive marker".to_owned())
}

/// The body of `POST /runtime/start` (bind agent API 3): the recipe plus
/// the proxy variables, which name the agent's route in its tenant proxy
/// guest and the CA in the bundle, under an egress lock that admits only
/// that proxy.
pub fn start_body(recipe: &GuestRecipe, proxy_env: BTreeMap<String, String>, egress: Egress) -> Value {
    let mut env = recipe.env.clone();
    env.extend(proxy_env);
    json!({
        "program": recipe.program,
        "args": recipe.args,
        "env": env,
        "cwd": recipe.cwd,
        "port": recipe.port,
        "egress": egress.lock(),
        "require_egress_lock": true,
    })
}

/// Pack a warm recipe's launcher files and directories into
/// `<work_dir>/warm-bundle.tgz`. Nothing agent-specific is in it.
pub fn stage_warm_bundle(recipe: &WarmRecipe, work_dir: &Path) -> Result<PathBuf, String> {
    let staging = work_dir.join("warm-staging");
    let bundle = work_dir.join("warm-bundle.tgz");
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_file(&bundle);
    let result = (|| {
        fs::create_dir_all(&staging).map_err(|e| format!("could not create the warm staging directory: {e}"))?;
        for (target, bytes) in &recipe.files {
            let destination = staging.join(relative(target)?);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("could not stage {target}: {e}"))?;
            }
            fs::write(&destination, bytes).map_err(|e| format!("could not stage {target}: {e}"))?;
        }
        for dir in &recipe.dirs {
            fs::create_dir_all(staging.join(relative(dir)?)).map_err(|e| format!("could not stage {dir}: {e}"))?;
        }
        run_tar(&["-czf"], &bundle, &staging)?;
        Ok(bundle.clone())
    })();
    let _ = fs::remove_dir_all(&staging);
    result
}

/// The body of `POST /runtime/start` for a warm runtime: its own
/// environment plus the go token, under the same egress lock as any runtime.
pub fn warm_start_body(recipe: &WarmRecipe, go_token: &str, egress: Egress) -> Value {
    let mut env = recipe.env.clone();
    env.insert("MONOLITH_WARM_TOKEN".to_owned(), go_token.to_owned());
    json!({
        "program": recipe.program,
        "args": recipe.args,
        "env": env,
        "cwd": recipe.cwd,
        "port": recipe.port,
        "egress": egress.lock(),
        "require_egress_lock": true,
    })
}

/// The most a go request may carry; larger configuration is delivered as a
/// bundle to an unwarmed guest instead.
pub const MAX_GO_BYTES: usize = 16 * 1024 * 1024;

/// The go request for a warm runtime: what the bundle and the start body
/// would have carried (the recipe's files, its directories, the agent CA,
/// the environment with the proxy variables and the working directory).
pub fn go_body(recipe: &GuestRecipe, proxy_env: BTreeMap<String, String>, agent_ca: &Path) -> Result<Value, String> {
    let mut files = serde_json::Map::new();
    let mut total = 0usize;
    let mut add = |target: String, bytes: Vec<u8>| -> Result<(), String> {
        total += bytes.len();
        if total > MAX_GO_BYTES {
            return Err(format!("the agent's files exceed {MAX_GO_BYTES} bytes, too much for a warm runtime"));
        }
        files.insert(target, Value::String(base64(&bytes)));
        Ok(())
    };
    for (source, target) in &recipe.files {
        relative(target)?;
        let mut found = Vec::new();
        walk_files(source, Path::new(target), &mut found)?;
        for (path, target) in found {
            let bytes = fs::read(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
            add(target, bytes)?;
        }
    }
    let ca = fs::read(agent_ca).map_err(|e| format!("could not read the agent CA certificate: {e}"))?;
    add(GUEST_CA.to_owned(), ca)?;
    let mut env = recipe.env.clone();
    env.extend(proxy_env);
    Ok(json!({
        "env": env,
        "cwd": recipe.cwd,
        "dirs": recipe.dirs,
        "files": files,
    }))
}

fn walk_files(source: &Path, target: &Path, out: &mut Vec<(PathBuf, String)>) -> Result<(), String> {
    let meta = fs::symlink_metadata(source).map_err(|e| format!("could not read {}: {e}", source.display()))?;
    if meta.file_type().is_symlink() {
        return Err(format!("{} is a symlink, which a warm runtime does not take", source.display()));
    }
    if meta.is_dir() {
        let mut entries: Vec<_> = fs::read_dir(source)
            .map_err(|e| format!("could not read {}: {e}", source.display()))?
            .flatten()
            .collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            walk_files(&entry.path(), &target.join(entry.file_name()), out)?;
        }
    } else {
        out.push((source.to_path_buf(), target.to_string_lossy().into_owned()));
    }
    Ok(())
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Send the go request to a warm runtime, retrying while it is still
/// loading (connection refused) until `deadline`. A wrong token or a
/// refused body is final.
pub fn send_go(address: Ipv4Addr, port: u16, go_token: &str, body: &Value, deadline: std::time::Instant) -> Result<(), String> {
    let url = format!("http://{address}:{port}{WARM_GO_PATH}");
    let data = serde_json::to_vec(body).map_err(|e| format!("could not encode the go request: {e}"))?;
    let agent = http(Duration::from_secs(30));
    loop {
        match agent
            .post(&url)
            .header("Authorization", format!("Bearer {go_token}"))
            .header("Content-Type", "application/json")
            .send(&data[..])
        {
            Ok(mut response) => {
                let status = response.status().as_u16();
                if status == 200 {
                    return Ok(());
                }
                let text = response.body_mut().read_to_string().unwrap_or_default();
                return Err(format!(
                    "the warm runtime refused go with HTTP {status}: {}",
                    text.chars().take(300).collect::<String>()
                ));
            }
            Err(error) => {
                if std::time::Instant::now() > deadline {
                    return Err(format!("the warm runtime did not take go: {error}"));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }
}

pub fn guest_ca_path() -> String {
    guest_path(GUEST_CA)
}
