//! eve agents (Vercel's eve framework, npm package `eve`, Node 24+).
//! Launched from a git repository at a pinned revision: Monolith checks the
//! revision out, runs `npm ci` and `eve build` in it, then serves the build
//! with `eve start`.
//!
//! Contract for an eve agent deployed by Monolith: its eve channel
//! (`agent/channels/eve.ts`) admits the bearer in `MONOLITH_CONTROL_KEY` and
//! nothing else. The readiness probe starts a session with that bearer
//! (`POST /eve/v1/session`, answered 202 with a `sessionId`), and the
//! runtime-state check confirms a request without it is refused.
use super::{
    Endpoint, GuestClass, GuestContext, GuestRecipe, LaunchContext, LaunchRecipe, Probe, RuntimeAdapter,
    find_program, guest_path, http_agent,
};

/// Node in the golden template (templates/README.md).
const GUEST_NODE_DIR: &str = "/opt/monolith/node";
use crate::spec::{AgentSpec, SourceKind};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

pub struct Eve;

fn node() -> Result<PathBuf, String> {
    find_program("MONOLITH_NODE_BIN", "node")
}

fn base_env(node: &Path, home: &Path) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    let node_dir = node.parent().unwrap_or_else(|| Path::new("/usr/bin"));
    env.insert(
        "PATH".to_owned(),
        format!("{}:/usr/bin:/bin", node_dir.display()),
    );
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env
}

fn run(program: &Path, args: &[&str], cwd: &Path, env: &BTreeMap<String, String>) -> Result<(), String> {
    let output = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .output()
        .map_err(|error| format!("could not run {}: {error}", program.display()))?;
    if output.status.success() {
        return Ok(());
    }
    let mut text = String::from_utf8_lossy(&output.stderr).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stdout));
    let tail: String = text
        .lines()
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    Err(format!(
        "'{} {}' failed ({}):\n{}",
        program.display(),
        args.join(" "),
        output.status,
        crate::runtime::redact(&tail)
    ))
}

