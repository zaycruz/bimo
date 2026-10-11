use crate::secrets::SecretSourceConfig;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fmt;
use std::path::{Path, PathBuf};

pub const TARGETS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeploymentTarget {
    Local,
    Ssh,
    Proxmox,
    Cloudflare,
}

impl DeploymentTarget {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "local" => Ok(Self::Local),
            "ssh" => Ok(Self::Ssh),
            "proxmox" => Ok(Self::Proxmox),
            "cloudflare" => Ok(Self::Cloudflare),
            other => Err(format!(
                "unsupported target '{}'. Supported values are: local, ssh, proxmox, cloudflare, or a configured target name",
                other
            )),
        }
    }
}

impl fmt::Display for DeploymentTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Local => "local",
            Self::Ssh => "ssh",
            Self::Proxmox => "proxmox",
            Self::Cloudflare => "cloudflare",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetSource {
    Autodetected,
    Configured,
    Reserved,
}

impl fmt::Display for TargetSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Autodetected => "autodetected",
            Self::Configured => "configured",
            Self::Reserved => "reserved",
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TargetsFile {
    #[serde(default = "targets_schema")]
    pub schema_version: u32,
    #[serde(default)]
    pub default_target: Option<String>,
    #[serde(default)]
    pub targets: Vec<ConfiguredTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConfiguredTarget {
    Local {
        name: String,
        #[serde(default)]
        artifact_lifecycle: ArtifactLifecycle,
        #[serde(default)]
        secret_source: SecretSourceConfig,
        /// Upstream networks each agent's credential proxy refuses to dial
        /// even when the allowlist matches. Unset keeps iron-proxy's default
        /// (loopback, link-local and cloud metadata addresses). Setting it
        /// replaces that list, for example to let agents reach a service on
        /// this host's loopback.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        upstream_deny_cidrs: Option<Vec<String>>,
    },
    Proxmox {
        name: String,
        api_url: String,
        token_env: String,
        #[serde(default)]
        cluster: Option<String>,
        #[serde(default)]
        node: Option<String>,
        #[serde(default)]
        guest_type: Option<ProxmoxGuestType>,
        #[serde(default)]
        guest_id: Option<u32>,
        #[serde(default)]
        guest_name: Option<String>,
        #[serde(default)]
        artifact_lifecycle: ArtifactLifecycle,
        #[serde(default)]
        secret_source: SecretSourceConfig,
        /// Driver fields (U5, U6). Optional so a target can be declared and
        /// listed before its driver settings exist; the driver names every
        /// missing field when it is asked to touch the cluster.
        #[serde(flatten)]
        driver: ProxmoxDriverSettings,
    },
    /// A Bimo host Worker on Cloudflare (engine/cloudflare/host). Agents run
    /// as Dynamic Workers behind its credential gateway; see
    /// docs/plans/2026-10-10-cloudflare-substrate.md.
    Cloudflare {
        name: String,
        /// The host Worker's base URL, for example
        /// `https://bimo-host.<account>.workers.dev`.
        url: String,
        /// Environment variable holding the host's operator token.
        token_env: String,
        #[serde(default)]
        artifact_lifecycle: ArtifactLifecycle,
        #[serde(default)]
        secret_source: SecretSourceConfig,
    },
}

/// Settings the Proxmox driver needs to create guests. See
/// examples/targets.toml and templates/README.md.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ProxmoxDriverSettings {
    /// The Proxmox resource pool every guest is created in. The driver token
    /// is scoped to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pool: Option<String>,
    /// VMID of the golden template (U6). Clones are linked (full=0) and made
    /// on the template's node.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_id: Option<u32>,
    /// Inclusive VMID range the driver may create or destroy. Any other VMID
    /// is refused before an API call is made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vmid_range: Option<[u32; 2]>,
    /// Bridge for each guest's eth0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bridge: Option<String>,
    /// Static addresses the driver may assign, `first-last` (no DHCP).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address_range: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix_len: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway: Option<String>,
    /// Per-tenant VLAN tag on the bridge (KTD5). When the map is non-empty a
    /// tenant without an entry is refused.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub tenant_vlans: std::collections::BTreeMap<String, u16>,
    /// Verify the API's TLS certificate. Default true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls_verify: Option<bool>,
    /// PEM file with the cluster CA (`/etc/pve/pve-root-ca.pem`) to pin
    /// instead of the public roots.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls_ca_file: Option<String>,
    /// Ready guests kept per tenant. Default 2, at most 4.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warm_pool_size: Option<u32>,
    /// Memory per guest. Default 256.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guest_memory_mb: Option<u32>,
    /// vCPUs per guest (LXC `cores`). Default: the template's (1). Runtime
    /// boot is CPU-bound, so a second core shortens time to ready.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guest_cores: Option<u32>,
    /// Port of the bind agent baked into the template. Default 7070.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bind_port: Option<u16>,
}

