//! The cloudflare substrate: agents run as Dynamic Workers on a Bimo host
//! Worker (engine/cloudflare/host) behind its credential gateway.
//!
//! The driver talks only to the host's control API, with the operator token
//! from the target's `token_env`. One apply is one `PUT` of the generation:
//! the host stores the route (allowlist, placeholders and their hosts, the
//! secret values sealed under its vault key) before the agent, so the agent
//! is never reachable without its boundary. Secret values exist on this host
//! only in memory (`Placement::Remote`) and travel only in that request and
//! in rotations.
//!
//! Resources: `cf:<tenant>:<agent>:g<generation>` (the Worker) and
//! `cf:route:<tenant>:<route>` (its route in the tenant's vault). Every call
//! on them is scoped to the tenant, so rolling back a refused takeover never
//! touches the owner's agent. Destroying either is idempotent. Plan and failure list:
//! docs/plans/2026-10-10-cloudflare-substrate.md.
use crate::proxy::Placement;
use crate::substrate::{codes, CreateRequest, Created, FabricError, Resource, ResourceJournal, ResourceKind, Substrate};
use crate::target::{ConfiguredTarget, ResolvedTarget};
use std::path::Path;
use std::time::Duration;

pub struct CloudflareDriver {
    name: String,
    url: String,
    token: String,
}

fn http(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .proxy(None)
        .build()
        .new_agent()
}

/// The host accepts lowercase identifiers only (`[a-z0-9-]`, at most 63).
fn host_name_ok(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !value.starts_with('-')
        && !value.ends_with('-')
}

fn route_name(agent: &str, generation: u64) -> String {
    format!("{agent}-g{generation}")
}

/// `cf:route:<tenant>:<route>` -> (tenant, route)
fn parse_route(resource: &Resource) -> Option<(&str, &str)> {
    let rest = resource.id.strip_prefix("cf:route:")?;
    rest.split_once(':')
}

/// `cf:<tenant>:<agent>:g<generation>` -> (tenant, agent, generation)
fn parse_worker(resource: &Resource) -> Option<(&str, &str, u64)> {
    let rest = resource.id.strip_prefix("cf:")?;
    let (tenant, rest) = rest.split_once(':')?;
    let (agent, generation) = rest.split_once(":g")?;
    Some((tenant, agent, generation.parse().ok()?))
}

fn worker_path((tenant, agent, generation): (&str, &str, u64)) -> String {
    format!("/v1/agents/{agent}/generations/{generation}?tenant={tenant}")
}

impl CloudflareDriver {
    pub fn from_target(target: &ResolvedTarget) -> Result<Self, FabricError> {
        let Some(ConfiguredTarget::Cloudflare { name, url, token_env, .. }) = target.configured.clone() else {
            return Err(FabricError::new(
                codes::TARGET_UNAVAILABLE,
                format!(
                    "target '{}' is the reserved cloudflare kind; declare a named cloudflare target in .bimo/targets.toml",
                    target.name
                ),
            )
            .next("see examples/targets.toml for a cloudflare target"));
        };
        let token = match std::env::var(&token_env) {
            Ok(value) if !value.trim().is_empty() => value,
            _ => {
                return Err(FabricError::new(
                    codes::TARGET_UNAVAILABLE,
                    format!(
                        "target '{name}' needs the Bimo host's operator token, but environment variable {token_env} is not set"
                    ),
                )
                .next(format!("export {token_env} with the host Worker's BIMO_OPERATOR_TOKEN")))
            }
        };
        Ok(Self { name, url, token })
    }

    fn control(&self, method: &str, path: &str, body: Option<serde_json::Value>) -> Result<(u16, String), FabricError> {
        let agent = http(Duration::from_secs(30));
        let url = format!("{}{path}", self.url);
        let auth = format!("Bearer {}", self.token);
        let result = match (method, body) {
            ("PUT", Some(body)) => agent.put(&url).header("Authorization", &auth).send_json(body),
            ("POST", Some(body)) => agent.post(&url).header("Authorization", &auth).send_json(body),
            ("DELETE", _) => agent.delete(&url).header("Authorization", &auth).call(),
            _ => agent.get(&url).header("Authorization", &auth).call(),
        };
        let mut response = result.map_err(|error| {
            FabricError::new(
                codes::TARGET_UNAVAILABLE,
                format!("could not reach the Bimo host for target '{}': {error}", self.name),
            )
            .next("check the target's url and that the host Worker is deployed (or wrangler dev is running)")
        })?;
        let status = response.status().as_u16();
        let text = response.body_mut().read_to_string().unwrap_or_default();
        if status == 401 {
            return Err(FabricError::new(
                codes::TARGET_UNAVAILABLE,
                format!("the Bimo host for target '{}' refused the operator token", self.name),
            )
            .next("set the target's token_env to the host's BIMO_OPERATOR_TOKEN"));
        }
        Ok((status, text))
    }

