//! The runtime-agnostic agent spec (R1, KTD9).
//!
//! A spec names a runtime, a source, secrets by handle, an egress allowlist,
//! a tenant and a placement. Placement holds the substrate name only; every
//! substrate setting lives in the target config. Validation collects every
//! problem into one list before anything runs.
use crate::runtimes;
use crate::secrets::{self, Handle, SecretSourceConfig};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::{Path, PathBuf};

pub const SPEC_SCHEMA_VERSION: u32 = 1;

/// Field names that belong to a substrate. They are rejected anywhere in a
/// spec, including inside `placement`, with a message that says where they go.
const SUBSTRATE_FIELDS: &[&str] = &[
    "node",
    "nodes",
    "vmid",
    "guest_id",
    "guest_type",
    "template",
    "storage",
    "pool",
    "cluster",
    "api_url",
    "bridge",
    "vlan",
    "address",
    "ip",
    "instance_type",
    "region",
    "zone",
    "namespace",
    "image",
    "cores",
    "memory",
    "disk",
    "substrate",
    "target",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AgentSpec {
    pub schema_version: u32,
    pub name: String,
    pub tenant_id: String,
    pub runtime: String,
    pub source: Source,
    #[serde(default)]
    pub secrets: Vec<SecretRef>,
    pub egress: Egress,
    pub placement: Placement,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Source {
    /// A configuration directory, relative to the spec file.
    Config { path: String },
    /// A git repository at a full commit id.
    Git { repo: String, rev: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Config,
    Git,
}

impl fmt::Display for SourceKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Config => "config",
            Self::Git => "git",
        })
    }
}