pub const MAX_WARM_POOL_SIZE: u32 = 4;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactLifecycle {
    Ephemeral,
    #[default]
    Persistent,
}

impl fmt::Display for ArtifactLifecycle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Ephemeral => "ephemeral",
            Self::Persistent => "persistent",
        })
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProxmoxGuestType {
    Lxc,
    Vm,
}

impl fmt::Display for ProxmoxGuestType {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Lxc => "lxc",
            Self::Vm => "vm",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeploySupport {
    Available,
    Unavailable(String),
}

impl fmt::Display for DeploySupport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Available => formatter.write_str("available"),
            Self::Unavailable(reason) => write!(formatter, "unavailable ({reason})"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedTarget {
    pub name: String,
    pub kind: DeploymentTarget,
    pub source: TargetSource,
    pub artifact_lifecycle: ArtifactLifecycle,
    pub runtime: &'static str,
    pub host_platform: Option<String>,
    pub support: DeploySupport,
    pub auth_env: Option<String>,
    pub auth_present: Option<bool>,
    pub cluster: Option<String>,
    pub node: Option<String>,
    pub guest: Option<String>,
    pub secret_source: SecretSourceConfig,
    /// The configured target as written, when it came from a targets file.
    pub configured: Option<ConfiguredTarget>,
}

impl ResolvedTarget {
    pub fn ensure_supported(&self, command: &str) -> Result<(), String> {
        match &self.support {
            DeploySupport::Available => Ok(()),
            DeploySupport::Unavailable(reason) => Err(format!(
                "target '{}' cannot run '{}': {}",
                self.name, command, reason
            )),
        }
    }

    pub fn detail_line(&self) -> String {
        let mut fields = vec![
            format!("kind={}", self.kind),
            format!("source={}", self.source),
            format!("runtime={}", self.runtime),
            format!("artifacts={}", self.artifact_lifecycle),
            format!("status={}", self.support),
        ];
        if let Some(host) = &self.host_platform {
            fields.push(format!("host={host}"));
        }
        if let Some(auth_env) = &self.auth_env {
            let state = if self.auth_present == Some(true) {
                "present"
            } else {
                "missing"
            };
            fields.push(format!("auth=env:{auth_env}({state})"));
        }
        if let Some(cluster) = &self.cluster {
            fields.push(format!("cluster={cluster}"));
        }
        if let Some(node) = &self.node {
            fields.push(format!("node={node}"));
        }
        if let Some(guest) = &self.guest {
            fields.push(format!("guest={guest}"));
        }
        fields.join(" ")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetCatalog {
    pub default_target: String,
    pub targets: Vec<ResolvedTarget>,
}

impl TargetCatalog {
    pub fn resolve(&self, requested: Option<&str>) -> Result<ResolvedTarget, String> {
        let wanted = requested.unwrap_or(&self.default_target);
        if let Some(target) = self.targets.iter().find(|target| target.name == wanted) {
            return Ok(target.clone());
        }
        if let Ok(kind) = DeploymentTarget::parse(wanted) {
            return Ok(reserved_target(kind));
        }
        let known = self
            .targets
            .iter()
            .map(|target| target.name.clone())
            .collect::<Vec<_>>()
            .join(", ");
        Err(format!(
            "unknown target '{}'. Known targets: {}",
            wanted,
            if known.is_empty() { "local".into() } else { known }
        ))
    }
}

impl crate::spec::SpecEnvironment for TargetCatalog {
    fn secret_source(&self, substrate: &str) -> Result<SecretSourceConfig, String> {
        let target = self.resolve(Some(substrate))?;
        if target.source == TargetSource::Reserved {
            return Err(format!(
                "substrate '{substrate}' is not configured; declare a named target in .bimo/targets.toml (see examples/targets.toml)"
            ));
        }
        Ok(target.secret_source)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedTargetCatalog {
    pub config_path: Option<PathBuf>,
    pub catalog: TargetCatalog,
}

pub fn load_catalog_from_cli(arguments: &[String]) -> Result<LoadedTargetCatalog, String> {
    let config_path = targets_config_path(arguments)?;
    let file = match &config_path {
        Some(path) => Some(load_targets_file(path)?),
        None => None,
    };
    let catalog = target_catalog(file.as_ref())?;
    Ok(LoadedTargetCatalog {
        config_path,
        catalog,
    })
}

pub fn requested_target_name(arguments: &[String]) -> Result<Option<String>, String> {
    option_value(arguments, "--target")
}

pub fn targets_config_path(arguments: &[String]) -> Result<Option<PathBuf>, String> {
    if let Some(path) = option_value(arguments, "--targets-config")? {
        return Ok(Some(PathBuf::from(path)));
    }
    let default_path = default_targets_path();
    if default_path.exists() {
        Ok(Some(default_path))
    } else {
        Ok(None)
    }
}

fn targets_schema() -> u32 {
    TARGETS_SCHEMA_VERSION
}

fn default_targets_path() -> PathBuf {
    crate::bimo::local_path("targets.toml")
}

fn load_targets_file(path: &Path) -> Result<TargetsFile, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| format!("could not read targets config '{}': {error}", path.display()))?;
    let file: TargetsFile = toml::from_str(&text)
        .map_err(|error| format!("invalid targets config '{}': {error}", path.display()))?;
    validate_targets_file(&file)?;
    Ok(file)
}

fn target_catalog(file: Option<&TargetsFile>) -> Result<TargetCatalog, String> {
    let mut targets = Vec::new();
    let mut names = BTreeSet::new();
    if let Some(file) = file {
        for configured in &file.targets {
            let resolved = resolve_configured_target(configured);
            if !names.insert(resolved.name.clone()) {
                return Err(format!("duplicate target name '{}'", resolved.name));
            }
            targets.push(resolved);
        }
    }
    if !names.contains("local") {
        targets.push(autodetected_local_target());
    }
    targets.sort_by(|left, right| left.name.cmp(&right.name));
    let default_target = file
        .and_then(|value| value.default_target.clone())
        .unwrap_or_else(|| "local".to_owned());
    if !targets.iter().any(|target| target.name == default_target) {
        return Err(format!(
            "default target '{}' is not declared",
            default_target
        ));
    }
    Ok(TargetCatalog {
        default_target,
        targets,
    })
}

fn resolve_configured_target(target: &ConfiguredTarget) -> ResolvedTarget {
    match target {
        ConfiguredTarget::Local {
            name,
            artifact_lifecycle,
            secret_source,
            ..
        } => {
            let detected = autodetected_local_target();
            ResolvedTarget {
                name: name.clone(),
                kind: DeploymentTarget::Local,
                source: TargetSource::Configured,
                artifact_lifecycle: *artifact_lifecycle,
                runtime: detected.runtime,
                host_platform: detected.host_platform,
                support: detected.support,
                auth_env: None,
                auth_present: None,
                cluster: None,
                node: None,
                guest: None,
                secret_source: secret_source.clone(),
                configured: Some(target.clone()),
            }
        }
        ConfiguredTarget::Proxmox {
            name,
            token_env,
            cluster,
            node,
            guest_type,
            guest_id,
            guest_name,
            artifact_lifecycle,
            secret_source,
            ..
        } => ResolvedTarget {
            name: name.clone(),
            kind: DeploymentTarget::Proxmox,
            source: TargetSource::Configured,
            artifact_lifecycle: *artifact_lifecycle,
            runtime: "remote_guest",
            host_platform: None,
            support: if std::env::var_os(token_env).is_some_and(|value| !value.is_empty()) {
                DeploySupport::Available
            } else {
                DeploySupport::Unavailable(format!(
                    "the proxmox driver needs an API token in environment variable {token_env}, which is not set"
                ))
            },
            auth_env: Some(token_env.clone()),
            auth_present: Some(std::env::var_os(token_env).is_some()),
            cluster: cluster.clone(),
            node: node.clone(),
            guest: proxmox_guest_label(*guest_type, *guest_id, guest_name.as_deref()),
            secret_source: secret_source.clone(),
            configured: Some(target.clone()),
        },
        ConfiguredTarget::Cloudflare {
            name,
            url,
            token_env,
            artifact_lifecycle,
            secret_source,
        } => ResolvedTarget {
            name: name.clone(),
            kind: DeploymentTarget::Cloudflare,
            source: TargetSource::Configured,
            artifact_lifecycle: *artifact_lifecycle,
            runtime: "dynamic_worker",
            host_platform: None,
            support: if std::env::var_os(token_env).is_some_and(|value| !value.is_empty()) {
                DeploySupport::Available
            } else {
                DeploySupport::Unavailable(format!(
                    "the cloudflare driver needs the host's operator token in environment variable {token_env}, which is not set"
                ))
            },
            auth_env: Some(token_env.clone()),
            auth_present: Some(std::env::var_os(token_env).is_some()),
            cluster: Some(url.clone()),
            node: None,
            guest: None,
            secret_source: secret_source.clone(),
            configured: Some(target.clone()),
        },
    }
}

fn autodetected_local_target() -> ResolvedTarget {
    let host = std::env::consts::OS.to_owned();
    let support = match std::env::consts::OS {
        "macos" | "linux" => DeploySupport::Available,
        _ => DeploySupport::Unavailable("local deploy requires macOS or Linux".to_owned()),
    };
    ResolvedTarget {
        name: "local".to_owned(),
        kind: DeploymentTarget::Local,
        source: TargetSource::Autodetected,
        artifact_lifecycle: ArtifactLifecycle::Persistent,
        runtime: "host_process",
        host_platform: Some(host),
        support,
        auth_env: None,
        auth_present: None,
        cluster: None,
        node: None,
        guest: None,
        secret_source: SecretSourceConfig::Env,
        configured: None,
    }
}

fn reserved_target(kind: DeploymentTarget) -> ResolvedTarget {
    let reason = match kind {
        DeploymentTarget::Local => "local target should have been autodetected".to_owned(),
        DeploymentTarget::Ssh => {
            "ssh is reserved for a future remote host adapter; configure a named target when that driver exists".to_owned()
        }
        DeploymentTarget::Proxmox => {
            "proxmox is reserved for configured cluster targets; add a named proxmox target in .bimo/targets.toml and a deploy adapter before using it".to_owned()
        }
        DeploymentTarget::Cloudflare => {
            "cloudflare is reserved for configured host Workers; add a named cloudflare target in .bimo/targets.toml (see examples/targets.toml)".to_owned()
        }
    };
    ResolvedTarget {
        name: kind.to_string(),
        kind,
        source: TargetSource::Reserved,
        artifact_lifecycle: ArtifactLifecycle::Persistent,
        runtime: match kind {
            DeploymentTarget::Local => "host_process",
            DeploymentTarget::Ssh => "remote_host",
            DeploymentTarget::Proxmox => "remote_guest",
            DeploymentTarget::Cloudflare => "dynamic_worker",
        },
        host_platform: if kind == DeploymentTarget::Local {
            Some(std::env::consts::OS.to_owned())
        } else {
            None
        },
        support: if kind == DeploymentTarget::Local {
            DeploySupport::Available
        } else {
            DeploySupport::Unavailable(reason)
        },
        auth_env: None,
        auth_present: None,
        cluster: None,
        node: None,
        guest: None,
        secret_source: SecretSourceConfig::Env,
        configured: None,
    }
}

fn proxmox_guest_label(
    guest_type: Option<ProxmoxGuestType>,
    guest_id: Option<u32>,
    guest_name: Option<&str>,
) -> Option<String> {
    match (guest_type, guest_id, guest_name) {
        (None, None, None) => None,
        (guest_type, guest_id, guest_name) => {
            let mut label = String::new();
            if let Some(guest_type) = guest_type {
                label.push_str(&guest_type.to_string());
            } else {
                label.push_str("guest");
            }
            if let Some(guest_id) = guest_id {
                label.push(':');
                label.push_str(&guest_id.to_string());
            }
            if let Some(guest_name) = guest_name {
                label.push('/');
                label.push_str(guest_name);
            }
            Some(label)
        }
    }
}

fn validate_targets_file(file: &TargetsFile) -> Result<(), String> {
    if file.schema_version != TARGETS_SCHEMA_VERSION {
        return Err(format!(
            "unsupported targets schema version {}; expected {}",
            file.schema_version, TARGETS_SCHEMA_VERSION
        ));
    }
    let mut names = BTreeSet::new();
    for target in &file.targets {
        match target {
            ConfiguredTarget::Local {
                name,
                upstream_deny_cidrs,
                ..
            } => {
                validate_target_name(name)?;
                if !names.insert(name.clone()) {
                    return Err(format!("duplicate target name '{name}'"));
                }
                for cidr in upstream_deny_cidrs.iter().flatten() {
                    validate_cidr(cidr).map_err(|error| {
                        format!("local target '{name}' has invalid upstream_deny_cidrs entry '{cidr}': {error}")
                    })?;
                }
            }
            ConfiguredTarget::Proxmox {
                name,
                api_url,
                token_env,
                guest_type,
                guest_id,
                guest_name,
                driver,
                ..
            } => {
                validate_target_name(name)?;
                validate_driver_settings(driver)
                    .map_err(|error| format!("proxmox target '{name}' {error}"))?;
                if !names.insert(name.clone()) {
                    return Err(format!("duplicate target name '{name}'"));
                }
                if api_url.trim().is_empty() {
                    return Err(format!(
                        "proxmox target '{}' requires a non-empty api_url",
                        name
                    ));
                }
                validate_env_name(token_env).map_err(|error| {
                    format!("proxmox target '{}' has invalid token_env: {error}", name)
                })?;
                if guest_id.is_some() && guest_type.is_none() {
                    return Err(format!(
                        "proxmox target '{}' must declare guest_type when guest_id is set",
                        name
                    ));
                }
                if guest_name.as_ref().is_some_and(|value| value.trim().is_empty()) {
                    return Err(format!(
                        "proxmox target '{}' guest_name must not be empty",
                        name
                    ));
                }
            }
            ConfiguredTarget::Cloudflare { name, url, token_env, .. } => {
                validate_target_name(name)?;
                if !names.insert(name.clone()) {
                    return Err(format!("duplicate target name '{name}'"));
                }
                let local = url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:");
                if !(url.starts_with("https://") || local) || url.ends_with('/') {
                    return Err(format!(
                        "cloudflare target '{name}' url must be https:// (or http:// on 127.0.0.1 or localhost for wrangler dev) without a trailing slash"
                    ));
                }
                validate_env_name(token_env).map_err(|error| {
                    format!("cloudflare target '{name}' has invalid token_env: {error}")
                })?;
            }
        }
    }
    if let Some(default_target) = &file.default_target {
        validate_target_name(default_target)?;
    }
    Ok(())
}

fn validate_driver_settings(settings: &ProxmoxDriverSettings) -> Result<(), String> {
    if let Some([low, high]) = settings.vmid_range {
        if low < 100 || low > high {
            return Err(format!("has invalid vmid_range [{low}, {high}]"));
        }
        if settings.template_id.is_some_and(|t| (low..=high).contains(&t)) {
            return Err("template_id must lie outside vmid_range".to_owned());
        }
    }
    if let Some(range) = &settings.address_range {
        crate::proxmox::network::AddressRange::parse(range)
            .map_err(|error| format!("has invalid address_range '{range}': {error}"))?;
    }
    if let Some(prefix) = settings.prefix_len {
        if prefix == 0 || prefix > 32 {
            return Err(format!("has invalid prefix_len {prefix}"));
        }
    }
    if let Some(gateway) = &settings.gateway {
        gateway
            .parse::<std::net::Ipv4Addr>()
            .map_err(|_| format!("has invalid gateway '{gateway}'"))?;
    }
    if let Some(size) = settings.warm_pool_size {
        if size > MAX_WARM_POOL_SIZE {
            return Err(format!("warm_pool_size {size} is above the cap of {MAX_WARM_POOL_SIZE}"));
        }
    }
    if let Some(cores) = settings.guest_cores {
        if cores == 0 || cores > 4 {
            return Err(format!("guest_cores {cores} must be between 1 and 4"));
        }
    }
    if settings.tls_verify == Some(false) && settings.tls_ca_file.is_some() {
        return Err("sets both tls_verify = false and tls_ca_file; pick one".to_owned());
    }
    for (tenant, vlan) in &settings.tenant_vlans {
        if *vlan == 0 || *vlan > 4094 {
            return Err(format!("has invalid VLAN {vlan} for tenant '{tenant}'"));
        }
    }
    Ok(())
}

fn validate_cidr(value: &str) -> Result<(), String> {
    let (address, prefix) = value
        .split_once('/')
        .ok_or_else(|| "expected address/prefix".to_owned())?;
    let prefix: u8 = prefix.parse().map_err(|_| "prefix is not a number".to_owned())?;
    let max = match address.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(_)) => 32,
        Ok(std::net::IpAddr::V6(_)) => 128,
        Err(_) => return Err("address is not an IP address".to_owned()),
    };
    if prefix > max {
        return Err(format!("prefix is larger than {max}"));
    }
    Ok(())
}

impl ResolvedTarget {
    /// The local target's override of the proxy's upstream deny list.
    pub fn upstream_deny_cidrs(&self) -> Option<Vec<String>> {
        match &self.configured {
            Some(ConfiguredTarget::Local {
                upstream_deny_cidrs,
                ..
            }) => upstream_deny_cidrs.clone(),
            _ => None,
        }
    }
}

fn validate_target_name(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("name must not be empty".into());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("name must not contain path separators".into());
    }
    Ok(())
}

fn validate_env_name(value: &str) -> Result<(), String> {
    if value.is_empty()
        || !value
            .chars()
            .all(|c| c == '_' || c.is_ascii_uppercase() || c.is_ascii_digit())
    {
        return Err(format!("'{value}' is not an uppercase environment variable name"));
    }
    Ok(())
}

fn option_value(arguments: &[String], flag: &str) -> Result<Option<String>, String> {
    let mut matches = arguments
        .iter()
        .enumerate()
        .filter(|(_, argument)| argument.as_str() == flag);
    let Some((index, _)) = matches.next() else {
        return Ok(None);
    };
    if matches.next().is_some() {
        return Err(format!("duplicate {flag}"));
    }
    arguments
        .get(index + 1)
        .cloned()
        .map(Some)
        .ok_or_else(|| format!("missing value for {flag}"))
}

#[cfg(test)]
mod tests {
    use super::{
        ArtifactLifecycle, ConfiguredTarget, DeploymentTarget, TargetCatalog, TargetSource,
        TargetsFile, load_catalog_from_cli, requested_target_name,
    };
    use std::fs;
    use std::path::PathBuf;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    struct TestDir(PathBuf);
    impl TestDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "monolith-targets-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self) -> &PathBuf {
            &self.0
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn defaults_to_autodetected_local_target() {
        let loaded = load_catalog_from_cli(&args(&[])).unwrap();
        let local = loaded.catalog.resolve(None).unwrap();
        assert_eq!(local.kind, DeploymentTarget::Local);
        assert_eq!(local.source, TargetSource::Autodetected);
    }

