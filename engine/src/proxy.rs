//! The per-agent credential boundary (KTD4, U7): one iron-proxy instance per
//! agent generation, started before the agent.
//!
//! The agent holds placeholders and reaches the network only through its
//! proxy. The proxy holds the real values (one 0600 file per secret, in a
//! directory the agent cannot read), enforces the egress allowlist, swaps a
//! placeholder for its real value only on requests to that secret's declared
//! hosts, and writes an audit record for every request. TLS is intercepted
//! with a CA generated for this agent: its key never leaves the proxy
//! directory, and its name constraints admit only the allowlisted hosts.
//!
//! Secret rotation rewrites the secret files and reloads the running proxy
//! through its management API, without restarting the agent.
//!
//! Where the proxy runs is the substrate's choice (`Placement`). A local
//! proxy reads its files from the generation directory. A remote proxy (the
//! tenant's proxy guest on Proxmox) gets the CA key, the management key and
//! the secret values over its control API; on this host they stay in memory
//! (`RemoteMaterial`, redacted in Debug) and only the CA certificate, which
//! the agent trusts, is written.
pub mod config;

use crate::spec::AgentSpec;
use crate::state;
use crate::substrate::{codes, FabricError};
use rcgen::{
    BasicConstraints, CertificateParams, CidrSubnet, DistinguishedName, DnType, GeneralSubtree,
    IsCa, KeyPair, KeyUsagePurpose, NameConstraints,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Where an agent's proxy runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    /// On this host, from files in the generation directory.
    Local,
    /// Elsewhere (a proxy guest); its material is delivered over the wire.
    Remote,
}

/// The proxy material a remote proxy needs, held in memory only.
#[derive(Clone)]
pub struct RemoteMaterial {
    pub ca_cert: String,
    pub ca_key: String,
    pub secrets: Vec<(String, String)>,
}

impl std::fmt::Debug for RemoteMaterial {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RemoteMaterial")
            .field("ca_key", &"<redacted>")
            .field("secrets", &self.secrets.iter().map(|(env, _)| env).collect::<Vec<_>>())
            .finish()
    }
}

/// Everything needed to launch one agent's proxy.
#[derive(Debug, Clone)]
pub struct ProxyPlan {
    pub program: PathBuf,
    /// Proxy-private directory: CA key, secret files, management key and
    /// config. Mode 0700; the agent is denied access to it.
    pub dir: PathBuf,
    /// The CA certificate the agent trusts. Outside `dir`.
    pub agent_ca: PathBuf,
    /// Where the proxy's JSON log, including the audit records, goes.
    pub audit_log: PathBuf,
    pub management_key: String,
    pub spec: AgentSpec,
    /// Placeholder per secret env name.
    pub placeholders: BTreeMap<String, String>,
    pub upstream_deny_cidrs: Option<Vec<String>>,
    /// Set for `Placement::Remote`: nothing secret was written locally.
    pub remote: Option<RemoteMaterial>,
}

/// Listener ports a driver allocates for the proxy. Only `tunnel` is used by
/// the agent; the others bind to the same host so nothing listens on a
/// wildcard address.
#[derive(Debug, Clone, Copy)]
pub struct ProxyPorts {
    pub tunnel: u16,
    pub http: u16,
    pub https: u16,
    pub management: u16,
    pub metrics: u16,
}

pub fn find_iron_proxy() -> Result<PathBuf, FabricError> {
    crate::runtimes::find_program("IRON_PROXY_BIN", "iron-proxy").map_err(|message| {
        FabricError::new(codes::PROXY_FAILED, message)
            .next("install iron-proxy 0.52.0 (sh scripts/e2e-tools.sh prints its path) or set BIMO_IRON_PROXY_BIN")
    })
}

/// A digest of the resolved secret values, salted with the agent's control
/// key, so apply can tell a rotated value without storing it.
pub fn secrets_digest(control_key: &str, secrets: &[(String, String)]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"monolith-secrets\0");
    hasher.update(control_key.as_bytes());
    for (env, value) in secrets {
        hasher.update(b"\0");
        hasher.update(env.as_bytes());
        hasher.update(b"\0");
        hasher.update(value.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn random_hex(bytes: usize) -> Result<String, FabricError> {
    let mut buffer = vec![0u8; bytes];
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut buffer))
        .map_err(|e| FabricError::io(codes::PROXY_FAILED, "could not read randomness", e))?;
    Ok(buffer.iter().map(|b| format!("{b:02x}")).collect())
}

