//! The Proxmox substrate driver (U5) and its per-tenant warm pool (U6).
//!
//! The driver creates LXC guests as linked clones of a golden template, in
//! one resource pool, inside one VMID range, with static addresses from one
//! range. It never touches a guest outside that scope: every create or
//! destroy checks the VMID range first, and every destroy also checks that
//! the guest sits in the pool and carries the ownership marker the driver
//! wrote when it cloned it.
//!
//! A spawn takes a ready guest from the tenant's warm pool (`pool.rs`) and
//! binds it with a per-claim payload through the bind agent baked into the
//! template (KTD10). When the pool is empty it falls back to a cold clone and
//! says so. The runtime is then delivered and started through the same bind
//! agent (`delivery.rs`, U8). The agent's credential proxy runs in its
//! tenant's proxy guest (`tenant_proxy.rs`, U7 stage 2), never on the control
//! plane and never in the agent's guest: each generation gets a route there,
//! the agent guest's egress lock admits only that proxy's front, and the bind
//! payload, the bundle and the runtime's environment carry placeholders and
//! the route credential, never a secret.
pub mod client;
pub mod delivery;
pub mod network;
pub mod pool;
pub mod tenant_proxy;

use crate::runtimes::{GuestClass, GUEST_RUNTIME_PORT};
use crate::substrate::{
    self, codes, CreateRequest, Created, FabricError, GuestRef, Resource, ResourceJournal, ResourceKind,
    Substrate,
};
use delivery::{ChannelError, GuestChannel};
use crate::target::{ConfiguredTarget, ProxmoxGuestType, ResolvedTarget, MAX_WARM_POOL_SIZE};
use client::{encode, ApiError, Client, TlsMode};
use network::AddressRange;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::net::Ipv4Addr;
use std::time::{Duration, Instant};

/// Written into every guest's description at clone time. Destroy refuses a
/// guest without it.
pub const OWNER_MARKER: &str = "monolith-owned";
pub const OWNER_TAG: &str = "monolith";

/// What a cloned guest is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuestRole {
    /// Runs one agent's runtime; pooled or cold-cloned per claim.
    Agent,
    /// The tenant's long-lived proxy guest. `agent_address` is its address
    /// on the tenant's VLAN (`net1`), when the target maps one.
    Proxy { agent_address: Option<Ipv4Addr> },
}

/// Resolved driver settings. Every field is required to touch the cluster.
#[derive(Debug, Clone)]
pub struct Settings {
    pub api_url: String,
    pub node: String,
    pub pool: String,
    pub template_id: u32,
    pub vmid_low: u32,
    pub vmid_high: u32,
    pub bridge: String,
    pub addresses: AddressRange,
    pub prefix_len: u8,
    pub gateway: Ipv4Addr,
    pub tenant_vlans: BTreeMap<String, u16>,
    pub warm_pool_size: u32,
    pub memory_mb: u32,
    pub cores: Option<u32>,
    pub bind_port: u16,
    pub tls: TlsMode,
}

struct Ready {
    settings: Settings,
    client: Client,
}

pub struct ProxmoxDriver {
    pub target_name: String,
    pub config: ConfiguredTarget,
    ready: Result<Ready, String>,
}

impl ProxmoxDriver {
    pub fn from_target(target: &ResolvedTarget) -> Result<Self, FabricError> {
        let Some(config @ ConfiguredTarget::Proxmox { .. }) = target.configured.clone() else {
            return Err(FabricError::new(
                codes::TARGET_UNAVAILABLE,
                format!(
                    "target '{}' is the reserved proxmox kind; declare a named proxmox target in .bimo/targets.toml",
                    target.name
                ),
            )
            .next("see examples/targets.toml for a proxmox target"));
        };
        let ConfiguredTarget::Proxmox { token_env, .. } = &config else {
            unreachable!()
        };
        let token_env = token_env.clone();
        let token = match std::env::var(&token_env) {
            Ok(value) if !value.trim().is_empty() => value,
            _ => {
                return Err(FabricError::new(
                    codes::TARGET_UNAVAILABLE,
                    format!(
                        "target '{}' needs a Proxmox API token, but environment variable {token_env} is not set",
                        target.name
                    ),
                )
                .next(format!(
                    "export {token_env}='<user>@<realm>!<token-id>=<secret>' using the pool-scoped write token"
                )))
            }
        };
        // Settings and the client are resolved here but checked lazily, so a
        // target can be selected (and report its driver) before it is
        // complete. Nothing here contacts the cluster.
        let ready = resolve_settings(&config).and_then(|settings| {
            let client = Client::new(&settings.api_url, &token, settings.tls.clone())
                .map_err(|error| format!("cannot build the API client: {error}"))?;
            Ok(Ready { settings, client })
        });
        Ok(Self {
            target_name: target.name.clone(),
            config,
            ready,
        })
    }