impl Source {
    pub fn kind(&self) -> SourceKind {
        match self {
            Self::Config { .. } => SourceKind::Config,
            Self::Git { .. } => SourceKind::Git,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SecretRef {
    /// The environment variable the runtime reads. It receives a placeholder.
    pub env: String,
    /// `<tenant>/<name>`, resolved at apply time in the spec's tenant only.
    pub handle: String,
    /// Destination hosts the real value may be injected for. Each must be in
    /// the egress allowlist.
    pub hosts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields)]
pub struct Egress {
    #[serde(default)]
    pub allow: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Placement {
    /// A target name from the targets config, for example `local`.
    pub substrate: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SpecError {
    pub field: String,
    pub message: String,
}

impl SpecError {
    fn new(field: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            field: field.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for SpecError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.field, self.message)
    }
}

/// A validated spec plus the facts derived from its file.
#[derive(Debug, Clone)]
pub struct LoadedSpec {
    pub spec: AgentSpec,
    pub path: PathBuf,
    /// Absolute path of the config source directory, for config sources.
    pub source_dir: Option<PathBuf>,
    /// SHA-256 over the spec and the content of its config source.
    pub fingerprint: String,
}

impl LoadedSpec {
    pub fn handles(&self) -> Vec<(SecretRef, Handle)> {
        self.spec
            .secrets
            .iter()
            .filter_map(|secret| {
                Handle::parse(&secret.handle)
                    .ok()
                    .map(|handle| (secret.clone(), handle))
            })
            .collect()
    }
}

/// What validation needs to know about the outside world.
pub trait SpecEnvironment {
    /// The secret source of a target, or an error when the target is unknown.
    fn secret_source(&self, substrate: &str) -> Result<SecretSourceConfig, String>;
}

#[derive(Deserialize)]
struct RawSpec {
    schema_version: Option<i64>,
    name: Option<String>,
    tenant_id: Option<String>,
    runtime: Option<String>,
    source: Option<BTreeMap<String, toml::Value>>,
    secrets: Option<Vec<BTreeMap<String, toml::Value>>>,
    egress: Option<BTreeMap<String, toml::Value>>,
    placement: Option<BTreeMap<String, toml::Value>>,
    #[serde(flatten)]
    extra: BTreeMap<String, toml::Value>,
}

pub fn load(path: &Path, environment: &dyn SpecEnvironment) -> Result<LoadedSpec, Vec<SpecError>> {
    let text = std::fs::read_to_string(path).map_err(|error| {
        vec![SpecError::new(
            "spec",
            format!("could not read '{}': {error}", path.display()),
        )]
    })?;
    let base = path.parent().unwrap_or_else(|| Path::new("."));
    parse_and_validate(&text, path, base, environment)
}

pub fn parse_and_validate(
    text: &str,
    path: &Path,
    base: &Path,
    environment: &dyn SpecEnvironment,
) -> Result<LoadedSpec, Vec<SpecError>> {
    let raw: RawSpec = toml::from_str(text)
        .map_err(|error| vec![SpecError::new("spec", format!("not valid TOML: {error}"))])?;
    let mut errors = Vec::new();

    for key in raw.extra.keys() {
        errors.push(unexpected_field(key, false));
    }

    let schema_version = match raw.schema_version {
        Some(value) if value == i64::from(SPEC_SCHEMA_VERSION) => SPEC_SCHEMA_VERSION,
        Some(value) => {
            errors.push(SpecError::new(
                "schema_version",
                format!("unsupported schema version {value}; expected {SPEC_SCHEMA_VERSION}"),
            ));
            SPEC_SCHEMA_VERSION
        }
        None => {
            errors.push(SpecError::new(
                "schema_version",
                format!("required; set schema_version = {SPEC_SCHEMA_VERSION}"),
            ));
            SPEC_SCHEMA_VERSION
        }
    };

    let name = required_identifier(&mut errors, "name", raw.name);
    let tenant_id = required_identifier(&mut errors, "tenant_id", raw.tenant_id);

    let runtime = match raw.runtime {
        None => {
            errors.push(SpecError::new(
                "runtime",
                format!("required; one of: {}", runtimes::names().join(", ")),
            ));
            None
        }
        Some(value) => match runtimes::lookup(&value) {
            Some(adapter) => Some(adapter),
            None => {
                errors.push(SpecError::new(
                    "runtime",
                    format!(
                        "unknown runtime '{value}'; one of: {}",
                        runtimes::names().join(", ")
                    ),
                ));
                None
            }
        },
    };

    let source = parse_source(&mut errors, raw.source);
    let mut source_dir = None;
    if let (Some(adapter), Some(source)) = (runtime, source.as_ref()) {
        if !adapter.source_kinds().contains(&source.kind()) {
            errors.push(SpecError::new(
                "source.kind",
                format!(
                    "runtime '{}' takes a {} source, not {}",
                    adapter.name(),
                    adapter
                        .source_kinds()
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join(" or "),
                    source.kind()
                ),
            ));
        }
    }
    if let Some(Source::Config { path: relative }) = source.as_ref() {
        let candidate = base.join(relative);
        match std::fs::canonicalize(&candidate) {
            Ok(dir) if dir.is_dir() => source_dir = Some(dir),
            _ => errors.push(SpecError::new(
                "source.path",
                format!("config directory '{}' does not exist", candidate.display()),
            )),
        }
    }

    let egress = parse_egress(&mut errors, raw.egress);
    let placement = parse_placement(&mut errors, raw.placement);
    let secrets = parse_secrets(&mut errors, raw.secrets.unwrap_or_default());

    // Cross-field checks. They run even when other fields failed, so the
    // operator sees every problem at once.
    let allow: Vec<String> = egress.as_ref().map(|e| e.allow.clone()).unwrap_or_default();
    let secret_source = placement.as_ref().and_then(|placement| {
        match environment.secret_source(&placement.substrate) {
            Ok(source) => Some(source),
            Err(message) => {
                errors.push(SpecError::new("placement.substrate", message));
                None
            }
        }
    });
    let mut seen_env = BTreeSet::new();
    for (index, secret) in secrets.iter().enumerate() {
        let field = format!("secrets[{index}]");
        if !seen_env.insert(secret.env.clone()) {
            errors.push(SpecError::new(
                format!("{field}.env"),
                format!("environment variable {} is declared twice", secret.env),
            ));
        }
        for host in &secret.hosts {
            if !host_allowed(host, &allow) {
                errors.push(SpecError::new(
                    format!("{field}.hosts"),
                    format!(
                        "host '{host}' is not in egress.allow; a secret may only be injected for allowlisted hosts"
                    ),
                ));
            }
        }
        let handle = match Handle::parse(&secret.handle) {
            Ok(handle) => handle,
            Err(message) => {
                errors.push(SpecError::new(format!("{field}.handle"), message));
                continue;
            }
        };
        if let Some(tenant) = tenant_id.as_deref() {
            if handle.tenant != tenant {
                errors.push(SpecError::new(
                    format!("{field}.handle"),
                    format!(
                        "handle '{handle}' belongs to tenant '{}', but this spec's tenant_id is '{tenant}'; a spec may only name its own tenant's secrets",
                        handle.tenant
                    ),
                ));
                continue;
            }
        } else {
            continue;
        }
        if let Some(source) = secret_source.as_ref() {
            if let Err(error) = source.resolve(&handle) {
                errors.push(SpecError::new(format!("{field}.handle"), error.to_string()));
            }
        }
    }

    if !errors.is_empty() {
        return Err(errors);
    }
    let spec = AgentSpec {
        schema_version,
        name: name.expect("checked"),
        tenant_id: tenant_id.expect("checked"),
        runtime: runtime.expect("checked").name().to_owned(),
        source: source.expect("checked"),
        secrets,
        egress: egress.expect("checked"),
        placement: placement.expect("checked"),
    };
    let fingerprint = fingerprint(&spec, source_dir.as_deref()).map_err(|error| {
        vec![SpecError::new(
            "source.path",
            format!("could not read config source: {error}"),
        )]
    })?;
    Ok(LoadedSpec {
        spec,
        path: path.to_path_buf(),
        source_dir,
        fingerprint,
    })
}

fn unexpected_field(path: &str, in_placement: bool) -> SpecError {
    let leaf = path.rsplit('.').next().unwrap_or(path);
    if SUBSTRATE_FIELDS.contains(&leaf) {
        let message = if in_placement {
            format!(
                "substrate-specific field '{path}' is not allowed; placement holds only the substrate name, and substrate settings belong in the target config"
            )
        } else {
            format!(
                "substrate-specific field '{path}' is not allowed outside placement; name the substrate with placement.substrate and put its settings in the target config"
            )
        };
        SpecError::new(path, message)
    } else {
        SpecError::new(path, format!("unknown field '{path}'"))
    }
}

fn required_identifier(errors: &mut Vec<SpecError>, field: &str, value: Option<String>) -> Option<String> {
    match value {
        None => {
            errors.push(SpecError::new(field, "required"));
            None
        }
        Some(value) if !secrets::is_identifier(&value) => {
            errors.push(SpecError::new(
                field,
                format!(
                    "'{value}' is not valid; use 1-63 lowercase letters, digits or '-', not starting or ending with '-'"
                ),
            ));
            None
        }
        Some(value) => Some(value),
    }
}

fn take_string(
    errors: &mut Vec<SpecError>,
    table: &mut BTreeMap<String, toml::Value>,
    field: &str,
    key: &str,
) -> Option<String> {
    match table.remove(key) {
        None => {
            errors.push(SpecError::new(format!("{field}.{key}"), "required"));
            None
        }
        Some(toml::Value::String(value)) if !value.trim().is_empty() => Some(value),
        Some(_) => {
            errors.push(SpecError::new(
                format!("{field}.{key}"),
                "must be a non-empty string",
            ));
            None
        }
    }
}

fn take_string_list(
    errors: &mut Vec<SpecError>,
    table: &mut BTreeMap<String, toml::Value>,
    field: &str,
    key: &str,
    required: bool,
) -> Option<Vec<String>> {
    match table.remove(key) {
        None if required => {
            errors.push(SpecError::new(format!("{field}.{key}"), "required"));
            None
        }
        None => Some(Vec::new()),
        Some(toml::Value::Array(values)) => {
            let mut out = Vec::new();
            for value in values {
                match value {
                    toml::Value::String(text) if !text.trim().is_empty() => out.push(text),
                    _ => {
                        errors.push(SpecError::new(
                            format!("{field}.{key}"),
                            "must be a list of non-empty strings",
                        ));
                        return None;
                    }
                }
            }
            Some(out)
        }
        Some(_) => {
            errors.push(SpecError::new(
                format!("{field}.{key}"),
                "must be a list of strings",
            ));
            None
        }
    }
}

fn report_leftovers(errors: &mut Vec<SpecError>, table: BTreeMap<String, toml::Value>, field: &str, in_placement: bool) {
    for key in table.keys() {
        errors.push(unexpected_field(&format!("{field}.{key}"), in_placement));
    }
}

fn parse_source(errors: &mut Vec<SpecError>, raw: Option<BTreeMap<String, toml::Value>>) -> Option<Source> {
    let Some(mut table) = raw else {
        errors.push(SpecError::new(
            "source",
            "required; a [source] table with kind = \"config\" or kind = \"git\"",
        ));
        return None;
    };
    let kind = take_string(errors, &mut table, "source", "kind");
    let source = match kind.as_deref() {
        Some("config") => {
            let path = take_string(errors, &mut table, "source", "path");
            path.map(|path| Source::Config { path })
        }
        Some("git") => {
            let repo = take_string(errors, &mut table, "source", "repo");
            let rev = take_string(errors, &mut table, "source", "rev");
            if let Some(rev) = rev.as_ref() {
                if rev.len() != 40 || !rev.chars().all(|c| c.is_ascii_hexdigit()) {
                    errors.push(SpecError::new(
                        "source.rev",
                        format!(
                            "'{rev}' must be a full 40-character commit id so the source is immutable"
                        ),
                    ));
                }
            }
            match (repo, rev) {
                (Some(repo), Some(rev)) => Some(Source::Git {
                    repo,
                    rev: rev.to_ascii_lowercase(),
                }),
                _ => None,
            }
        }
        Some(other) => {
            errors.push(SpecError::new(
                "source.kind",
                format!("unknown source kind '{other}'; use \"config\" or \"git\""),
            ));
            None
        }
        None => None,
    };
    report_leftovers(errors, table, "source", false);
    source
}

fn parse_egress(errors: &mut Vec<SpecError>, raw: Option<BTreeMap<String, toml::Value>>) -> Option<Egress> {
    let mut table = raw.unwrap_or_default();
    let allow = take_string_list(errors, &mut table, "egress", "allow", false);
    report_leftovers(errors, table, "egress", false);
    let allow = allow?;
    let mut seen = BTreeSet::new();
    for host in &allow {
        if !valid_host_pattern(host) {
            errors.push(SpecError::new(
                "egress.allow",
                format!("'{host}' is not a hostname, '*.domain' pattern or IPv4 address"),
            ));
        }
        if !seen.insert(host.to_ascii_lowercase()) {
            errors.push(SpecError::new(
                "egress.allow",
                format!("'{host}' is listed twice"),
            ));
        }
    }
    Some(Egress {
        allow: allow.into_iter().map(|h| h.to_ascii_lowercase()).collect(),
    })
}

fn parse_placement(errors: &mut Vec<SpecError>, raw: Option<BTreeMap<String, toml::Value>>) -> Option<Placement> {
    let Some(mut table) = raw else {
        errors.push(SpecError::new(
            "placement",
            "required; a [placement] table naming the substrate, for example substrate = \"local\"",
        ));
        return None;
    };
    let substrate = take_string(errors, &mut table, "placement", "substrate");
    report_leftovers(errors, table, "placement", true);
    substrate.map(|substrate| Placement { substrate })
}

fn parse_secrets(errors: &mut Vec<SpecError>, raw: Vec<BTreeMap<String, toml::Value>>) -> Vec<SecretRef> {
    let mut out = Vec::new();
    for (index, mut table) in raw.into_iter().enumerate() {
        let field = format!("secrets[{index}]");
        let env = take_string(errors, &mut table, &field, "env");
        let handle = take_string(errors, &mut table, &field, "handle");
        let hosts = take_string_list(errors, &mut table, &field, "hosts", true);
        report_leftovers(errors, table, &field, false);
        if let Some(env) = env.as_ref() {
            if !env
                .chars()
                .all(|c| c == '_' || c.is_ascii_uppercase() || c.is_ascii_digit())
                || env.starts_with(|c: char| c.is_ascii_digit())
            {
                errors.push(SpecError::new(
                    format!("{field}.env"),
                    format!("'{env}' is not an uppercase environment variable name"),
                ));
            }
        }
        if hosts.as_ref().is_some_and(Vec::is_empty) {
            errors.push(SpecError::new(
                format!("{field}.hosts"),
                "must name at least one destination host",
            ));
        }
        if let (Some(env), Some(handle), Some(hosts)) = (env, handle, hosts) {
            out.push(SecretRef {
                env,
                handle,
                hosts: hosts.into_iter().map(|h| h.to_ascii_lowercase()).collect(),
            });
        }
    }
    out
}

fn valid_host_pattern(value: &str) -> bool {
    let host = value.strip_prefix("*.").unwrap_or(value);
    if host.parse::<std::net::Ipv4Addr>().is_ok() {
        return !value.starts_with("*.");
    }
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-')
                && !label.starts_with('-')
                && !label.ends_with('-')
        })
}

/// Whether `host` is matched by an allowlist entry. `*.example.com` matches
/// subdomains of example.com but not example.com itself.
pub fn host_allowed(host: &str, allow: &[String]) -> bool {
    let host = host.to_ascii_lowercase();
    allow.iter().any(|entry| match entry.strip_prefix("*.") {
        Some(suffix) => host.ends_with(&format!(".{suffix}")),
        None => *entry == host,
    })
}

fn fingerprint(spec: &AgentSpec, source_dir: Option<&Path>) -> std::io::Result<String> {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(spec).map_err(std::io::Error::other)?);
    if let Some(dir) = source_dir {
        let mut files = Vec::new();
        collect_files(dir, dir, &mut files)?;
        files.sort();
        for relative in files {
            hasher.update(relative.to_string_lossy().as_bytes());
            hasher.update([0]);
            hasher.update(std::fs::read(dir.join(&relative))?);
            hasher.update([0]);
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("config source must not contain symlinks: {}", entry.path().display()),
            ));
        }
        if kind.is_dir() {
            collect_files(root, &entry.path(), out)?;
        } else if kind.is_file() {
            out.push(
                entry
                    .path()
                    .strip_prefix(root)
                    .expect("inside root")
                    .to_path_buf(),
            );
        }
    }
    Ok(())
}