    #[test]
    fn explicit_target_name_is_returned() {
        assert_eq!(
            requested_target_name(&args(&["--target", "lab"])).unwrap(),
            Some("lab".to_owned())
        );
    }

    #[test]
    fn configured_proxmox_targets_are_listed() {
        let dir = TestDir::new("proxmox");
        let path = dir.path().join("targets.toml");
        fs::write(
            &path,
            r#"
schema_version = 1
default_target = "local"

[[targets]]
kind = "proxmox"
name = "lab"
api_url = "https://pve-node-b:8006/api2/json"
token_env = "MONOLITH_PROXMOX_TOKEN"
cluster = "homelab"
node = "pve-node-b"
guest_type = "lxc"
guest_id = 203
"#,
        )
        .unwrap();
        let loaded =
            load_catalog_from_cli(&args(&["--targets-config", path.to_str().unwrap()])).unwrap();
        let lab = loaded.catalog.resolve(Some("lab")).unwrap();
        assert_eq!(lab.kind, DeploymentTarget::Proxmox);
        assert_eq!(lab.source, TargetSource::Configured);
        assert!(lab.detail_line().contains("guest=lxc:203"));
    }

    #[test]
    fn reserved_kinds_are_still_resolvable() {
        let catalog = TargetCatalog {
            default_target: "local".to_owned(),
            targets: Vec::new(),
        };
        let proxmox = catalog.resolve(Some("proxmox")).unwrap();
        assert_eq!(proxmox.kind, DeploymentTarget::Proxmox);
        assert!(proxmox.ensure_supported("deploy").is_err());
    }

    #[test]
    fn parses_targets_file_shape() {
        let parsed: TargetsFile = toml::from_str(
            r#"
schema_version = 1
default_target = "local"

[[targets]]
kind = "local"
name = "macbook"
artifact_lifecycle = "persistent"
"#,
        )
        .unwrap();
        assert_eq!(parsed.default_target.as_deref(), Some("local"));
        assert_eq!(
            parsed.targets,
            vec![ConfiguredTarget::Local {
                name: "macbook".to_owned(),
                artifact_lifecycle: ArtifactLifecycle::Persistent,
                secret_source: crate::secrets::SecretSourceConfig::Env,
                upstream_deny_cidrs: None,
            }]
        );
    }
}