    fn ready(&self) -> Result<&Ready, FabricError> {
        self.ready.as_ref().map_err(|reason| {
            FabricError::new(
                codes::TARGET_UNAVAILABLE,
                format!("proxmox target '{}' {reason}", self.target_name),
            )
            .next("see examples/targets.toml for the driver fields of a proxmox target")
        })
    }

    pub fn settings(&self) -> Result<&Settings, FabricError> {
        Ok(&self.ready()?.settings)
    }

    fn client(&self) -> Result<&Client, FabricError> {
        Ok(&self.ready()?.client)
    }

    fn api_error(&self, context: &str, error: ApiError) -> FabricError {
        FabricError::new(codes::SUBSTRATE_FAILED, format!("{context}: {error}"))
            .next(format!("check the proxmox target '{}' and retry", self.target_name))
    }

    /// A read-only API call for operators and live suites. Returns the
    /// reply's `data` or the API error (status and redacted message).
    pub fn api_get(&self, path: &str) -> Result<Result<Value, ApiError>, FabricError> {
        Ok(self.client()?.get(path))
    }

    /// Refuse any VMID outside the target's range before an API call.
    pub fn check_scope(&self, vmid: u32) -> Result<(), FabricError> {
        let settings = self.settings()?;
        if vmid < settings.vmid_low || vmid > settings.vmid_high {
            return Err(FabricError::new(
                codes::SUBSTRATE_REFUSED,
                format!(
                    "refusing VMID {vmid}: target '{}' may only touch VMIDs {}-{}",
                    self.target_name, settings.vmid_low, settings.vmid_high
                ),
            ));
        }
        Ok(())
    }

    fn guest_path(&self, vmid: u32) -> Result<String, FabricError> {
        self.check_scope(vmid)?;
        let settings = self.settings()?;
        Ok(format!("/nodes/{}/lxc/{vmid}", encode(&settings.node)))
    }

    pub fn resource(&self, vmid: u32, address: Ipv4Addr, template_version: &str) -> Result<Resource, FabricError> {
        let settings = self.settings()?;
        Ok(Resource {
            kind: ResourceKind::Guest,
            id: format!("pve:{}:{vmid}", settings.node),
            process: None,
            guest: Some(GuestRef {
                node: settings.node.clone(),
                vmid,
                guest_type: "lxc".to_owned(),
                address: Some(address.to_string()),
                template_version: Some(template_version.to_owned()),
            }),
        })
    }

    /// The template's version: the first 12 hex digits of its config digest.
    /// Any change to the template's config changes it, so pooled guests made
    /// from an older template are detectable (U6).
    pub fn template_version(&self) -> Result<String, FabricError> {
        let settings = self.settings()?;
        let path = format!("/nodes/{}/lxc/{}/config", encode(&settings.node), settings.template_id);
        let config = self.client()?.get(&path).map_err(|error| {
            if error.status == 403 || error.is_missing() {
                FabricError::new(
                    codes::TARGET_UNAVAILABLE,
                    format!(
                        "the golden template {} is not readable on {}: {error}",
                        settings.template_id, settings.node
                    ),
                )
                .next("build it with scripts/build-template.sh (see templates/README.md)")
            } else {
                self.api_error("could not read the template", error)
            }
        })?;
        if config.get("template").and_then(as_flag) != Some(true) {
            return Err(FabricError::new(
                codes::TARGET_UNAVAILABLE,
                format!("guest {} is not a template yet", settings.template_id),
            )
            .next("finish scripts/build-template.sh, which converts it with 'pct template'"));
        }
        let digest = config.get("digest").and_then(Value::as_str).unwrap_or_default();
        if digest.len() < 12 {
            return Err(FabricError::new(codes::SUBSTRATE_FAILED, "the template config has no digest"));
        }
        Ok(format!("cfg-{}", &digest[..12]))
    }

