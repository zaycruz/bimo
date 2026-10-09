//! Hermes Agent (Nous Research, `pip install hermes-agent`). Launched from a
//! configuration source: a directory that becomes the agent's HERMES_HOME.
//! The task API is the gateway's API server; `POST /v1/runs` accepts a task
//! and answers 202 with a run id, which is the readiness probe.
use super::{
    Endpoint, GuestClass, GuestContext, GuestRecipe, LaunchContext, LaunchRecipe, Probe, RuntimeAdapter,
    find_program, guest_path, http_agent,
};

/// The Hermes venv in the golden template (templates/README.md).
const GUEST_HERMES_DIR: &str = "/opt/monolith/hermes";
use crate::spec::{AgentSpec, SecretRef, SourceKind};
use std::collections::BTreeMap;
use std::time::Duration;

pub struct Hermes;

impl RuntimeAdapter for Hermes {
    fn name(&self) -> &'static str {
        "hermes"
    }

    fn source_kinds(&self) -> &'static [SourceKind] {
        &[SourceKind::Config]
    }

    fn launch(&self, context: &LaunchContext<'_>) -> Result<LaunchRecipe, String> {
        let program = find_program("MONOLITH_HERMES_BIN", "hermes")?;
        let mut env = BTreeMap::new();
        env.insert(
            "HERMES_HOME".to_owned(),
            context.source_dir.to_string_lossy().into_owned(),
        );
        env.insert(
            "HOME".to_owned(),
            context.home_dir.to_string_lossy().into_owned(),
        );
        env.insert("API_SERVER_ENABLED".to_owned(), "true".to_owned());
        env.insert("API_SERVER_HOST".to_owned(), context.bind_host.to_owned());
        env.insert("API_SERVER_PORT".to_owned(), context.port.to_string());
        env.insert("API_SERVER_KEY".to_owned(), context.control_key.to_owned());
        env.insert("PYTHONUNBUFFERED".to_owned(), "1".to_owned());
        Ok(LaunchRecipe {
            program,
            args: vec!["gateway".to_owned(), "run".to_owned()],
            env,
            cwd: context.home_dir.to_path_buf(),
        })
    }

    /// In a guest, Hermes runs from the venv baked into the template; the
    /// configuration source travels as its HERMES_HOME.
    fn guest(&self, context: &GuestContext<'_>) -> Result<GuestRecipe, String> {
        let mut env = BTreeMap::new();
        env.insert("HERMES_HOME".to_owned(), guest_path("hermes-home"));
        env.insert("HOME".to_owned(), guest_path("home"));
        env.insert("PATH".to_owned(), format!("{GUEST_HERMES_DIR}/bin:/usr/bin:/bin"));
        env.insert("API_SERVER_ENABLED".to_owned(), "true".to_owned());
        env.insert("API_SERVER_HOST".to_owned(), "0.0.0.0".to_owned());
        env.insert("API_SERVER_PORT".to_owned(), context.port.to_string());
        env.insert("API_SERVER_KEY".to_owned(), context.control_key.to_owned());
        env.insert("PYTHONUNBUFFERED".to_owned(), "1".to_owned());
        Ok(GuestRecipe {
            class: GuestClass::PooledContainer,
            files: vec![(context.source_dir.to_path_buf(), "hermes-home".to_owned())],
            dirs: vec!["home".to_owned()],
            program: format!("{GUEST_HERMES_DIR}/bin/hermes"),
            args: vec!["gateway".to_owned(), "run".to_owned()],
            env,
            cwd: guest_path("home"),
            port: context.port,
            memory_mb: 256,
        })
    }

    /// Hermes picks a provider and its auth mode from the key it finds. A
    /// placeholder keeps the real key's prefix so the provider resolves the
    /// same way: an Anthropic `sk-ant-oat` key would switch to OAuth, so the
    /// placeholder uses the API-key prefix.
    fn placeholder(&self, secret: &SecretRef, nonce: &str) -> String {
        match secret.env.as_str() {
            "OPENROUTER_API_KEY" => format!("sk-or-v1-{nonce}"),
            "OPENAI_API_KEY" => format!("sk-proj-{nonce}"),
            "ANTHROPIC_API_KEY" => format!("sk-ant-api03-{nonce}"),
            _ => format!("monolith-placeholder-{nonce}"),
        }
    }

    fn probe(&self, endpoint: &Endpoint) -> Probe {
        let agent = http_agent(Duration::from_millis(1500));
        let response = agent
            .post(format!("{}/v1/runs", endpoint.base_url))
            .header("Authorization", format!("Bearer {}", endpoint.control_key))
            .send_json(serde_json::json!({
                "input": "Monolith readiness probe. Reply with the single word: ok"
            }));
        let mut response = match response {
            Ok(response) => response,
            Err(error) => return Probe::NotReady(error.to_string()),
        };
        let status = response.status().as_u16();
        let body: serde_json::Value = response.body_mut().read_json().unwrap_or_default();
        match status {
            202 | 200 => {
                let Some(run_id) = body["run_id"].as_str().map(str::to_owned) else {
                    return Probe::Rejected(format!("HTTP {status} without a run_id: {body}"));
                };
                // The probe only needs acceptance; stop the run so it does not
                // spend model tokens.
                let _ = agent
                    .post(format!("{}/v1/runs/{run_id}/stop", endpoint.base_url))
                    .header("Authorization", format!("Bearer {}", endpoint.control_key))
                    .send_empty();
                Probe::Accepted(run_id)
            }
            429 | 500..=599 => Probe::NotReady(format!("HTTP {status}")),
            _ => Probe::Rejected(format!("HTTP {status}: {body}")),
        }
    }

    /// The API server must require the control bearer. Hermes runs its API
    /// server open when it starts without a key, and that mode is reported by
    /// `/v1/capabilities`; an unauthenticated request must also be refused.
    fn state_check(&self, endpoint: &Endpoint, _spec: &AgentSpec) -> Result<(), String> {
        let agent = http_agent(Duration::from_millis(3000));
        let mut response = agent
            .get(format!("{}/v1/capabilities", endpoint.base_url))
            .header("Authorization", format!("Bearer {}", endpoint.control_key))
            .call()
            .map_err(|error| format!("could not reach /v1/capabilities: {error}"))?;
        let body: serde_json::Value = response.body_mut().read_json().unwrap_or_default();
        if body["auth"]["type"] != "bearer" || body["auth"]["required"] != true {
            return Err(format!(
                "the Hermes API server reports auth {}; it must require the control bearer",
                body["auth"]
            ));
        }
        let open = agent
            .get(format!("{}/v1/capabilities", endpoint.base_url))
            .call()
            .map(|response| response.status().as_u16())
            .map_err(|error| format!("could not reach /v1/capabilities: {error}"))?;
        if open != 401 && open != 403 {
            return Err(format!(
                "the Hermes API server answered an unauthenticated request with HTTP {open}"
            ));
        }
        Ok(())
    }
}
