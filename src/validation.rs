use crate::manifest::{DEFAULT_MAX_FRAME_BYTES, FactoryManifest};
use std::collections::HashSet;
use std::path::Path;

pub const ALLOWED_CAPABILITIES: &[&str] = &["pod.send_message", "factory.read_state"];

pub fn validate(manifest: &FactoryManifest) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();
    if manifest.name.trim().is_empty() {
        errors.push("factory name must not be empty".into());
    }
    if manifest
        .state_dir
        .as_ref()
        .is_some_and(|v| v.trim().is_empty())
    {
        errors.push("state directory must not be empty".into());
    }
    if manifest.pods.is_empty() {
        errors.push("factory must contain at least one pod".into());
    }
    let declared: HashSet<_> = manifest.pods.iter().map(|p| p.name.as_str()).collect();
    let mut seen = HashSet::new();
    for pod in &manifest.pods {
        let n = pod.name.trim();
        if n.is_empty() {
            errors.push("pod name must not be empty".into());
        } else if !pod.is_safe_name() {
            errors.push(format!("pod name must be a safe path component: {n}"));
        } else if !seen.insert(n) {
            errors.push(format!("duplicate pod name: {n}"));
        }
        if pod.role.as_ref().is_some_and(|v| v.trim().is_empty()) {
            errors.push(format!("pod role must not be empty: {n}"));
        }
        if pod.engine.trim().is_empty() {
            errors.push(format!("pod engine must not be empty: {n}"));
        }
        if pod.protocol != "agent-worker/v1" {
            errors.push(format!(
                "unsupported protocol for pod {n}: {}",
                pod.protocol
            ));
        }
        if pod.command.is_empty() || pod.command.iter().any(|arg| arg.is_empty()) {
            errors.push(format!("pod command argv must not be empty: {n}"));
        } else {
            let executable = Path::new(&pod.command[0]);
            if !executable.is_absolute() {
                errors.push(format!("pod executable must be absolute: {n}"));
            }
            if !manifest.trusted_executable_roots.is_empty()
                && !manifest
                    .trusted_executable_roots
                    .iter()
                    .any(|r| executable.starts_with(r))
            {
                errors.push(format!("pod executable is outside trusted roots: {n}"));
            }
        }
        if pod.max_frame_bytes == 0 || pod.max_frame_bytes > DEFAULT_MAX_FRAME_BYTES {
            errors.push(format!("invalid max_frame_bytes for pod {n}"));
        }
        if pod.request_timeout_ms == 0 || pod.heartbeat_timeout_ms == 0 {
            errors.push(format!("worker deadlines must be positive: {n}"));
        }
        for cap in &pod.capabilities {
            if !ALLOWED_CAPABILITIES.contains(&cap.as_str()) {
                errors.push(format!("unsupported capability for pod {n}: {cap}"));
            }
        }
        for dest in &pod.destinations {
            if !declared.contains(dest.as_str()) {
                errors.push(format!("undeclared destination for pod {n}: {dest}"));
            }
        }
        for env in &pod.allowed_env {
            if env.is_empty()
                || !env
                    .chars()
                    .all(|c| c == '_' || c.is_ascii_uppercase() || c.is_ascii_digit())
            {
                errors.push(format!(
                    "invalid allowed environment name for pod {n}: {env}"
                ));
            }
        }
        if serde_json::to_vec(&pod.config)
            .map(|v| v.len())
            .unwrap_or(usize::MAX)
            > 65_536
        {
            errors.push(format!("worker config too large: {n}"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}