    /// Guests the token can see (only pool members, for a pool-scoped token).
    pub fn visible_guests(&self) -> Result<Vec<Value>, FabricError> {
        let data = self
            .client()?
            .get("/cluster/resources?type=vm")
            .map_err(|error| self.api_error("could not list guests", error))?;
        Ok(data.as_array().cloned().unwrap_or_default())
    }

    /// Addresses held by lxc guests the token can see.
    pub fn addresses_in_use(&self, guests: &[Value]) -> Result<BTreeSet<Ipv4Addr>, FabricError> {
        let settings = self.settings()?;
        let client = self.client()?;
        let mut used = BTreeSet::new();
        for guest in guests {
            let vmid = guest.get("vmid").and_then(Value::as_u64).unwrap_or(0) as u32;
            if guest.get("type").and_then(Value::as_str) != Some("lxc") || vmid == 0 {
                continue;
            }
            let node = guest.get("node").and_then(Value::as_str).unwrap_or(&settings.node);
            let path = format!("/nodes/{}/lxc/{vmid}/config", encode(node));
            let Ok(config) = client.get(&path) else { continue };
            if let Some(object) = config.as_object() {
                for (key, value) in object {
                    if key.starts_with("net") {
                        if let Some(address) = value.as_str().and_then(network::net_address) {
                            used.insert(address);
                        }
                    }
                }
            }
        }
        Ok(used)
    }

    /// Whether no guest anywhere in the cluster has this VMID.
    pub fn vmid_free(&self, vmid: u32) -> Result<bool, FabricError> {
        match self.client()?.get(&format!("/cluster/nextid?vmid={vmid}")) {
            Ok(_) => Ok(true),
            Err(error) if error.status == 400 || error.message.contains("already exists") => Ok(false),
            Err(error) => Err(self.api_error("could not check a VMID", error)),
        }
    }

    /// Clone the template into `vmid`, configure its network, start it and
    /// wait for its bind agent. The ownership marker is written by the clone
    /// call itself, so a guest that exists is always recognisably owned.
    pub fn clone_and_start(
        &self,
        vmid: u32,
        address: Ipv4Addr,
        tenant: &str,
        timeout: Duration,
    ) -> Result<(), FabricError> {
        self.clone_guest(vmid, address, tenant, GuestRole::Agent, timeout)
    }