    fn failed(&self, what: &str, status: u16, text: &str) -> FabricError {
        let detail = serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(str::to_owned))
            .unwrap_or_else(|| text.chars().take(200).collect());
        FabricError::new(codes::SUBSTRATE_FAILED, format!("{what}: HTTP {status}: {detail}"))
    }
}

impl Substrate for CloudflareDriver {
    fn kind(&self) -> &'static str {
        "cloudflare"
    }

    fn proxy_placement(&self) -> Placement {
        Placement::Remote
    }

    fn create(&self, request: &CreateRequest<'_>, journal: &mut dyn ResourceJournal) -> Result<Created, FabricError> {
        for (field, value) in [("name", request.agent), ("tenant_id", request.tenant)] {
            if !host_name_ok(value) {
                return Err(FabricError::new(
                    codes::SPEC_INVALID,
                    format!("the cloudflare substrate needs a lowercase {field} ([a-z0-9-], at most 63); got '{value}'"),
                ));
            }
        }
        let recipe = (request.worker_recipe)()?;
        let plan = request.proxy;
        let material = plan.remote.as_ref().ok_or_else(|| {
            FabricError::new(codes::PROXY_FAILED, "the cloudflare substrate needs a remote proxy plan")
        })?;
        let mut secrets = Vec::new();
        for secret in &plan.spec.secrets {
            let value = material
                .secrets
                .iter()
                .find(|(env, _)| *env == secret.env)
                .map(|(_, value)| value.clone())
                .ok_or_else(|| FabricError::new(codes::SECRET_UNRESOLVED, format!("no value for {}", secret.env)))?;
            let placeholder = plan.placeholders.get(&secret.env).cloned().unwrap_or_default();
            secrets.push(serde_json::json!({
                "env": secret.env,
                "placeholder": placeholder,
                "hosts": secret.hosts,
                "value": value,
            }));
        }
        let route = route_name(request.agent, request.generation);
        let route_resource = Resource {
            kind: ResourceKind::ProxyRoute,
            id: format!("cf:route:{}:{route}", request.tenant),
            process: None,
            guest: None,
        };
        let worker_resource = Resource {
            kind: ResourceKind::Worker,
            id: format!("cf:{}:{}:g{}", request.tenant, request.agent, request.generation),
            process: None,
            guest: None,
        };
        journal.touching(&route_resource)?;
        journal.touching(&worker_resource)?;
        let body = serde_json::json!({
            "tenant": request.tenant,
            "main": recipe.main,
            "modules": recipe.modules,
            "env": recipe.env,
            "compatibility_date": recipe.compatibility_date,
            "egress_allow": plan.spec.egress.allow,
            "secrets": secrets,
        });
        let path = format!("/v1/agents/{}/generations/{}", request.agent, request.generation);
        let (status, text) = self.control("PUT", &path, Some(body))?;
        match status {
            200 => {}
            409 => {
                return Err(FabricError::new(
                    codes::TENANT_CONFLICT,
                    format!("agent '{}' belongs to another tenant on target '{}'", request.agent, self.name),
                ))
            }
            _ => return Err(self.failed("the Bimo host refused the agent", status, &text)),
        }
        journal.created(&route_resource)?;
        journal.created(&worker_resource)?;
        request.clock.mark("worker_put");
        let endpoint_path = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v["endpoint_path"].as_str().map(str::to_owned))
            .unwrap_or_else(|| format!("/a/{}/g{}", request.agent, request.generation));
        Ok(Created {
            resources: vec![route_resource, worker_resource],
            endpoint: crate::runtimes::Endpoint {
                base_url: format!("{}{endpoint_path}", self.url),
                control_key: request.control_key.to_owned(),
            },
            proxy_management: None,
        })
    }

    fn alive(&self, resource: &Resource) -> Result<bool, FabricError> {
        let path = match resource.kind {
            ResourceKind::Worker => {
                let worker = parse_worker(resource).ok_or_else(|| {
                    FabricError::new(codes::SUBSTRATE_REFUSED, format!("{} is not a cloudflare worker", resource.id))
                })?;
                worker_path(worker)
            }
            ResourceKind::ProxyRoute => {
                let (tenant, route) = parse_route(resource).ok_or_else(|| {
                    FabricError::new(codes::SUBSTRATE_REFUSED, format!("{} is not a cloudflare route", resource.id))
                })?;
                format!("/v1/tenants/{tenant}/routes/{route}")
            }
            _ => return Ok(false),
        };
        let (status, text) = self.control("GET", &path, None)?;
        match status {
            200 => Ok(true),
            404 => Ok(false),
            _ => Err(self.failed(&format!("could not check {}", resource.id), status, &text)),
        }
    }

    fn destroy(&self, resource: &Resource) -> Result<(), FabricError> {
        let path = match resource.kind {
            ResourceKind::Worker => match parse_worker(resource) {
                Some(worker) => worker_path(worker),
                None => return Err(FabricError::new(codes::SUBSTRATE_REFUSED, format!("{} is not a cloudflare worker", resource.id))),
            },
            ResourceKind::ProxyRoute => match parse_route(resource) {
                Some((tenant, route)) => format!("/v1/tenants/{tenant}/routes/{route}"),
                None => return Err(FabricError::new(codes::SUBSTRATE_REFUSED, format!("{} is not a cloudflare route", resource.id))),
            },
            _ => {
                return Err(FabricError::new(
                    codes::SUBSTRATE_REFUSED,
                    format!("{} is not a cloudflare resource", resource.id),
                ))
            }
        };
        let (status, text) = self.control("DELETE", &path, None)?;
        // A 404 for the resource itself means it is already gone; a 404 for
        // an unknown path (an older host) must not pass as destroyed.
        let gone = status == 404
            && serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .is_some_and(|v| v["error"]["code"] != "usage");
        match status {
            200 => Ok(()),
            _ if gone => Ok(()),
            _ => Err(self.failed(&format!("could not destroy {}", resource.id), status, &text)),
        }
    }

    fn rotate_secrets(
        &self,
        _generation_dir: &Path,
        resources: &[Resource],
        _management: Option<&str>,
        secrets: &[(String, String)],
    ) -> Result<(), FabricError> {
        let (tenant, route) = resources
            .iter()
            .find(|r| r.kind == ResourceKind::ProxyRoute)
            .and_then(parse_route)
            .ok_or_else(|| FabricError::new(codes::PROXY_FAILED, "the running agent has no cloudflare route on record"))?;
        let body = serde_json::json!({
            "secrets": secrets.iter().map(|(env, value)| serde_json::json!({"env": env, "value": value})).collect::<Vec<_>>(),
        });
        let (status, text) = self.control("POST", &format!("/v1/tenants/{tenant}/routes/{route}/secrets"), Some(body))?;
        if status != 200 {
            return Err(FabricError::new(
                codes::PROXY_FAILED,
                self.failed("the Bimo host refused the rotation", status, &text).message,
            ));
        }
        Ok(())
    }

    /// Pull the route's audit lines from the host. Each route's lines are
    /// kept under `egress-audit.d/` so lines of retired generations stay in
    /// the agent's audit log after their route is gone.
    fn collect_audit(&self, resources: &[Resource], audit_path: &Path) {
        let Some((tenant, route)) = resources.iter().find(|r| r.kind == ResourceKind::ProxyRoute).and_then(parse_route)
        else {
            return;
        };
        let Ok((200, text)) = self.control("GET", &format!("/v1/tenants/{tenant}/routes/{route}/audit"), None) else {
            return;
        };
        let Some(parent) = audit_path.parent() else { return };
        let kept = parent.join("egress-audit.d");
        if std::fs::create_dir_all(&kept).is_err() {
            return;
        }
        let _ = crate::state::atomic_write(&kept.join(format!("{route}.jsonl")), text.as_bytes(), 0o600);
        let mut parts: Vec<(std::time::SystemTime, std::path::PathBuf)> = std::fs::read_dir(&kept)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
            .collect();
        parts.sort();
        let mut all = Vec::new();
        for (_, path) in parts {
            if let Ok(bytes) = std::fs::read(&path) {
                all.extend_from_slice(&bytes);
            }
        }
        let _ = crate::state::atomic_write(audit_path, &all, 0o600);
    }
}