fn secret_file(proxy_dir: &Path, env: &str) -> PathBuf {
    proxy_dir.join("secrets").join(format!("{env}.secret"))
}

/// Write each real value to its own file, atomically. The value is the exact
/// file content, as iron-proxy reads it.
pub fn write_secret_files(proxy_dir: &Path, secrets: &[(String, String)]) -> Result<(), FabricError> {
    for (env, value) in secrets {
        state::atomic_write(&secret_file(proxy_dir, env), value.as_bytes(), 0o600)
            .map_err(|e| FabricError::io(codes::PROXY_FAILED, "could not write a secret file", e))?;
    }
    Ok(())
}

/// Re-read config and secret files in a running proxy.
pub fn reload(proxy_dir: &Path, management_url: &str) -> Result<(), FabricError> {
    let key = fs::read_to_string(proxy_dir.join("management.key"))
        .map_err(|e| FabricError::io(codes::PROXY_FAILED, "could not read the proxy management key", e))?;
    let agent = crate::runtimes::http_agent(Duration::from_secs(5));
    let response = agent
        .post(format!("{management_url}/v1/reload"))
        .header("Authorization", format!("Bearer {}", key.trim()))
        .send_empty()
        .map_err(|error| FabricError::new(codes::PROXY_FAILED, format!("proxy reload failed: {error}")))?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(FabricError::new(
            codes::PROXY_FAILED,
            format!("proxy reload answered HTTP {status}; the running proxy kept its previous configuration"),
        ));
    }
    Ok(())
}

/// Rotate secret values in a running proxy: rewrite the files, then reload.
pub fn rotate(proxy_dir: &Path, management_url: &str, secrets: &[(String, String)]) -> Result<(), FabricError> {
    write_secret_files(proxy_dir, secrets)?;
    reload(proxy_dir, management_url)
}

