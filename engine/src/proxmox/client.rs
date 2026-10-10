//! A small Proxmox VE API client (KTD3).
//!
//! It speaks the JSON API over HTTPS with a privilege-separated API token,
//! waits for asynchronous tasks (UPIDs) and retries lock contention. It never
//! logs, prints or returns the token: every message that leaves this module
//! passes through `redact`.
use serde_json::Value;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How the client checks the API's TLS certificate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TlsMode {
    /// Public web PKI roots.
    Verify,
    /// Trust only the CA certificates in this PEM text (the cluster's
    /// `pve-root-ca.pem`).
    Pinned(String),
    /// No verification. Only for a target that opts in with
    /// `tls_verify = false`.
    Insecure,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    /// HTTP status, or 0 when no response arrived.
    pub status: u16,
    pub message: String,
}

impl ApiError {
    fn transport(message: String) -> Self {
        Self { status: 0, message }
    }

    /// Proxmox reports lock contention as HTTP 500 with one of these texts,
    /// or as a failed task whose exit status says so.
    pub fn is_lock(&self) -> bool {
        let text = self.message.to_ascii_lowercase();
        text.contains("can't lock file")
            || text.contains("is locked")
            || text.contains("got timeout")
    }

    /// The guest or object does not exist.
    pub fn is_missing(&self) -> bool {
        let text = self.message.to_ascii_lowercase();
        self.status == 404 || text.contains("does not exist") || text.contains("no such")
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.status == 0 {
            write!(formatter, "{}", self.message)
        } else {
            write!(formatter, "HTTP {}: {}", self.status, self.message)
        }
    }
}

pub struct Client {
    base: String,
    authorization: String,
    secrets: Vec<String>,
    agent: ureq::Agent,
}