    /// `clone_and_start` for either role. An agent guest's only NIC is on
    /// its tenant's VLAN when the target maps one. A proxy guest keeps
    /// `net0` on the untagged bridge (control plane, upstream) and, with a
    /// VLAN, gets `net1` on the tenant's segment for its agents; it is
    /// marked `role=proxy` and tagged `monolith-proxy`, and is never pooled.
    pub fn clone_guest(
        &self,
        vmid: u32,
        address: Ipv4Addr,
        tenant: &str,
        role: GuestRole,
        timeout: Duration,
    ) -> Result<(), FabricError> {
        let settings = self.settings()?;
        let client = self.client()?;
        let vlan = self.tenant_vlan(tenant)?;
        self.check_scope(vmid)?;
        let deadline = Instant::now() + timeout;
        let node = encode(&settings.node);
        let hostname = hostname(vmid);
        let mut description = format!(
            "{OWNER_MARKER} target={} tenant={}",
            self.target_name,
            tag_slug(tenant)
        );
        if let GuestRole::Proxy { .. } = role {
            description.push_str(" role=proxy");
        }
        client
            .run_task(
                &settings.node,
                "POST",
                &format!("/nodes/{node}/lxc/{}/clone", settings.template_id),
                &[
                    ("newid", vmid.to_string()),
                    ("hostname", hostname.clone()),
                    ("pool", settings.pool.clone()),
                    ("full", "0".to_owned()),
                    ("description", description),
                ],
                remaining(deadline),
            )
            .map_err(|error| self.api_error(&format!("could not clone template into {vmid}"), error))?;
        let guest = self.guest_path(vmid)?;
        let (net0_vlan, memory, tags) = match role {
            GuestRole::Agent => (vlan, settings.memory_mb, format!("{OWNER_TAG};tenant-{}", tag_slug(tenant))),
            GuestRole::Proxy { .. } => (
                None,
                tenant_proxy::PROXY_MEMORY_MB.max(settings.memory_mb),
                format!("{OWNER_TAG};tenant-{};{}", tag_slug(tenant), tenant_proxy::PROXY_TAG),
            ),
        };
        let mut config = vec![
            (
                "net0",
                network::net0(&settings.bridge, address, settings.prefix_len, settings.gateway, net0_vlan),
            ),
            ("memory", memory.to_string()),
            ("swap", "0".to_owned()),
            ("onboot", "0".to_owned()),
            ("tags", tags),
        ];
        if let (GuestRole::Proxy { agent_address: Some(agent_address) }, Some(tag)) = (role, vlan) {
            config.push(("net1", network::net1_tenant(&settings.bridge, agent_address, settings.prefix_len, tag)));
        }
        if let Some(cores) = settings.cores {
            config.push(("cores", cores.to_string()));
        }
        client
            .run_task(&settings.node, "PUT", &format!("{guest}/config"), &config, remaining(deadline))
            .map_err(|error| self.api_error(&format!("could not configure guest {vmid}"), error))?;
        client
            .run_task(&settings.node, "POST", &format!("{guest}/status/start"), &[], remaining(deadline))
            .map_err(|error| self.api_error(&format!("could not start guest {vmid}"), error))?;
        pool::wait_for_bind_agent(address, settings.bind_port, &hostname, deadline).map_err(|message| {
            FabricError::new(
                codes::SUBSTRATE_FAILED,
                format!(
                    "guest {vmid} started, but its bind agent at {address}:{} did not answer: {message}",
                    settings.bind_port
                ),
            )
            .next("check that the template carries the bind agent (templates/README.md) and that this host can reach the guest segment")
        })
    }

    /// Whether the guest exists and runs. A guest the token cannot see is
    /// not one of ours, so it reports false.
    pub fn guest_running(&self, vmid: u32) -> Result<bool, FabricError> {
        let path = format!("{}/status/current", self.guest_path(vmid)?);
        match self.client()?.get(&path) {
            Ok(status) => Ok(status.get("status").and_then(Value::as_str) == Some("running")),
            Err(error) if error.is_missing() || error.status == 403 => Ok(false),
            Err(error) => Err(self.api_error(&format!("could not read guest {vmid}"), error)),
        }
    }

    /// Raise a claimed guest's memory limit for the runtime it will run.
    pub fn set_memory(&self, vmid: u32, memory_mb: u32) -> Result<(), FabricError> {
        let settings = self.settings()?;
        let guest = self.guest_path(vmid)?;
        self.client()?
            .run_task(
                &settings.node,
                "PUT",
                &format!("{guest}/config"),
                &[("memory", memory_mb.to_string())],
                Duration::from_secs(30),
            )
            .map_err(|error| self.api_error(&format!("could not set guest {vmid} memory to {memory_mb} MB"), error))
    }

    /// Memory the running guest uses, in bytes.
    pub fn guest_memory(&self, vmid: u32) -> Result<Option<u64>, FabricError> {
        let path = format!("{}/status/current", self.guest_path(vmid)?);
        Ok(self.client()?.get(&path).ok().and_then(|s| s.get("mem").and_then(Value::as_u64)))
    }

