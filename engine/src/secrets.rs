//! Secret handles and the pluggable sources that resolve them.
//!
//! A handle is `<tenant>/<name>`. It resolves only inside the namespace of the
//! tenant that owns the spec, so a spec cannot name another tenant's secret.
//! Resolved values never enter agent state, logs or the agent's environment;
//! only the credential proxy receives them.
use serde::{Deserialize, Serialize};
use std::fmt;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handle {
    pub tenant: String,
    pub name: String,
}

impl Handle {
    pub fn parse(value: &str) -> Result<Self, String> {
        let Some((tenant, name)) = value.split_once('/') else {
            return Err(format!(
                "secret handle '{value}' must have the form '<tenant>/<name>'"
            ));
        };
        if !is_identifier(tenant) {
            return Err(format!(
                "secret handle '{value}' has an invalid tenant part '{tenant}'"
            ));
        }
        if name.is_empty()
            || name.len() > 128
            || !name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "-_.".contains(c))
            || name.starts_with(['.', '-', '_'])
        {
            return Err(format!(
                "secret handle '{value}' has an invalid name part '{name}' (use lowercase letters, digits, '-', '_', '.')"
            ));
        }
        Ok(Self {
            tenant: tenant.to_owned(),
            name: name.to_owned(),
        })
    }
}

impl fmt::Display for Handle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}/{}", self.tenant, self.name)
    }
}

/// A lowercase DNS-label style identifier, used for agent names and tenants.
pub fn is_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !value.starts_with('-')
        && !value.ends_with('-')
}

/// Where the control plane looks up secret values. Configured per target.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SecretSourceConfig {
    /// Local-mode source: `MONOLITH_SECRET_<TENANT>__<NAME>` in the control
    /// plane's own environment.
    #[default]
    Env,
    /// 1Password Connect. Each tenant has its own vault, named by
    /// `vault_prefix` + tenant id; the item title is the handle name.
    OnepasswordConnect {
        url: String,
        token_env: String,
        #[serde(default = "default_vault_prefix")]
        vault_prefix: String,
    },
}

fn default_vault_prefix() -> String {
    "monolith-".to_owned()
}

impl SecretSourceConfig {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Env => "env",
            Self::OnepasswordConnect { .. } => "onepassword_connect",
        }
    }

    /// Resolve a handle that already passed the tenant check.
    pub fn resolve(&self, handle: &Handle) -> Result<String, SecretError> {
        match self {
            Self::Env => {
                let variable = env_variable_for(handle);
                match std::env::var(&variable) {
                    Ok(value) if !value.is_empty() => Ok(value),
                    _ => Err(SecretError::NotFound(format!(
                        "secret handle '{handle}' does not resolve: environment variable {variable} is not set"
                    ))),
                }
            }
            Self::OnepasswordConnect {
                url,
                token_env,
                vault_prefix,
            } => onepassword_resolve(url, token_env, vault_prefix, handle),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretError {
    NotFound(String),
    Unavailable(String),
}

impl fmt::Display for SecretError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound(message) | Self::Unavailable(message) => formatter.write_str(message),
        }
    }
}

pub fn env_variable_for(handle: &Handle) -> String {
    fn part(value: &str) -> String {
        value
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_uppercase()
                } else {
                    '_'
                }
            })
            .collect()
    }
    format!(
        "MONOLITH_SECRET_{}__{}",
        part(&handle.tenant),
        part(&handle.name)
    )
}

fn onepassword_resolve(
    url: &str,
    token_env: &str,
    vault_prefix: &str,
    handle: &Handle,
) -> Result<String, SecretError> {
    let token = std::env::var(token_env).map_err(|_| {
        SecretError::Unavailable(format!(
            "1Password Connect token is missing: set {token_env}"
        ))
    })?;
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .http_status_as_error(false)
        .build()
        .new_agent();
    let base = url.trim_end_matches('/');
    let get = |path: String| -> Result<serde_json::Value, SecretError> {
        let mut response = agent
            .get(format!("{base}{path}"))
            .header("Authorization", format!("Bearer {token}"))
            .call()
            .map_err(|error| {
                SecretError::Unavailable(format!("1Password Connect request failed: {error}"))
            })?;
        let status = response.status().as_u16();
        if status != 200 {
            return Err(SecretError::Unavailable(format!(
                "1Password Connect returned HTTP {status} for {path}"
            )));
        }
        response.body_mut().read_json().map_err(|error| {
            SecretError::Unavailable(format!("1Password Connect returned invalid JSON: {error}"))
        })
    };
    let vault_name = format!("{vault_prefix}{}", handle.tenant);
    let vaults = get(format!(
        "/v1/vaults?filter={}",
        query_escape(&format!("name eq \"{vault_name}\""))
    ))?;
    let vault_id = vaults
        .as_array()
        .and_then(|list| list.first())
        .and_then(|vault| vault["id"].as_str())
        .ok_or_else(|| {
            SecretError::NotFound(format!(
                "secret handle '{handle}' does not resolve: vault '{vault_name}' not found"
            ))
        })?
        .to_owned();
    let items = get(format!(
        "/v1/vaults/{vault_id}/items?filter={}",
        query_escape(&format!("title eq \"{}\"", handle.name))
    ))?;
    let item_id = items
        .as_array()
        .and_then(|list| list.first())
        .and_then(|item| item["id"].as_str())
        .ok_or_else(|| {
            SecretError::NotFound(format!(
                "secret handle '{handle}' does not resolve: item '{}' not found in vault '{vault_name}'",
                handle.name
            ))
        })?
        .to_owned();
    let item = get(format!("/v1/vaults/{vault_id}/items/{item_id}"))?;
    item["fields"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|field| {
            matches!(field["purpose"].as_str(), Some("PASSWORD"))
                || matches!(field["id"].as_str(), Some("credential" | "password"))
        })
        .and_then(|field| field["value"].as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            SecretError::NotFound(format!(
                "secret handle '{handle}' does not resolve: item has no credential or password field"
            ))
        })
}

fn query_escape(value: &str) -> String {
    let mut escaped = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            escaped.push(byte as char);
        } else {
            escaped.push_str(&format!("%{byte:02X}"));
        }
    }
    escaped
}
