use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
#[derive(Debug, Clone)]
pub struct SessionIdentity {
    pub factory_generation: u64,
    pub pod: String,
    pub session: String,
}
#[derive(Debug, Clone)]
pub struct CapabilityPolicy {
    pub capabilities: BTreeSet<String>,
    pub destinations: BTreeSet<String>,
    pub kinds: BTreeSet<String>,
    pub max_payload_bytes: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SendMessageArgs {
    pub to: String,
    pub kind: String,
    pub payload: String,
    #[serde(default)]
    pub correlation: Option<String>,
}
impl CapabilityPolicy {
    pub fn authorize_read_state(&self) -> Result<(), String> {
        self.capabilities
            .contains("factory.read_state")
            .then_some(())
            .ok_or_else(|| "capability not declared".into())
    }

    pub fn authorize_send(&self, a: &SendMessageArgs) -> Result<(), String> {
        if !self.capabilities.contains("pod.send_message") {
            return Err("capability not declared".into());
        }
        if !self.destinations.contains(&a.to) {
            return Err("destination not declared".into());
        }
        if !self.kinds.contains(&a.kind) {
            return Err("message kind denied".into());
        }
        if a.payload.len() > self.max_payload_bytes {
            return Err("payload too large".into());
        }
        if a.correlation.as_ref().is_some_and(|v| {
            v.is_empty()
                || v.len() > 256
                || !v
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c))
        }) {
            return Err("invalid correlation".into());
        }
        Ok(())
    }
}
#[derive(Debug, Serialize)]
pub struct SafePod<'a> {
    pub name: &'a str,
    pub role: &'a str,
    pub engine: &'a str,
    pub status: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_denies_undeclared_destination_without_side_effects() {
        let policy = CapabilityPolicy {
            capabilities: ["pod.send_message".to_owned()].into(),
            destinations: ["planner".to_owned()].into(),
            kinds: ["work.completed".to_owned()].into(),
            max_payload_bytes: 32,
        };
        let args = SendMessageArgs {
            to: "other".into(),
            kind: "work.completed".into(),
            payload: "ok".into(),
            correlation: None,
        };
        assert_eq!(
            policy.authorize_send(&args),
            Err("destination not declared".into())
        );
    }
}