    /// Stop and delete an owned guest. A guest that no longer exists is
    /// already destroyed. A guest outside the range, outside the pool or
    /// without the ownership marker is refused.
    pub fn destroy_guest(&self, vmid: u32) -> Result<(), FabricError> {
        let settings = self.settings()?;
        let client = self.client()?;
        let guest = self.guest_path(vmid)?;
        let visible = self.visible_guests()?;
        let Some(entry) = visible
            .iter()
            .find(|g| g.get("vmid").and_then(Value::as_u64) == Some(u64::from(vmid)))
        else {
            if self.vmid_free(vmid)? {
                return Ok(());
            }
            return Err(FabricError::new(
                codes::SUBSTRATE_REFUSED,
                format!(
                    "refusing VMID {vmid}: it exists but is not visible to the driver token, so it is not in pool '{}'",
                    settings.pool
                ),
            ));
        };
        let in_pool = entry.get("pool").and_then(Value::as_str) == Some(settings.pool.as_str());
        let node = entry.get("node").and_then(Value::as_str).unwrap_or_default();
        if !in_pool || node != settings.node || entry.get("type").and_then(Value::as_str) != Some("lxc") {
            return Err(FabricError::new(
                codes::SUBSTRATE_REFUSED,
                format!(
                    "refusing VMID {vmid}: it is not an lxc guest in pool '{}' on {}",
                    settings.pool, settings.node
                ),
            ));
        }
        let config = match client.get(&format!("{guest}/config")) {
            Ok(config) => config,
            Err(error) if error.is_missing() => return Ok(()),
            Err(error) => return Err(self.api_error(&format!("could not read guest {vmid}"), error)),
        };
        let description = config.get("description").and_then(Value::as_str).unwrap_or_default();
        if !description.contains(OWNER_MARKER) {
            return Err(FabricError::new(
                codes::SUBSTRATE_REFUSED,
                format!("refusing VMID {vmid}: it does not carry the '{OWNER_MARKER}' marker"),
            ));
        }
        let timeout = Duration::from_secs(120);
        // The cluster resource list lags a guest that just started, so ask
        // the guest itself whether it is running.
        let running = match client.get(&format!("{guest}/status/current")) {
            Ok(status) => status.get("status").and_then(Value::as_str) == Some("running"),
            Err(error) if error.is_missing() => return Ok(()),
            Err(error) => return Err(self.api_error(&format!("could not read status of guest {vmid}"), error)),
        };
        if running {
            match client.run_task(&settings.node, "POST", &format!("{guest}/status/stop"), &[], timeout) {
                Ok(()) => {}
                Err(error) if error.is_missing() => return Ok(()),
                Err(error) => return Err(self.api_error(&format!("could not stop guest {vmid}"), error)),
            }
        }
        match client.run_task(&settings.node, "DELETE", &guest, &[], timeout) {
            Ok(()) => Ok(()),
            Err(error) if error.is_missing() => Ok(()),
            Err(error) => Err(self.api_error(&format!("could not delete guest {vmid}"), error)),
        }
    }

    /// The tenant's VLAN, if the target maps tenants to segments. With a
    /// non-empty map an unmapped tenant is refused (KTD5).
    pub fn tenant_vlan(&self, tenant: &str) -> Result<Option<u16>, FabricError> {
        let settings = self.settings()?;
        if settings.tenant_vlans.is_empty() {
            return Ok(None);
        }
        settings.tenant_vlans.get(tenant).copied().map(Some).ok_or_else(|| {
            FabricError::new(
                codes::TENANT_CONFLICT,
                format!("tenant '{tenant}' has no segment on target '{}'", self.target_name),
            )
            .next("add the tenant to tenant_vlans once its segment is provisioned")
        })
    }
}

