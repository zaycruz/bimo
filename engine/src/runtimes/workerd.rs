//! workerd agents: prebuilt JavaScript modules that run as a Cloudflare
//! Dynamic Worker on a `cloudflare` target (src/cloudflare/mod.rs). There is
//! no local launch; the runtime is the Workers runtime itself.
//!
//! Source: a `config` directory or a `git` checkout holding ES modules
//! (`.js`, `.mjs`) and optional `bimo-worker.json`:
//! `{"main": "index.js", "compatibility_date": "2026-10-01"}`. Bundle a
//! TypeScript agent before applying; Bimo uploads the modules as they are.
//!
//! Contract for a workerd agent (the same shape as the other runtimes):
//! - its default export's `fetch` admits only `Authorization: Bearer
//!   <env.BIMO_CONTROL_KEY>`;
//! - `POST /bimo/v1/tasks` accepts a task with 202 and `{"task_id": ...}`;
//! - it reads each secret's placeholder from `env.<NAME>` and makes its
//!   outbound requests with plain `fetch()`, which the host's credential
//!   gateway intercepts.
use super::{Endpoint, LaunchContext, LaunchRecipe, Probe, RuntimeAdapter, http_agent};
use crate::spec::{AgentSpec, SourceKind};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

pub struct Workerd;

/// The modules and settings of one worker agent, read from its source.
/// Nothing in it is a secret: the control key and placeholders are added by
/// the control plane.
#[derive(Debug, Clone)]
pub struct WorkerRecipe {
    pub main: String,
    /// Module path (relative, `/`-separated) -> source text.
    pub modules: BTreeMap<String, String>,
    pub compatibility_date: String,
    pub env: BTreeMap<String, String>,
}

/// The environment variable a worker agent reads its control key from.
pub const CONTROL_KEY_ENV: &str = "BIMO_CONTROL_KEY";
const DEFAULT_COMPATIBILITY_DATE: &str = "2026-10-01";
const MAX_MODULE_BYTES: usize = 1024 * 1024;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    #[serde(default)]
    main: Option<String>,
    #[serde(default)]
    compatibility_date: Option<String>,
}

fn collect_modules(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("could not read {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("could not read {}: {e}", dir.display()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let path = entry.path();
        let kind = entry.file_type().map_err(|e| format!("could not stat {}: {e}", path.display()))?;
        if kind.is_symlink() {
            return Err(format!("{} is a symlink; worker sources must be plain files", path.display()));
        }
        if kind.is_dir() {
            collect_modules(root, &path, out)?;
        } else if name.ends_with(".js") || name.ends_with(".mjs") {
            let relative = path
                .strip_prefix(root)
                .map_err(|_| format!("{} is outside the source", path.display()))?
                .to_string_lossy()
                .replace('\\', "/");
            let text = std::fs::read_to_string(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
            out.insert(relative, text);
        }
    }
    Ok(())
}

impl RuntimeAdapter for Workerd {
    fn worker(&self, source_dir: &Path, control_key: &str) -> Result<WorkerRecipe, String> {
        let manifest_path = source_dir.join("bimo-worker.json");
        let manifest = if manifest_path.exists() {
            let text = std::fs::read_to_string(&manifest_path)
                .map_err(|e| format!("could not read bimo-worker.json: {e}"))?;
            serde_json::from_str::<Manifest>(&text).map_err(|e| format!("bimo-worker.json is invalid: {e}"))?
        } else {
            Manifest {
                main: None,
                compatibility_date: None,
            }
        };
        let mut modules = BTreeMap::new();
        collect_modules(source_dir, source_dir, &mut modules)?;
        let main = manifest.main.unwrap_or_else(|| "index.js".to_owned());
        if !modules.contains_key(&main) {
            return Err(format!("the worker source has no main module '{main}'"));
        }
        let size: usize = modules.values().map(String::len).sum();
        if size > MAX_MODULE_BYTES {
            return Err(format!(
                "the worker's modules total {size} bytes; the limit is {MAX_MODULE_BYTES}"
            ));
        }
        let compatibility_date = manifest
            .compatibility_date
            .unwrap_or_else(|| DEFAULT_COMPATIBILITY_DATE.to_owned());
        let mut env = BTreeMap::new();
        env.insert(CONTROL_KEY_ENV.to_owned(), control_key.to_owned());
        Ok(WorkerRecipe {
            main,
            modules,
            compatibility_date,
            env,
        })
    }

    fn name(&self) -> &'static str {
        "workerd"
    }

    fn source_kinds(&self) -> &'static [SourceKind] {
        &[SourceKind::Config, SourceKind::Git]
    }

    fn launch(&self, _context: &LaunchContext<'_>) -> Result<LaunchRecipe, String> {
        Err("runtime 'workerd' runs only on a cloudflare target".to_owned())
    }

    fn probe(&self, endpoint: &Endpoint) -> Probe {
        let agent = http_agent(Duration::from_millis(5000));
        let response = agent
            .post(format!("{}/bimo/v1/tasks", endpoint.base_url))
            .header("Authorization", format!("Bearer {}", endpoint.control_key))
            .send_json(serde_json::json!({ "input": "Bimo readiness probe" }));
        let mut response = match response {
            Ok(response) => response,
            Err(error) => return Probe::NotReady(error.to_string()),
        };
        let status = response.status().as_u16();
        let body: serde_json::Value = response.body_mut().read_json().unwrap_or_default();
        match status {
            202 | 200 => match body["task_id"].as_str() {
                Some(task_id) => Probe::Accepted(task_id.to_owned()),
                None => Probe::Rejected(format!("HTTP {status} without a task_id: {body}")),
            },
            404 | 429 | 500..=599 => Probe::NotReady(format!("HTTP {status}")),
            _ => Probe::Rejected(format!("HTTP {status}: {body}")),
        }
    }

    /// The agent must refuse a task without the control key.
    fn state_check(&self, endpoint: &Endpoint, _spec: &AgentSpec) -> Result<(), String> {
        let status = http_agent(Duration::from_millis(5000))
            .post(format!("{}/bimo/v1/tasks", endpoint.base_url))
            .send_json(serde_json::json!({ "input": "unauthenticated" }))
            .map(|response| response.status().as_u16())
            .map_err(|error| format!("could not reach /bimo/v1/tasks: {error}"))?;
        if status != 401 && status != 403 {
            return Err(format!(
                "the workerd agent answered an unauthenticated task with HTTP {status}; it must require the control key"
            ));
        }
        Ok(())
    }
}