impl ProxyPlan {
    /// Create the per-agent CA and the management key. For a local proxy,
    /// also the proxy directory and the secret files; for a remote one, keep
    /// them in memory. Either way the agent's CA certificate is written to
    /// `trust/monolith-agent-ca.pem`.
    pub fn prepare(
        spec: &AgentSpec,
        secrets: &[(String, String)],
        placeholders: BTreeMap<String, String>,
        generation_dir: &Path,
        audit_log: PathBuf,
        upstream_deny_cidrs: Option<Vec<String>>,
        placement: Placement,
    ) -> Result<Self, FabricError> {
        let fail = |context: &str, error: std::io::Error| FabricError::io(codes::PROXY_FAILED, context, error);
        let (cert_pem, key_pem) = generate_ca(spec)?;
        verify_ca(&cert_pem, spec)?;
        let management_key = random_hex(32)?;
        let dir = generation_dir.join("proxy");
        let trust_dir = generation_dir.join("trust");
        fs::create_dir_all(&trust_dir).map_err(|e| fail("could not create the trust directory", e))?;
        let agent_ca = trust_dir.join("monolith-agent-ca.pem");
        if placement == Placement::Remote {
            // Public material only; the generation directory is rebuilt on
            // every apply, so no fsync is needed for a crash-safe record.
            fs::write(&agent_ca, cert_pem.as_bytes()).map_err(|e| fail("could not write the agent CA", e))?;
            return Ok(Self {
                program: PathBuf::new(),
                dir,
                agent_ca,
                audit_log,
                management_key,
                spec: spec.clone(),
                placeholders,
                upstream_deny_cidrs,
                remote: Some(RemoteMaterial {
                    ca_cert: cert_pem,
                    ca_key: key_pem,
                    secrets: secrets.to_vec(),
                }),
            });
        }
        let program = find_iron_proxy()?;
        fs::create_dir_all(dir.join("secrets")).map_err(|e| fail("could not create the proxy directory", e))?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| fail("could not restrict the proxy directory", e))?;
        fs::set_permissions(dir.join("secrets"), fs::Permissions::from_mode(0o700))
            .map_err(|e| fail("could not restrict the secrets directory", e))?;
        state::atomic_write(&dir.join("ca.key"), key_pem.as_bytes(), 0o600)
            .map_err(|e| fail("could not write the CA key", e))?;
        state::atomic_write(&dir.join("ca.crt"), cert_pem.as_bytes(), 0o600)
            .map_err(|e| fail("could not write the CA certificate", e))?;
        state::atomic_write(&dir.join("management.key"), management_key.as_bytes(), 0o600)
            .map_err(|e| fail("could not write the proxy management key", e))?;
        state::atomic_write(&agent_ca, cert_pem.as_bytes(), 0o644)
            .map_err(|e| fail("could not write the agent CA", e))?;
        write_secret_files(&dir, secrets)?;
        Ok(Self {
            program,
            dir,
            agent_ca,
            audit_log,
            management_key,
            spec: spec.clone(),
            placeholders,
            upstream_deny_cidrs,
            remote: None,
        })
    }

    /// The files a remote proxy needs in its route directory, by relative
    /// name. Holds the CA key and the secret values: send, never store.
    pub fn remote_files(&self) -> Option<BTreeMap<String, String>> {
        let material = self.remote.as_ref()?;
        let mut files = BTreeMap::new();
        files.insert("ca.crt".to_owned(), material.ca_cert.clone());
        files.insert("ca.key".to_owned(), material.ca_key.clone());
        files.insert("management.key".to_owned(), self.management_key.clone());
        for (env, value) in &material.secrets {
            files.insert(format!("secrets/{env}.secret"), value.clone());
        }
        Some(files)
    }

    /// The config for a proxy whose files are in `dir` on its own host.
    pub fn render_at(&self, dir: &Path, bind_host: &str, ports: ProxyPorts, deny: Option<&[String]>) -> String {
        config::render(self, dir, bind_host, ports, deny)
    }

    pub fn secret_file(&self, env: &str) -> PathBuf {
        secret_file(&self.dir, env)
    }

    pub fn config_path(&self) -> PathBuf {
        self.dir.join("iron-proxy.yaml")
    }

    /// Write the config for the given ports and return the launch recipe.
    pub fn launch(&self, bind_host: &str, ports: ProxyPorts) -> Result<crate::runtimes::LaunchRecipe, FabricError> {
        let text = config::render(self, &self.dir, bind_host, ports, None);
        state::atomic_write(&self.config_path(), text.as_bytes(), 0o600)
            .map_err(|e| FabricError::io(codes::PROXY_FAILED, "could not write the proxy config", e))?;
        let mut env = BTreeMap::new();
        env.insert("IRON_MANAGEMENT_API_KEY".to_owned(), self.management_key.clone());
        env.insert("HOME".to_owned(), self.dir.to_string_lossy().into_owned());
        Ok(crate::runtimes::LaunchRecipe {
            program: self.program.clone(),
            args: vec!["-config".to_owned(), self.config_path().to_string_lossy().into_owned()],
            env,
            cwd: self.dir.clone(),
        })
    }

    /// Environment the agent gets so its HTTP clients use the proxy and trust
    /// the proxy's CA. This is a convenience: the substrate also confines the
    /// agent's network so a client that ignores it cannot connect directly.
    pub fn agent_env(&self, proxy_url: &str) -> BTreeMap<String, String> {
        self.agent_env_with_ca(proxy_url, &self.agent_ca.to_string_lossy())
    }

    /// `agent_env` for an agent that sees the CA certificate at another path
    /// (inside a guest, where the certificate travels in the bundle).
    pub fn agent_env_with_ca(&self, proxy_url: &str, ca: &str) -> BTreeMap<String, String> {
        let ca = ca.to_owned();
        let mut env = BTreeMap::new();
        for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"] {
            env.insert(key.to_owned(), proxy_url.to_owned());
        }
        env.insert("NO_PROXY".to_owned(), String::new());
        env.insert("no_proxy".to_owned(), String::new());
        // Node's built-in fetch ignores proxy variables unless told to.
        env.insert("NODE_USE_ENV_PROXY".to_owned(), "1".to_owned());
        for key in ["SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"] {
            env.insert(key.to_owned(), ca.clone());
        }
        env
    }
}

/// Civil date from days since 1970-01-01 (proleptic Gregorian).
fn civil_from_days(days: i64) -> (i32, u8, u8) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u8;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u8;
    let year = (yoe + era * 400 + i64::from(month <= 2)) as i32;
    (year, month, day)
}