impl RuntimeAdapter for Eve {
    fn name(&self) -> &'static str {
        "eve"
    }

    fn source_kinds(&self) -> &'static [SourceKind] {
        &[SourceKind::Git]
    }

    fn prepare(&self, context: &LaunchContext<'_>) -> Result<(), String> {
        let node = node()?;
        let npm = node.with_file_name("npm");
        if !npm.is_file() {
            return Err(format!("npm was not found next to {}", node.display()));
        }
        if !context.source_dir.join("package-lock.json").is_file() {
            return Err("the eve source has no package-lock.json; commit one so installs are reproducible".to_owned());
        }
        let mut env = base_env(&node, context.home_dir);
        let cache = std::env::var("MONOLITH_NPM_CACHE")
            .unwrap_or_else(|_| context.home_dir.join(".npm").to_string_lossy().into_owned());
        env.insert("npm_config_cache".to_owned(), cache);
        env.insert("npm_config_update_notifier".to_owned(), "false".to_owned());
        run(
            &npm,
            &["ci", "--no-audit", "--no-fund", "--loglevel=error"],
            context.source_dir,
            &env,
        )?;
        let eve = context.source_dir.join("node_modules/eve/bin/eve.js");
        if !eve.is_file() {
            return Err("the eve source does not depend on the 'eve' package".to_owned());
        }
        run(&node, &[&eve.to_string_lossy(), "build"], context.source_dir, &env)
    }

    fn launch(&self, context: &LaunchContext<'_>) -> Result<LaunchRecipe, String> {
        let node = node()?;
        let mut env = base_env(&node, context.home_dir);
        env.insert("NODE_ENV".to_owned(), "production".to_owned());
        env.insert("PORT".to_owned(), context.port.to_string());
        env.insert("MONOLITH_CONTROL_KEY".to_owned(), context.control_key.to_owned());
        let eve = context.source_dir.join("node_modules/eve/bin/eve.js");
        Ok(LaunchRecipe {
            program: node,
            args: vec![
                eve.to_string_lossy().into_owned(),
                "start".to_owned(),
                "--host".to_owned(),
                context.bind_host.to_owned(),
                "--port".to_owned(),
                context.port.to_string(),
            ],
            env,
            cwd: context.source_dir.to_path_buf(),
        })
    }

    /// In a guest, eve runs its built server bundle (`.output`, made by
    /// `eve build` on the control plane) with the Node baked into the
    /// template. Only the bundle travels; the checkout and its
    /// `node_modules` stay on the control plane.
    fn guest(&self, context: &GuestContext<'_>) -> Result<GuestRecipe, String> {
        let output = context.source_dir.join(".output");
        if !output.join("server/index.mjs").is_file() {
            return Err("the eve build produced no .output/server/index.mjs".to_owned());
        }
        let port = context.port.to_string();
        let mut env = BTreeMap::new();
        env.insert("NODE_ENV".to_owned(), "production".to_owned());
        env.insert("PORT".to_owned(), port.clone());
        env.insert("NITRO_PORT".to_owned(), port);
        env.insert("HOST".to_owned(), "0.0.0.0".to_owned());
        env.insert("NITRO_HOST".to_owned(), "0.0.0.0".to_owned());
        env.insert("HOME".to_owned(), guest_path("home"));
        env.insert("PATH".to_owned(), format!("{GUEST_NODE_DIR}/bin:/usr/bin:/bin"));
        env.insert("MONOLITH_CONTROL_KEY".to_owned(), context.control_key.to_owned());
        Ok(GuestRecipe {
            class: GuestClass::PooledContainer,
            files: vec![(output, "app/.output".to_owned())],
            dirs: vec!["home".to_owned()],
            program: format!("{GUEST_NODE_DIR}/bin/node"),
            args: vec![guest_path("app/.output/server/index.mjs")],
            env,
            cwd: guest_path("app"),
            port: context.port,
            memory_mb: 384,
        })
    }

    fn probe(&self, endpoint: &Endpoint) -> Probe {
        let agent = http_agent(Duration::from_millis(3000));
        let response = agent
            .post(format!("{}/eve/v1/session", endpoint.base_url))
            .header("Authorization", format!("Bearer {}", endpoint.control_key))
            .send_json(serde_json::json!({
                "message": "Monolith readiness probe. Reply with the single word: ok"
            }));
        let mut response = match response {
            Ok(response) => response,
            Err(error) => return Probe::NotReady(error.to_string()),
        };
        let status = response.status().as_u16();
        let body: serde_json::Value = response.body_mut().read_json().unwrap_or_default();
        match status {
            200..=202 if body["ok"] == true => match body["sessionId"].as_str() {
                Some(id) => Probe::Accepted(id.to_owned()),
                None => Probe::Rejected(format!("HTTP {status} without a sessionId: {body}")),
            },
            404 | 429 | 500..=599 => Probe::NotReady(format!("HTTP {status}")),
            _ => Probe::Rejected(format!("HTTP {status}: {body}")),
        }
    }

    /// The channel must refuse callers without the control bearer. An agent
    /// whose channel falls back to `localDev()` or no auth would admit anyone
    /// who can reach it.
    fn state_check(&self, endpoint: &Endpoint, _spec: &AgentSpec) -> Result<(), String> {
        let agent = http_agent(Duration::from_millis(3000));
        let status = agent
            .get(format!("{}/eve/v1/info", endpoint.base_url))
            .call()
            .map(|response| response.status().as_u16())
            .map_err(|error| format!("could not reach /eve/v1/info: {error}"))?;
        if status != 401 && status != 403 {
            return Err(format!(
                "the eve channel answered an unauthenticated /eve/v1/info with HTTP {status}; \
                 it must admit only the bearer in MONOLITH_CONTROL_KEY (see examples/eve-agent/agent/channels/eve.ts)"
            ));
        }
        Ok(())
    }
}