impl Client {
    /// `token` is `user@realm!tokenid=secret`.
    pub fn new(api_url: &str, token: &str, tls: TlsMode) -> Result<Self, String> {
        let token = token.trim();
        let Some((id, secret)) = token.split_once('=') else {
            return Err("the API token is not in the form user@realm!tokenid=secret".to_owned());
        };
        if !id.contains('!') || !id.contains('@') || secret.is_empty() {
            return Err("the API token is not in the form user@realm!tokenid=secret".to_owned());
        }
        let tls_config = match &tls {
            TlsMode::Verify => ureq::tls::TlsConfig::builder().build(),
            TlsMode::Insecure => ureq::tls::TlsConfig::builder().disable_verification(true).build(),
            TlsMode::Pinned(pem) => {
                let mut roots = Vec::new();
                for item in ureq::tls::parse_pem(pem.as_bytes()) {
                    if let Ok(ureq::tls::PemItem::Certificate(cert)) = item {
                        roots.push(cert);
                    }
                }
                if roots.is_empty() {
                    return Err("tls_ca_file holds no PEM certificate".to_owned());
                }
                ureq::tls::TlsConfig::builder()
                    .root_certs(ureq::tls::RootCerts::Specific(Arc::new(roots)))
                    .build()
            }
        };
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(30)))
            .http_status_as_error(false)
            .proxy(None)
            .tls_config(tls_config)
            .build()
            .new_agent();
        Ok(Self {
            base: api_url.trim_end_matches('/').to_owned(),
            authorization: format!("PVEAPIToken={token}"),
            secrets: vec![token.to_owned(), secret.to_owned()],
            agent,
        })
    }

    /// Remove the token and its secret from any text before it leaves.
    pub fn redact(&self, text: &str) -> String {
        let mut out = text.to_owned();
        for secret in &self.secrets {
            if !secret.is_empty() {
                out = out.replace(secret.as_str(), "[redacted]");
            }
        }
        out
    }

    pub fn get(&self, path: &str) -> Result<Value, ApiError> {
        self.call("GET", path, &[])
    }

    pub fn post(&self, path: &str, form: &[(&str, String)]) -> Result<Value, ApiError> {
        self.call("POST", path, form)
    }

    pub fn put(&self, path: &str, form: &[(&str, String)]) -> Result<Value, ApiError> {
        self.call("PUT", path, form)
    }

    pub fn delete(&self, path: &str) -> Result<Value, ApiError> {
        self.call("DELETE", path, &[])
    }

    /// One request. Returns the `data` member of the reply.
    fn call(&self, method: &str, path: &str, form: &[(&str, String)]) -> Result<Value, ApiError> {
        let url = format!("{}{}", self.base, path);
        let auth = self.authorization.as_str();
        let result = match method {
            "GET" => self.agent.get(&url).header("Authorization", auth).call(),
            "DELETE" => self.agent.delete(&url).header("Authorization", auth).call(),
            "POST" => self
                .agent
                .post(&url)
                .header("Authorization", auth)
                .send_form(form.iter().map(|(k, v)| (*k, v.as_str()))),
            "PUT" => self
                .agent
                .put(&url)
                .header("Authorization", auth)
                .send_form(form.iter().map(|(k, v)| (*k, v.as_str()))),
            other => return Err(ApiError::transport(format!("unsupported method {other}"))),
        };
        let mut response = result.map_err(|error| {
            ApiError::transport(self.redact(&format!("{method} {path}: {error}")))
        })?;
        let status = response.status().as_u16();
        let reason = response
            .status()
            .canonical_reason()
            .unwrap_or_default()
            .to_owned();
        let body = response
            .body_mut()
            .with_config()
            .limit(8 * 1024 * 1024)
            .read_to_string()
            .unwrap_or_default();
        if !(200..300).contains(&status) {
            let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let mut detail = parsed
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_default();
            if let Some(errors) = parsed.get("errors").filter(|e| !e.is_null()) {
                detail.push_str(&format!(" {errors}"));
            }
            if detail.trim().is_empty() {
                detail = body.chars().take(300).collect();
            }
            if detail.trim().is_empty() {
                detail = reason;
            }
            return Err(ApiError {
                status,
                message: self.redact(&format!("{method} {path}: {}", detail.trim())),
            });
        }
        let parsed: Value = serde_json::from_str(&body).map_err(|error| {
            ApiError::transport(format!("{method} {path}: reply is not JSON: {error}"))
        })?;
        Ok(parsed.get("data").cloned().unwrap_or(Value::Null))
    }

    /// Run a mutating call that starts a task, retrying lock contention, and
    /// wait for the task to finish.
    pub fn run_task(
        &self,
        node: &str,
        method: &str,
        path: &str,
        form: &[(&str, String)],
        timeout: Duration,
    ) -> Result<(), ApiError> {
        let deadline = Instant::now() + timeout;
        let mut backoff = Duration::from_millis(250);
        loop {
            let started = match method {
                "POST" => self.post(path, form),
                "DELETE" => self.delete(path),
                "PUT" => self.put(path, form),
                other => return Err(ApiError::transport(format!("unsupported task method {other}"))),
            };
            let outcome = started.and_then(|data| match data.as_str() {
                Some(upid) if upid.starts_with("UPID:") => self.wait_task(node, upid, deadline),
                // Some calls finish synchronously and return no task.
                _ => Ok(()),
            });
            match outcome {
                Err(error) if error.is_lock() && Instant::now() + backoff < deadline => {
                    std::thread::sleep(backoff);
                    backoff = (backoff * 2).min(Duration::from_secs(3));
                }
                other => return other,
            }
        }
    }

    /// Poll `/nodes/{node}/tasks/{upid}/status` until the task stops.
    pub fn wait_task(&self, node: &str, upid: &str, deadline: Instant) -> Result<(), ApiError> {
        let path = format!("/nodes/{}/tasks/{}/status", encode(node), encode(upid));
        let mut interval = Duration::from_millis(50);
        loop {
            let status = self.get(&path)?;
            if status.get("status").and_then(Value::as_str) == Some("stopped") {
                let exit = status.get("exitstatus").and_then(Value::as_str).unwrap_or("unknown");
                return if exit == "OK" || exit.starts_with("WARNINGS") {
                    Ok(())
                } else {
                    Err(ApiError {
                        status: 500,
                        message: self.redact(&format!("task {upid} failed: {exit}")),
                    })
                };
            }
            if Instant::now() > deadline {
                return Err(ApiError::transport(format!("task {upid} did not finish in time")));
            }
            std::thread::sleep(interval);
            interval = (interval + Duration::from_millis(50)).min(Duration::from_millis(500));
        }
    }
}

/// Percent-encode one path segment.
pub fn encode(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}