/// A CA for one agent: critical CA:TRUE with path length 0, critical key
/// usage limited to certificate and CRL signing, and name constraints that
/// admit only the spec's allowlisted hosts. Valid from yesterday for 30 days.
fn generate_ca(spec: &AgentSpec) -> Result<(String, String), FabricError> {
    let fail = |error: rcgen::Error| FabricError::new(codes::PROXY_FAILED, format!("could not generate the agent CA: {error}"));
    let key = KeyPair::generate().map_err(fail)?;
    let mut params = CertificateParams::default();
    let mut name = DistinguishedName::new();
    name.push(DnType::CommonName, format!("Monolith agent CA {}/{}", spec.tenant_id, spec.name));
    name.push(DnType::OrganizationName, "Monolith");
    params.distinguished_name = name;
    params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    params.name_constraints = Some(NameConstraints {
        permitted_subtrees: permitted_subtrees(&spec.egress.allow),
        excluded_subtrees: Vec::new(),
    });
    let today = (state::timestamp_millis() / 86_400_000) as i64;
    let (y, m, d) = civil_from_days(today - 1);
    params.not_before = rcgen::date_time_ymd(y, m, d);
    let (y, m, d) = civil_from_days(today + 30);
    params.not_after = rcgen::date_time_ymd(y, m, d);
    let cert = params.self_signed(&key).map_err(fail)?;
    Ok((cert.pem(), key.serialize_pem()))
}

fn constraint_host(entry: &str) -> &str {
    entry.strip_prefix("*.").unwrap_or(entry)
}

fn permitted_subtrees(allow: &[String]) -> Vec<GeneralSubtree> {
    let mut subtrees = Vec::new();
    let mut has_ip = false;
    for entry in allow {
        if let Ok(ip) = entry.parse::<std::net::Ipv4Addr>() {
            has_ip = true;
            subtrees.push(GeneralSubtree::IpAddress(CidrSubnet::from_v4_prefix(ip.octets(), 32)));
        } else {
            subtrees.push(GeneralSubtree::DnsName(constraint_host(entry).to_owned()));
        }
    }
    if !has_ip {
        // With no IP subtree, IP names would be unconstrained. Permit only
        // 0.0.0.0/32 so no certificate for a real IP address validates.
        subtrees.push(GeneralSubtree::IpAddress(CidrSubnet::from_v4_prefix([0, 0, 0, 0], 32)));
    }
    subtrees
}

/// Confirm the generated CA has the flags the boundary relies on.
pub fn verify_ca(pem: &str, spec: &AgentSpec) -> Result<(), FabricError> {
    use x509_parser::extensions::{GeneralName, ParsedExtension};
    let fail = |message: String| FabricError::new(codes::PROXY_FAILED, format!("agent CA check failed: {message}"));
    let (_, block) = x509_parser::pem::parse_x509_pem(pem.as_bytes()).map_err(|e| fail(e.to_string()))?;
    let cert = block.parse_x509().map_err(|e| fail(e.to_string()))?;
    let mut ca_ok = false;
    let mut usage_ok = false;
    let mut permitted: Vec<String> = Vec::new();
    for extension in cert.extensions() {
        match extension.parsed_extension() {
            ParsedExtension::BasicConstraints(bc) => {
                ca_ok = bc.ca && bc.path_len_constraint == Some(0) && extension.critical;
            }
            ParsedExtension::KeyUsage(ku) => {
                usage_ok = ku.key_cert_sign()
                    && ku.crl_sign()
                    && !ku.digital_signature()
                    && !ku.key_encipherment()
                    && !ku.data_encipherment()
                    && !ku.key_agreement()
                    && extension.critical;
            }
            ParsedExtension::NameConstraints(nc) => {
                for subtree in nc.permitted_subtrees.iter().flatten() {
                    match &subtree.base {
                        GeneralName::DNSName(name) => permitted.push((*name).to_owned()),
                        GeneralName::IPAddress(bytes) if bytes.len() == 8 => {
                            permitted.push(format!("{}.{}.{}.{}", bytes[0], bytes[1], bytes[2], bytes[3]));
                        }
                        other => permitted.push(format!("{other:?}")),
                    }
                }
            }
            _ => {}
        }
    }
    if !ca_ok {
        return Err(fail("basic constraints must be critical CA:TRUE, pathlen 0".to_owned()));
    }
    if !usage_ok {
        return Err(fail("key usage must be exactly keyCertSign and cRLSign, critical".to_owned()));
    }
    for entry in &spec.egress.allow {
        let host = constraint_host(entry);
        if !permitted.iter().any(|p| p == host) {
            return Err(fail(format!("name constraints do not permit '{host}'")));
        }
    }
    let expected = spec.egress.allow.len()
        + usize::from(!spec.egress.allow.iter().any(|e| e.parse::<std::net::Ipv4Addr>().is_ok()));
    if permitted.len() != expected {
        return Err(fail(format!("name constraints permit more than the allowlist: {permitted:?}")));
    }
    Ok(())
}