impl Substrate for ProxmoxDriver {
    fn kind(&self) -> &'static str {
        "proxmox"
    }

    fn create(&self, request: &CreateRequest<'_>, journal: &mut dyn ResourceJournal) -> Result<Created, FabricError> {
        let settings = self.settings()?.clone();
        let recipe = (request.guest_recipe)(GUEST_RUNTIME_PORT)?;
        if recipe.class != GuestClass::PooledContainer {
            return Err(FabricError::new(
                codes::RUNTIME_UNAVAILABLE,
                format!(
                    "the runtime needs a {:?} guest, which this driver does not build yet",
                    recipe.class
                ),
            )
            .next("see docs/agent-spec.md, 'Guest classes'"));
        }
        // Pack the bundle before touching anything, so a bad build wastes no guest.
        let bundle = delivery::stage_bundle(&recipe, &request.proxy.agent_ca, request.generation_dir)
            .map_err(|message| FabricError::new(codes::SOURCE_FAILED, message))?;
        request.clock.mark("bundle");
        // The tenant's proxy guest first: the agent never runs without its
        // boundary, and the boundary never runs on this host or in the
        // agent's guest (U7, stage 2).
        let proxy = self.ensure_proxy(request.tenant)?;
        let egress = proxy.egress();
        let route = tenant_proxy::Route::new(request.agent, request.generation)?;
        let route_resource = self.route_resource(&proxy, &route);
        request.clock.mark("proxy_ready");
        // From here every resource is journaled; on an error the control
        // plane clears what was touched, in reverse order.
        journal.touching(&route_resource)?;
        let warm = crate::runtimes::lookup(request.runtime).and_then(|adapter| adapter.warm(GUEST_RUNTIME_PORT));
        let egress_key = egress.to_string();
        let claim = self.claim_for(
            request.tenant,
            request.agent,
            request.generation,
            warm.as_ref().map(|w| w.key.as_str()),
            Some(&egress_key),
            journal,
        )?;
        request.clock.mark(match (&claim.go_token, claim.pooled) {
            (Some(_), _) => "claim_warm",
            (None, true) => "claim_pooled",
            (None, false) => "claim_cold_clone",
        });
        pool::spawn_refill(&self.target_name, request.tenant, warm.as_ref().map(|_| request.runtime));
        tenant_proxy::check_bind_api(&claim.status, claim.vmid, &self.target_name)?;
        // The per-guest credential stays with the control plane, beside the
        // generation it belongs to.
        let credential_path = request.generation_dir.join("guest-credential");
        crate::state::atomic_write(&credential_path, claim.credential.as_bytes(), 0o600)
            .map_err(|error| FabricError::io(codes::STATE_FAILED, "could not record the guest credential", error))?;
        // The agent reaches its route in the proxy guest directly, with the
        // route's credential in the proxy URL; its lock admits nothing else.
        let proxy_env = request
            .proxy
            .agent_env_with_ca(&route.url(egress), &delivery::guest_ca_path());
        let channel = GuestChannel::new(claim.address, settings.bind_port, &claim.credential);
        let delivery_error = |step: &str, error: ChannelError| match error {
            ChannelError::Missing(_) => FabricError::new(
                codes::TARGET_UNAVAILABLE,
                format!(
                    "guest {} was cloned from a template whose bind agent cannot deliver a runtime ({step})",
                    claim.vmid
                ),
            )
            .next("rebuild the golden template with scripts/build-template.sh (see templates/README.md)")
            .next(format!("bimo pool drain --target {}", self.target_name)),
            ChannelError::Failed(message) => FabricError::new(
                codes::SUBSTRATE_FAILED,
                format!("could not {step} in guest {}: {message}", claim.vmid),
            )
            .next(format!("bimo agent logs {}", request.agent)),
        };
        // The route starts in the proxy guest while the runtime is delivered;
        // the runtime starts (or takes go) only once both are done, so its
        // first request finds its proxy.
        let source = Some(claim.address);
        let (routed, delivered) = std::thread::scope(|scope| {
            let routed = scope.spawn(|| self.put_route(&proxy, &route, source, request.proxy));
            let delivered = if claim.go_token.is_some() {
                let _ = std::fs::remove_file(&bundle);
                Ok(())
            } else {
                let resize = (recipe.memory_mb > settings.memory_mb)
                    .then(|| scope.spawn(|| self.set_memory(claim.vmid, recipe.memory_mb)));
                let uploaded = channel.put_bundle(&bundle);
                let _ = std::fs::remove_file(&bundle);
                let resized = resize.map(|handle| {
                    handle.join().unwrap_or_else(|_| {
                        Err(FabricError::new(codes::SUBSTRATE_FAILED, "the memory resize panicked"))
                    })
                });
                uploaded
                    .map_err(|e| delivery_error("deliver the runtime bundle", e))
                    .and_then(|_| resized.unwrap_or(Ok(())))
            };
            let routed = routed
                .join()
                .unwrap_or_else(|_| Err(FabricError::new(codes::PROXY_FAILED, "the route request panicked")));
            (routed, delivered)
        });
        routed.map_err(|e| e.next(format!("bimo agent logs {} --stream egress", request.agent)))?;
        journal.created(&route_resource)?;
        delivered?;
        request.clock.mark(if claim.go_token.is_some() { "route" } else { "upload" });
        if let Some(go_token) = &claim.go_token {
            // A warm guest already runs its launcher (locked to this proxy
            // when it was warmed): hand it the agent's files and environment.
            let body = delivery::go_body(&recipe, proxy_env, &request.proxy.agent_ca)
                .map_err(|message| FabricError::new(codes::SOURCE_FAILED, message))?;
            delivery::send_go(
                claim.address,
                recipe.port,
                go_token,
                &body,
                std::time::Instant::now() + std::time::Duration::from_secs(60),
            )
            .map_err(|message| {
                FabricError::new(codes::SUBSTRATE_FAILED, format!("guest {}: {message}", claim.vmid))
                    .next(format!("bimo agent logs {}", request.agent))
            })?;
            request.clock.mark("go");
        } else {
            channel
                .start(&delivery::start_body(&recipe, proxy_env, egress))
                .map_err(|e| delivery_error("start the runtime", e))?;
            request.clock.mark("runtime_start");
        }
        Ok(Created {
            resources: vec![route_resource, claim.resource],
            endpoint: crate::runtimes::Endpoint {
                base_url: format!("http://{}:{}", claim.address, recipe.port),
                control_key: request.control_key.to_owned(),
            },
            proxy_management: None,
        })
    }

    fn alive(&self, resource: &Resource) -> Result<bool, FabricError> {
        if resource.kind == ResourceKind::ProxyRoute {
            return self.route_alive(resource);
        }
        if resource.kind != ResourceKind::Guest {
            return Ok(substrate::process_alive(resource));
        }
        let Some(guest) = resource.guest.as_ref() else {
            return Ok(false);
        };
        self.guest_running(guest.vmid)
    }

    fn destroy(&self, resource: &Resource) -> Result<(), FabricError> {
        if resource.kind == ResourceKind::ProxyRoute {
            return self.delete_route(resource);
        }
        if resource.kind != ResourceKind::Guest {
            return substrate::stop_process(resource);
        }
        let Some(guest) = resource.guest.as_ref() else {
            // Journaled before a VMID was chosen: nothing exists.
            return Ok(());
        };
        self.check_scope(guest.vmid)?;
        self.destroy_guest(guest.vmid)?;
        self.forget(guest.vmid)
    }

    /// The runtime writes its output inside the guest; fetch the tail into
    /// the agent log (replacing it), redacted when it is read.
    fn collect_logs(&self, generation_dir: &std::path::Path, resources: &[Resource], log_path: &std::path::Path) {
        let Some(address) = resources
            .iter()
            .filter(|r| r.kind == ResourceKind::Guest)
            .find_map(|r| r.guest.as_ref())
            .and_then(|g| g.address.as_deref())
            .and_then(|a| a.parse::<Ipv4Addr>().ok())
        else {
            return;
        };
        let Ok(credential) = std::fs::read_to_string(generation_dir.join("guest-credential")) else {
            return;
        };
        let Ok(settings) = self.settings() else { return };
        let channel = GuestChannel::new(address, settings.bind_port, credential.trim());
        if let Ok(text) = channel.log() {
            let _ = crate::state::atomic_write(log_path, text.as_bytes(), 0o600);
        }
    }

    fn proxy_placement(&self) -> crate::proxy::Placement {
        crate::proxy::Placement::Remote
    }

    fn rotate_secrets(
        &self,
        _generation_dir: &std::path::Path,
        resources: &[Resource],
        _management: Option<&str>,
        secrets: &[(String, String)],
    ) -> Result<(), FabricError> {
        self.rotate_route(resources, secrets)
    }

    fn collect_audit(&self, resources: &[Resource], audit_path: &std::path::Path) {
        self.collect_route_audit(resources, audit_path);
    }
}

