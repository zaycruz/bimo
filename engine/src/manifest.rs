use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const DEFAULT_MAX_FRAME_BYTES: usize = 65_536;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FactoryManifest {
    pub name: String,
    #[serde(default)]
    pub state_dir: Option<String>,
    #[serde(default)]
    pub trusted_executable_roots: Vec<String>,
    pub pods: Vec<PodManifest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PodManifest {
    pub name: String,
    #[serde(default)]
    pub role: Option<String>,
    pub engine: String,
    #[serde(default = "default_protocol")]
    pub protocol: String,
    #[serde(default)]
    pub command: Vec<String>,
    #[serde(default)]
    pub allowed_env: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default = "default_frame_limit")]
    pub max_frame_bytes: usize,
    #[serde(default = "default_request_timeout")]
    pub request_timeout_ms: u64,
    #[serde(default = "default_heartbeat_timeout")]
    pub heartbeat_timeout_ms: u64,
    #[serde(default)]
    pub config: BTreeMap<String, Value>,
    #[serde(default)]
    pub destinations: Vec<String>,
    #[serde(default = "default_message_kinds")]
    pub message_kinds: Vec<String>,
    #[serde(default = "default_payload_limit")]
    pub max_payload_bytes: usize,
}

fn default_protocol() -> String {
    "agent-worker/v1".into()
}
fn default_frame_limit() -> usize {
    DEFAULT_MAX_FRAME_BYTES
}
fn default_request_timeout() -> u64 {
    120_000
}
fn default_heartbeat_timeout() -> u64 {
    15_000
}
fn default_payload_limit() -> usize {
    32_768
}
fn default_message_kinds() -> Vec<String> {
    vec![
        "work.requested".into(),
        "work.completed".into(),
        "message".into(),
    ]
}

impl PodManifest {
    pub fn role(&self) -> &str {
        self.role.as_deref().unwrap_or(&self.name)
    }
    pub fn is_safe_name(&self) -> bool {
        let name = self.name.trim();
        !name.is_empty()
            && name != "."
            && name != ".."
            && !name.contains('/')
            && !name.contains('\\')
    }
}

pub fn parse(source: &str) -> Result<FactoryManifest, toml::de::Error> {
    toml::from_str(source)
}

#[cfg(test)]
mod tests {
    use super::parse;
    #[test]
    fn parses_worker_contract() {
        let m = parse(
            r#"name="demo"
          [[pods]]
          name="worker"
          engine="fixture"
          protocol="agent-worker/v1"
          command=["/usr/bin/node", "worker.mjs"]
          capabilities=["factory.read_state"]"#,
        )
        .unwrap();
        assert_eq!(m.pods[0].engine, "fixture");
        assert_eq!(m.pods[0].max_frame_bytes, 65_536);
    }
    #[test]
    fn rejects_unknown_fields() {
        assert!(parse("name='x'\nunknown=true\npods=[]").is_err());
    }
    #[test]
    fn rejects_empty_or_partial_documents() {
        assert!(parse("").is_err());
        assert!(parse("name='x'").is_err());
    }
}