fn resolve_settings(config: &ConfiguredTarget) -> Result<Settings, String> {
    let ConfiguredTarget::Proxmox {
        api_url,
        node,
        guest_type,
        driver,
        ..
    } = config
    else {
        return Err("is not a proxmox target".to_owned());
    };
    if *guest_type == Some(ProxmoxGuestType::Vm) {
        return Err("sets guest_type = \"vm\"; the driver creates lxc guests only".to_owned());
    }
    let mut missing = Vec::new();
    if node.is_none() {
        missing.push("node");
    }
    if driver.pool.is_none() {
        missing.push("pool");
    }
    if driver.template_id.is_none() {
        missing.push("template_id");
    }
    if driver.vmid_range.is_none() {
        missing.push("vmid_range");
    }
    if driver.bridge.is_none() {
        missing.push("bridge");
    }
    if driver.address_range.is_none() {
        missing.push("address_range");
    }
    if driver.prefix_len.is_none() {
        missing.push("prefix_len");
    }
    if driver.gateway.is_none() {
        missing.push("gateway");
    }
    if !missing.is_empty() {
        return Err(format!("is missing driver field(s): {}", missing.join(", ")));
    }
    let [vmid_low, vmid_high] = driver.vmid_range.unwrap_or_default();
    let addresses = AddressRange::parse(driver.address_range.as_deref().unwrap_or_default())?;
    let gateway = driver
        .gateway
        .as_deref()
        .unwrap_or_default()
        .parse()
        .map_err(|_| "has an invalid gateway".to_owned())?;
    let tls = match (driver.tls_verify, &driver.tls_ca_file) {
        (Some(false), _) => TlsMode::Insecure,
        (_, Some(path)) => TlsMode::Pinned(
            std::fs::read_to_string(path).map_err(|error| format!("cannot read tls_ca_file '{path}': {error}"))?,
        ),
        _ => TlsMode::Verify,
    };
    Ok(Settings {
        api_url: api_url.clone(),
        node: node.clone().unwrap_or_default(),
        pool: driver.pool.clone().unwrap_or_default(),
        template_id: driver.template_id.unwrap_or_default(),
        vmid_low,
        vmid_high,
        bridge: driver.bridge.clone().unwrap_or_default(),
        addresses,
        prefix_len: driver.prefix_len.unwrap_or_default(),
        gateway,
        tenant_vlans: driver.tenant_vlans.clone(),
        warm_pool_size: driver.warm_pool_size.unwrap_or(2).min(MAX_WARM_POOL_SIZE),
        memory_mb: driver.guest_memory_mb.unwrap_or(256),
        cores: driver.guest_cores,
        bind_port: driver.bind_port.unwrap_or(7070),
        tls,
    })
}

pub fn hostname(vmid: u32) -> String {
    format!("mono-{vmid}")
}

/// A Proxmox-tag-safe form of a tenant id.
pub fn tag_slug(value: &str) -> String {
    let slug: String = value
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' })
        .collect();
    if slug.is_empty() { "none".to_owned() } else { slug }
}

fn as_flag(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(flag) => Some(*flag),
        Value::Number(number) => number.as_u64().map(|n| n == 1),
        Value::String(text) => Some(text == "1"),
        _ => None,
    }
}

fn remaining(deadline: Instant) -> Duration {
    deadline.saturating_duration_since(Instant::now()).max(Duration::from_secs(1))
}
