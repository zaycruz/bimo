//! The control plane for spec-declared agents.
//!
//! It validates a spec, diffs it against what runs, journals intent, asks the
//! substrate driver for resources, times readiness to the first accepted task
//! (KTD7) and commits. Substrate-backed agents keep their own versioned state
//! file (KTD8), separate from factory state.
//!
//! Layout under the state root (default `.bimo/agents`):
//!
//! ```text
//! <name>/agent.json      versioned agent record
//! <name>/journal.jsonl   intent, touched and created resources, commit
//! <name>/control.key     bearer the control plane uses to probe the agent
//! <name>/logs/agent.log  runtime output (read through `logs`, redacted)
//! <name>/gen-<n>/        per-generation source, home and private files
//! ```
use crate::durability::FactoryLock;
use crate::proxy::{self, ProxyPlan};
use crate::runtimes::{self, GuestContext, LaunchContext, Probe, RuntimeAdapter};
use crate::secrets::Handle;
use crate::spec::{self, AgentSpec, LoadedSpec, Source};
use crate::state;
use crate::substrate::{
    self, codes, CreateRequest, FabricError, Phase, PhaseClock, Resource, ResourceJournal, Substrate,
};
use crate::target::{ResolvedTarget, TargetCatalog};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

pub const AGENT_STATE_SCHEMA_VERSION: u32 = 1;
const JOURNAL_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Ready,
    Destroyed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AgentRecord {
    pub schema_version: u32,
    pub name: String,
    pub tenant_id: String,
    pub runtime: String,
    /// The target name from placement.
    pub target: String,
    pub substrate: String,
    pub generation: u64,
    pub fingerprint: String,
    pub idempotency_key: String,
    pub spec: AgentSpec,
    pub status: AgentStatus,
    pub resources: Vec<Resource>,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub ready_ms: Option<u64>,
    #[serde(default)]
    pub first_task_id: Option<String>,
    /// The credential proxy's management API (reload).
    #[serde(default)]
    pub proxy_management: Option<String>,
    /// Salted digest of the secret values the proxy holds; a change means
    /// the values were rotated.
    #[serde(default)]
    pub secrets_digest: Option<String>,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct JournalEntry {
    schema_version: u32,
    event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    generation: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resource: Option<Resource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    idempotency_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    /// On `commit`: the previous generation's resources, which the commit
    /// supersedes. Recorded atomically with the commit so a crash before they
    /// are retired still leaves them on record.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    retire: Vec<Resource>,
    timestamp_ms: u64,
}

/// A resource the journal says may exist but no committed record owns.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Remain {
    pub target: String,
    pub resource: Resource,
    pub reason: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct ValidateResult {
    pub name: String,
    pub tenant_id: String,
    pub runtime: String,
    pub substrate: String,
    pub fingerprint: String,
    pub secrets: usize,
    pub egress_allow: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FieldChange {
    pub field: String,
    pub from: serde_json::Value,
    pub to: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlanResult {
    pub name: String,
    /// `create`, `replace`, `restart` or `none`.
    pub action: &'static str,
    pub reason: String,
    pub changes: Vec<FieldChange>,
    pub current_generation: Option<u64>,
    pub fingerprint: String,
    pub idempotency_key: String,
    pub remains: Vec<Remain>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResourceStatus {
    #[serde(flatten)]
    pub resource: Resource,
    pub alive: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatusResult {
    pub name: String,
    pub tenant_id: Option<String>,
    pub runtime: Option<String>,
    pub target: Option<String>,
    /// `ready`, `degraded`, `destroyed` or `absent`.
    pub status: &'static str,
    pub generation: Option<u64>,
    pub fingerprint: Option<String>,
    pub endpoint: Option<String>,
    pub ready_ms: Option<u64>,
    pub resources: Vec<ResourceStatus>,
    pub remains: Vec<Remain>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApplyResult {
    pub name: String,
    pub tenant_id: String,
    pub runtime: String,
    pub target: String,
    pub generation: u64,
    pub fingerprint: String,
    pub idempotency_key: String,
    pub endpoint: Option<String>,
    /// Request-to-first-accepted-task in milliseconds, measured by the
    /// control plane. Absent when nothing was started.
    pub ready_ms: Option<u64>,
    pub first_task_id: Option<String>,
    /// Where `ready_ms` went: each apply step, timed from the request.
    /// Empty when nothing was started.
    pub phases: Vec<Phase>,
    pub resources: Vec<Resource>,
    pub recovered: Vec<Remain>,
    pub retired: Vec<Resource>,
    /// Secret env names whose values were rotated in the running proxy
    /// (reload, no restart).
    pub rotated: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DestroyResult {
    pub name: String,
    pub destroyed: Vec<Resource>,
    pub recovered: Vec<Remain>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogsResult {
    pub name: String,
    pub stream: String,
    pub text: String,
}

/// An outcome plus whether it changed anything.
pub struct Outcome<T> {
    pub changed: bool,
    pub result: T,
}

pub struct Fabric {
    pub state_root: PathBuf,
    pub catalog: TargetCatalog,
}

impl Fabric {
    pub fn new(state_root: PathBuf, catalog: TargetCatalog) -> Self {
        Self {
            state_root,
            catalog,
        }
    }

    pub fn default_state_root() -> PathBuf {
        crate::bimo::var_os("STATE_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| crate::bimo::local_path("agents"))
    }

    pub fn load_spec(&self, path: &Path) -> Result<LoadedSpec, FabricError> {
        spec::load(path, &self.catalog).map_err(|errors| {
            let mut error = FabricError::new(
                codes::SPEC_INVALID,
                format!(
                    "spec '{}' has {} problem(s): {}",
                    path.display(),
                    errors.len(),
                    errors
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join("; ")
                ),
            )
            .next(format!(
                "fix the listed fields in {} and run 'bimo agent validate {}'",
                path.display(),
                path.display()
            ));
            error.details = errors
                .iter()
                .map(|e| serde_json::json!({"field": e.field, "message": e.message}))
                .collect();
            error
        })
    }

    pub fn validate(&self, path: &Path) -> Result<ValidateResult, FabricError> {
        let loaded = self.load_spec(path)?;
        Ok(ValidateResult {
            name: loaded.spec.name.clone(),
            tenant_id: loaded.spec.tenant_id.clone(),
            runtime: loaded.spec.runtime.clone(),
            substrate: loaded.spec.placement.substrate.clone(),
            fingerprint: loaded.fingerprint.clone(),
            secrets: loaded.spec.secrets.len(),
            egress_allow: loaded.spec.egress.allow.clone(),
        })
    }

    fn agent_dir(&self, name: &str) -> Result<PathBuf, FabricError> {
        if !crate::secrets::is_identifier(name) {
            return Err(FabricError::new(
                codes::USAGE,
                format!("'{name}' is not a valid agent name"),
            ));
        }
        Ok(self.state_root.join(name))
    }

    fn target(&self, name: &str) -> Result<ResolvedTarget, FabricError> {
        self.catalog
            .resolve(Some(name))
            .map_err(|message| FabricError::new(codes::TARGET_UNKNOWN, message))
    }

    fn driver(&self, target_name: &str) -> Result<Box<dyn Substrate>, FabricError> {
        substrate::driver_for(&self.target(target_name)?)
    }

    pub fn plan(&self, path: &Path) -> Result<PlanResult, FabricError> {
        let loaded = self.load_spec(path)?;
        let dir = self.agent_dir(&loaded.spec.name)?;
        let record = read_record(&dir)?;
        let remains = remains(&dir)?;
        let key = idempotency_key(&loaded);
        check_tenant(record.as_ref(), &loaded.spec)?;
        let (action, reason, changes) = match record.as_ref() {
            None => ("create", "no agent with this name exists".to_owned(), Vec::new()),
            Some(record) if record.status == AgentStatus::Destroyed => (
                "create",
                "the agent was destroyed".to_owned(),
                Vec::new(),
            ),
            Some(record) => {
                let changes = diff(&record.spec, &loaded.spec, record.fingerprint != loaded.fingerprint);
                if !changes.is_empty() {
                    ("replace", "the spec differs from what runs".to_owned(), changes)
                } else {
                    let driver = self.driver(&record.target)?;
                    let dead = dead_resources(driver.as_ref(), record)?;
                    if dead.is_empty() {
                        ("none", "what runs matches the spec".to_owned(), Vec::new())
                    } else {
                        (
                            "restart",
                            format!("{} resource(s) are not running: {}", dead.len(), dead.join(", ")),
                            Vec::new(),
                        )
                    }
                }
            }
        };
        Ok(PlanResult {
            name: loaded.spec.name.clone(),
            action,
            reason,
            changes,
            current_generation: record.as_ref().map(|r| r.generation),
            fingerprint: loaded.fingerprint.clone(),
            idempotency_key: key,
            remains,
        })
    }

    pub fn apply(&self, path: &Path, started: Instant) -> Result<Outcome<ApplyResult>, FabricError> {
        let loaded = self.load_spec(path)?;
        let spec = &loaded.spec;
        let adapter = runtimes::lookup(&spec.runtime).ok_or_else(|| {
            FabricError::new(codes::SPEC_INVALID, format!("unknown runtime '{}'", spec.runtime))
        })?;
        let target = self.target(&spec.placement.substrate)?;
        let driver = substrate::driver_for(&target)?;
        let dir = self.agent_dir(&spec.name)?;
        fs::create_dir_all(&dir)
            .map_err(|e| FabricError::io(codes::STATE_FAILED, "could not create agent state", e))?;
        let _lock = FactoryLock::acquire(&dir)
            .map_err(|e| FabricError::io(codes::STATE_FAILED, "could not lock agent state", e))?;
        let previous = read_record(&dir)?;
        check_tenant(previous.as_ref(), spec)?;
        let recovered = self.recover(&dir)?;
        let key = idempotency_key(&loaded);

        // Every handle must resolve before anything is touched.
        let mut secret_values = Vec::new();
        for (secret, handle) in loaded.handles() {
            let value = target.secret_source.resolve(&handle).map_err(|error| {
                FabricError::new(codes::SECRET_UNRESOLVED, error.to_string()).next(format!(
                    "provide secret '{}' for {} in the target's secret source, then apply again",
                    handle, secret.env
                ))
            })?;
            secret_values.push((secret.env.clone(), value));
        }
        let control_key = control_key(&dir)?;
        let digest = proxy::secrets_digest(&control_key, &secret_values);

        if let Some(record) = previous.as_ref() {
            if record.status == AgentStatus::Ready
                && record.fingerprint == loaded.fingerprint
                && record.target == spec.placement.substrate
                && dead_resources(driver.as_ref(), record)?.is_empty()
            {
                let mut rotated = Vec::new();
                if record.secrets_digest.as_deref() != Some(digest.as_str()) {
                    rotated = self.rotate_secrets(driver.as_ref(), &dir, record, &secret_values, &digest)?;
                }
                let record = read_record(&dir)?.unwrap_or_else(|| record.clone());
                return Ok(Outcome {
                    changed: !recovered.is_empty() || !rotated.is_empty(),
                    result: ApplyResult {
                        name: record.name.clone(),
                        tenant_id: record.tenant_id.clone(),
                        runtime: record.runtime.clone(),
                        target: record.target.clone(),
                        generation: record.generation,
                        fingerprint: record.fingerprint.clone(),
                        idempotency_key: key,
                        endpoint: record.endpoint.clone(),
                        ready_ms: None,
                        first_task_id: None,
                        phases: Vec::new(),
                        resources: record.resources.clone(),
                        recovered,
                        retired: Vec::new(),
                        rotated,
                    },
                });
            }
        }

        let generation = next_generation(&dir, previous.as_ref())?;
        let mut journal = Journal::open(&dir, generation, &spec.placement.substrate)?;
        journal.write(JournalEntry {
            fingerprint: Some(loaded.fingerprint.clone()),
            idempotency_key: Some(key.clone()),
            ..journal.entry("intent")
        })?;

        let generation_dir = dir.join(format!("gen-{generation}"));
        let clock = PhaseClock::new(started);
        clock.mark("validate");
        let result = self.start_generation(
            &loaded,
            adapter,
            driver.as_ref(),
            &mut journal,
            &generation_dir,
            &dir,
            &control_key,
            &secret_values,
            target.upstream_deny_cidrs(),
            &clock,
        );
        let (created, ready_ms, task_id) = match result {
            Ok(value) => value,
            Err((error, touched)) => {
                for resource in touched.iter().rev() {
                    let _ = driver.destroy(resource);
                    let _ = journal.write(JournalEntry {
                        resource: Some(resource.clone()),
                        ..journal.entry("cleared")
                    });
                }
                let _ = journal.write(JournalEntry {
                    detail: Some(error.message.chars().take(256).collect()),
                    ..journal.entry("rollback")
                });
                let _ = fs::remove_dir_all(&generation_dir);
                return Err(error);
            }
        };

        let record = AgentRecord {
            schema_version: AGENT_STATE_SCHEMA_VERSION,
            name: spec.name.clone(),
            tenant_id: spec.tenant_id.clone(),
            runtime: spec.runtime.clone(),
            target: spec.placement.substrate.clone(),
            substrate: driver.kind().to_owned(),
            generation,
            fingerprint: loaded.fingerprint.clone(),
            idempotency_key: key.clone(),
            spec: spec.clone(),
            status: AgentStatus::Ready,
            resources: created.resources.clone(),
            endpoint: Some(created.endpoint.base_url.clone()),
            ready_ms: Some(ready_ms),
            first_task_id: Some(task_id.clone()),
            proxy_management: created.proxy_management.clone(),
            secrets_digest: Some(digest),
            updated_at_ms: now_ms(),
        };
        if let Err(error) = write_record(&dir, &record) {
            for resource in created.resources.iter().rev() {
                let _ = driver.destroy(resource);
            }
            let _ = journal.write(journal.entry("rollback"));
            return Err(error);
        }
        let superseded = previous
            .as_ref()
            .filter(|r| r.status == AgentStatus::Ready)
            .map(|r| r.resources.clone())
            .unwrap_or_default();
        journal.write(JournalEntry {
            retire: superseded,
            ..journal.entry("commit")
        })?;

        // Retire the previous generation only after the new one is committed.
        let mut retired = Vec::new();
        if let Some(old) = previous.as_ref().filter(|r| r.status == AgentStatus::Ready) {
            let old_driver = self.driver(&old.target)?;
            old_driver.collect_audit(&old.resources, &dir.join("logs").join("egress-audit.jsonl"));
            for resource in old.resources.iter().rev() {
                journal.write(JournalEntry {
                    resource: Some(resource.clone()),
                    target: Some(old.target.clone()),
                    ..journal.entry("retiring")
                })?;
                old_driver.destroy(resource)?;
                journal.write(JournalEntry {
                    resource: Some(resource.clone()),
                    ..journal.entry("cleared")
                })?;
                retired.push(resource.clone());
            }
            let _ = fs::remove_dir_all(dir.join(format!("gen-{}", old.generation)));
        }

        Ok(Outcome {
            changed: true,
            result: ApplyResult {
                name: record.name,
                tenant_id: record.tenant_id,
                runtime: record.runtime,
                target: record.target,
                generation,
                fingerprint: record.fingerprint,
                idempotency_key: key,
                endpoint: record.endpoint,
                ready_ms: Some(ready_ms),
                first_task_id: Some(task_id),
                phases: clock.phases(),
                resources: record.resources,
                recovered,
                retired,
                rotated: Vec::new(),
            },
        })
    }

    /// Rotate secret values in the running proxy: rewrite its secret files,
    /// reload it and record the new digest. The agent is not restarted; its
    /// placeholders do not change.
    fn rotate_secrets(
        &self,
        driver: &dyn Substrate,
        dir: &Path,
        record: &AgentRecord,
        secrets: &[(String, String)],
        digest: &str,
    ) -> Result<Vec<String>, FabricError> {
        driver
            .rotate_secrets(
                &dir.join(format!("gen-{}", record.generation)),
                &record.resources,
                record.proxy_management.as_deref(),
                secrets,
            )
            .map_err(|error| error.next(format!("bimo agent destroy {}, then apply again", record.name)))?;
        let mut updated = record.clone();
        updated.secrets_digest = Some(digest.to_owned());
        updated.updated_at_ms = now_ms();
        write_record(dir, &updated)?;
        let mut journal = Journal::open(dir, record.generation, &record.target)?;
        let names: Vec<String> = secrets.iter().map(|(env, _)| env.clone()).collect();
        journal.write(JournalEntry {
            detail: Some(format!("reloaded proxy secrets: {}", names.join(", "))),
            ..journal.entry("secrets_rotated")
        })?;
        Ok(names)
    }

    /// Materialize the source, create resources through the driver, then
    /// probe until the runtime accepts its first task. On failure, returns the
    /// resources that were touched so the caller can clear them.
    #[allow(clippy::too_many_arguments)]
    fn start_generation(
        &self,
        loaded: &LoadedSpec,
        adapter: &'static dyn RuntimeAdapter,
        driver: &dyn Substrate,
        journal: &mut Journal,
        generation_dir: &Path,
        agent_dir: &Path,
        control_key: &str,
        secret_values: &[(String, String)],
        upstream_deny_cidrs: Option<Vec<String>>,
        clock: &PhaseClock,
    ) -> Result<(substrate::Created, u64, String), (FabricError, Vec<Resource>)> {
        let spec = &loaded.spec;
        let fail = |error: FabricError| (error, Vec::new());
        let _ = fs::remove_dir_all(generation_dir);
        let source_dir = generation_dir.join("source");
        let home_dir = generation_dir.join("home");
        fs::create_dir_all(&home_dir)
            .map_err(|e| fail(FabricError::io(codes::STATE_FAILED, "could not create agent home", e)))?;
        materialize_source(loaded, &source_dir).map_err(fail)?;
        clock.mark("source");

        let mut env = BTreeMap::new();
        for secret in &spec.secrets {
            let nonce = placeholder_nonce(control_key, &secret.env);
            env.insert(secret.env.clone(), adapter.placeholder(secret, &nonce));
        }
        let prepare_context = LaunchContext {
            spec,
            source_dir: &source_dir,
            home_dir: &home_dir,
            bind_host: "127.0.0.1",
            port: 0,
            control_key,
            guest: driver.kind() != "local",
        };
        adapter.prepare(&prepare_context).map_err(|message| {
            fail(FabricError::new(codes::SOURCE_FAILED, message).next(format!(
                "check the {} source and the runtime's build output",
                spec.runtime
            )))
        })?;
        clock.mark("prepare");
        let log_path = agent_dir.join("logs").join("agent.log");
        let proxy_plan = ProxyPlan::prepare(
            spec,
            secret_values,
            env.clone(),
            generation_dir,
            agent_dir.join("logs").join("egress-audit.jsonl"),
            upstream_deny_cidrs,
            driver.proxy_placement(),
        )
        .map_err(fail)?;
        clock.mark("proxy_plan");
        let recipe = |bind_host: &str, port: u16| {
            let context = LaunchContext {
                spec,
                source_dir: &source_dir,
                home_dir: &home_dir,
                bind_host,
                port,
                control_key,
                guest: false,
            };
            let mut recipe = adapter.launch(&context).map_err(|message| {
                FabricError::new(codes::RUNTIME_UNAVAILABLE, message)
                    .next(format!("install the {} runtime on the substrate", spec.runtime))
            })?;
            for (key, value) in &env {
                recipe.env.insert(key.clone(), value.clone());
            }
            Ok(recipe)
        };
        let guest_recipe = |port: u16| {
            let context = GuestContext {
                spec,
                source_dir: &source_dir,
                control_key,
                port,
            };
            let mut recipe = adapter.guest(&context).map_err(|message| {
                FabricError::new(codes::RUNTIME_UNAVAILABLE, message)
                    .next("place the agent on 'local', or add a guest recipe to its runtime adapter")
            })?;
            for (key, value) in &env {
                recipe.env.insert(key.clone(), value.clone());
            }
            Ok(recipe)
        };
        let request = CreateRequest {
            agent: &spec.name,
            tenant: &spec.tenant_id,
            runtime: &spec.runtime,
            generation: journal.generation,
            generation_dir,
            log_path: &log_path,
            recipe: &recipe,
            guest_recipe: &guest_recipe,
            control_key,
            proxy: &proxy_plan,
            clock,
        };
        let created = match driver.create(&request, journal) {
            Ok(created) => created,
            Err(error) => return Err((error, journal.touched.clone())),
        };
        inject_crash("created");

        let timeout = ready_timeout();
        let mut last;
        // Liveness is cheap locally but an API call on a guest substrate, so
        // it is checked every couple of seconds, not on every probe.
        let mut checked_alive = Instant::now();
        let failed = |error: FabricError| {
            driver.collect_logs(generation_dir, &created.resources, &log_path);
            (error, created.resources.clone())
        };
        let mut probes = 0u32;
        loop {
            probes += 1;
            match adapter.probe(&created.endpoint) {
                Probe::Accepted(task_id) => {
                    clock.mark(&format!("first_task_accepted after {probes} probe(s)"));
                    let ready_ms = clock.elapsed_ms();
                    journal
                        .write(JournalEntry {
                            detail: Some(format!("ready_ms={ready_ms} task={task_id}")),
                            ..journal.entry("ready")
                        })
                        .map_err(|e| (e, created.resources.clone()))?;
                    adapter.settle(&created.endpoint, &task_id);
                    if let Err(message) = adapter.state_check(&created.endpoint, spec) {
                        return Err(failed(
                            FabricError::new(codes::RUNTIME_STATE, message).next(
                                "check the runtime's credentials and auth configuration; the agent was not committed",
                            ),
                        ));
                    }
                    return Ok((created, ready_ms, task_id));
                }
                Probe::Rejected(reason) => {
                    return Err(failed(
                        FabricError::new(
                            codes::PROBE_FAILED,
                            format!("{} refused its first task: {reason}", spec.runtime),
                        )
                        .next(format!("bimo agent logs {}", spec.name)),
                    ));
                }
                Probe::NotReady(reason) => last = reason,
            }
            if driver.kind() == "local" || checked_alive.elapsed() >= Duration::from_secs(2) {
                checked_alive = Instant::now();
                let all_alive = created
                    .resources
                    .iter()
                    .all(|resource| driver.alive(resource).unwrap_or(false));
                if !all_alive {
                    return Err(failed(
                        FabricError::new(
                            codes::PROBE_FAILED,
                            format!("{} exited before accepting its first task", spec.runtime),
                        )
                        .next(format!("bimo agent logs {}", spec.name)),
                    ));
                }
            }
            if clock.elapsed() > timeout {
                return Err(failed(
                    FabricError::new(
                        codes::PROBE_FAILED,
                        format!(
                            "{} did not accept a first task within {} ms (last: {last})",
                            spec.runtime,
                            timeout.as_millis()
                        ),
                    )
                    .next(format!("bimo agent logs {}", spec.name)),
                ));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    /// Clear whatever an interrupted apply or destroy left behind.
    fn recover(&self, dir: &Path) -> Result<Vec<Remain>, FabricError> {
        let found = remains(dir)?;
        if found.is_empty() {
            return Ok(found);
        }
        let mut journal = Journal::open(dir, 0, "")?;
        for remain in &found {
            let driver = self.driver(&remain.target)?;
            driver.destroy(&remain.resource)?;
            journal.write(JournalEntry {
                resource: Some(remain.resource.clone()),
                ..journal.entry("cleared")
            })?;
        }
        for generation in open_intents(dir)? {
            journal.write(JournalEntry {
                generation: Some(generation),
                detail: Some("recovered after an interrupted apply".to_owned()),
                ..journal.entry("rollback")
            })?;
        }
        Ok(found)
    }

    pub fn status(&self, name: &str) -> Result<StatusResult, FabricError> {
        let dir = self.agent_dir(name)?;
        let record = read_record(&dir)?;
        let remains = remains(&dir)?;
        let Some(record) = record else {
            if remains.is_empty() {
                return Err(FabricError::new(
                    codes::NOT_FOUND,
                    format!("no agent named '{name}' under {}", self.state_root.display()),
                )
                .next("bimo agent list"));
            }
            return Ok(StatusResult {
                name: name.to_owned(),
                tenant_id: None,
                runtime: None,
                target: None,
                status: "absent",
                generation: None,
                fingerprint: None,
                endpoint: None,
                ready_ms: None,
                resources: Vec::new(),
                remains,
            });
        };
        let driver = self.driver(&record.target)?;
        let mut resources = Vec::new();
        for resource in &record.resources {
            resources.push(ResourceStatus {
                alive: driver.alive(resource)?,
                resource: resource.clone(),
            });
        }
        let status = match record.status {
            AgentStatus::Destroyed => "destroyed",
            AgentStatus::Ready if resources.iter().all(|r| r.alive) => "ready",
            AgentStatus::Ready => "degraded",
        };
        Ok(StatusResult {
            name: record.name.clone(),
            tenant_id: Some(record.tenant_id.clone()),
            runtime: Some(record.runtime.clone()),
            target: Some(record.target.clone()),
            status,
            generation: Some(record.generation),
            fingerprint: Some(record.fingerprint.clone()),
            endpoint: record.endpoint.clone(),
            ready_ms: record.ready_ms,
            resources,
            remains,
        })
    }

    pub fn list(&self) -> Result<Vec<StatusResult>, FabricError> {
        let mut out = Vec::new();
        let entries = match fs::read_dir(&self.state_root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(error) => {
                return Err(FabricError::io(codes::STATE_FAILED, "could not read state root", error));
            }
        };
        let mut names: Vec<String> = entries
            .filter_map(Result::ok)
            .filter(|entry| entry.path().join("journal.jsonl").exists())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        names.sort();
        for name in names {
            out.push(self.status(&name)?);
        }
        Ok(out)
    }

    pub fn destroy(&self, name: &str) -> Result<Outcome<DestroyResult>, FabricError> {
        let dir = self.agent_dir(name)?;
        if !dir.join("journal.jsonl").exists() {
            return Err(FabricError::new(
                codes::NOT_FOUND,
                format!("no agent named '{name}' under {}", self.state_root.display()),
            )
            .next("bimo agent list"));
        }
        let _lock = FactoryLock::acquire(&dir)
            .map_err(|e| FabricError::io(codes::STATE_FAILED, "could not lock agent state", e))?;
        let recovered = self.recover(&dir)?;
        let Some(mut record) = read_record(&dir)? else {
            return Ok(Outcome {
                changed: !recovered.is_empty(),
                result: DestroyResult {
                    name: name.to_owned(),
                    destroyed: Vec::new(),
                    recovered,
                },
            });
        };
        if record.status == AgentStatus::Destroyed {
            return Ok(Outcome {
                changed: !recovered.is_empty(),
                result: DestroyResult {
                    name: name.to_owned(),
                    destroyed: Vec::new(),
                    recovered,
                },
            });
        }
        let driver = self.driver(&record.target)?;
        // A remote proxy's audit goes with its route; keep a copy first.
        driver.collect_audit(&record.resources, &dir.join("logs").join("egress-audit.jsonl"));
        let mut journal = Journal::open(&dir, record.generation, &record.target)?;
        let mut destroyed = Vec::new();
        for resource in record.resources.iter().rev() {
            journal.write(JournalEntry {
                resource: Some(resource.clone()),
                ..journal.entry("destroying")
            })?;
            inject_crash("destroying");
            driver.destroy(resource)?;
            journal.write(JournalEntry {
                resource: Some(resource.clone()),
                ..journal.entry("cleared")
            })?;
            destroyed.push(resource.clone());
        }
        record.status = AgentStatus::Destroyed;
        record.resources.clear();
        record.endpoint = None;
        record.updated_at_ms = now_ms();
        write_record(&dir, &record)?;
        journal.write(journal.entry("destroyed"))?;
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.filter_map(Result::ok) {
                if entry.file_name().to_string_lossy().starts_with("gen-") {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
        Ok(Outcome {
            changed: true,
            result: DestroyResult {
                name: name.to_owned(),
                destroyed,
                recovered,
            },
        })
    }

    pub fn logs(&self, name: &str, stream: &str) -> Result<LogsResult, FabricError> {
        let dir = self.agent_dir(name)?;
        if !dir.join("journal.jsonl").exists() {
            return Err(FabricError::new(
                codes::NOT_FOUND,
                format!("no agent named '{name}'"),
            )
            .next("bimo agent list"));
        }
        let file = match stream {
            "agent" => dir.join("logs").join("agent.log"),
            "egress" => dir.join("logs").join("egress-audit.jsonl"),
            "journal" => dir.join("journal.jsonl"),
            other => {
                return Err(FabricError::new(
                    codes::USAGE,
                    format!("unknown log stream '{other}'"),
                )
                .next("use --stream agent, egress or journal"));
            }
        };
        if stream == "agent" || stream == "egress" {
            // A guest substrate keeps the runtime's output in the guest and
            // a remote proxy keeps its audit with it; fetch them first. Best
            // effort.
            if let Some(record) = read_record(&dir)?.filter(|r| r.status == AgentStatus::Ready) {
                if let Ok(driver) = self.driver(&record.target) {
                    if stream == "agent" {
                        driver.collect_logs(&dir.join(format!("gen-{}", record.generation)), &record.resources, &file);
                    } else {
                        driver.collect_audit(&record.resources, &file);
                    }
                }
            }
        }
        let text = tail(&file, 256 * 1024)
            .map_err(|e| FabricError::io(codes::STATE_FAILED, "could not read log", e))?;
        let text = if stream == "agent" {
            crate::runtime::redact(&text)
        } else {
            text
        };
        Ok(LogsResult {
            name: name.to_owned(),
            stream: stream.to_owned(),
            text,
        })
    }
}

fn check_tenant(record: Option<&AgentRecord>, spec: &AgentSpec) -> Result<(), FabricError> {
    if let Some(record) = record {
        if record.tenant_id != spec.tenant_id && record.status != AgentStatus::Destroyed {
            return Err(FabricError::new(
                codes::TENANT_CONFLICT,
                format!(
                    "agent '{}' belongs to tenant '{}', not '{}'",
                    spec.name, record.tenant_id, spec.tenant_id
                ),
            )
            .next("choose another agent name, or destroy the existing agent first"));
        }
    }
    Ok(())
}

fn dead_resources(driver: &dyn Substrate, record: &AgentRecord) -> Result<Vec<String>, FabricError> {
    let mut dead = Vec::new();
    for resource in &record.resources {
        if !driver.alive(resource)? {
            dead.push(resource.id.clone());
        }
    }
    Ok(dead)
}

fn diff(old: &AgentSpec, new: &AgentSpec, fingerprint_changed: bool) -> Vec<FieldChange> {
    let old_value = serde_json::to_value(old).unwrap_or_default();
    let new_value = serde_json::to_value(new).unwrap_or_default();
    let mut changes = Vec::new();
    if let (Some(old_map), Some(new_map)) = (old_value.as_object(), new_value.as_object()) {
        for (key, value) in new_map {
            let before = old_map.get(key).cloned().unwrap_or(serde_json::Value::Null);
            if before != *value {
                changes.push(FieldChange {
                    field: key.clone(),
                    from: before,
                    to: value.clone(),
                });
            }
        }
    }
    if changes.is_empty() && fingerprint_changed {
        changes.push(FieldChange {
            field: "source.content".to_owned(),
            from: serde_json::Value::String("previous config content".to_owned()),
            to: serde_json::Value::String("changed config content".to_owned()),
        });
    }
    changes
}

fn idempotency_key(loaded: &LoadedSpec) -> String {
    let digest = Sha256::digest(format!("apply\0{}\0{}", loaded.spec.name, loaded.fingerprint));
    format!("{digest:x}")[..32].to_owned()
}

fn placeholder_nonce(control_key: &str, env: &str) -> String {
    let digest = Sha256::digest(format!("placeholder\0{control_key}\0{env}"));
    format!("{digest:x}")[..48].to_owned()
}

fn materialize_source(loaded: &LoadedSpec, dest: &Path) -> Result<(), FabricError> {
    match &loaded.spec.source {
        Source::Config { .. } => {
            let from = loaded.source_dir.as_ref().ok_or_else(|| {
                FabricError::new(codes::SOURCE_FAILED, "config source directory is missing")
            })?;
            copy_dir(from, dest).map_err(|e| {
                FabricError::io(codes::SOURCE_FAILED, "could not copy the config source", e)
            })
        }
        Source::Git { repo, rev } => {
            let run = |args: &[&str], cwd: Option<&Path>| -> Result<String, FabricError> {
                let mut command = Command::new("git");
                command.args(args).env("GIT_TERMINAL_PROMPT", "0");
                if let Some(cwd) = cwd {
                    command.current_dir(cwd);
                }
                let output = command.output().map_err(|e| {
                    FabricError::io(codes::SOURCE_FAILED, "could not run git", e)
                })?;
                if !output.status.success() {
                    return Err(FabricError::new(
                        codes::SOURCE_FAILED,
                        format!(
                            "git {} failed: {}",
                            args.first().unwrap_or(&""),
                            String::from_utf8_lossy(&output.stderr).trim()
                        ),
                    )
                    .next(format!("check that {repo} is reachable and contains {rev}")));
                }
                Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
            };
            // A repository given as a relative path is relative to the spec.
            let repo = if repo.contains("://") || repo.starts_with("git@") || Path::new(repo).is_absolute() {
                repo.clone()
            } else {
                loaded
                    .path
                    .parent()
                    .unwrap_or_else(|| Path::new("."))
                    .join(repo)
                    .to_string_lossy()
                    .into_owned()
            };
            run(
                &["clone", "--quiet", "--no-checkout", &repo, &dest.to_string_lossy()],
                None,
            )?;
            run(&["-c", "advice.detachedHead=false", "checkout", "--quiet", rev], Some(dest))?;
            let head = run(&["rev-parse", "HEAD"], Some(dest))?;
            if head != *rev {
                return Err(FabricError::new(
                    codes::SOURCE_FAILED,
                    format!("checked out {head}, expected {rev}"),
                ));
            }
            Ok(())
        }
    }
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn control_key(dir: &Path) -> Result<String, FabricError> {
    let path = dir.join("control.key");
    if let Ok(existing) = fs::read_to_string(&path) {
        if existing.trim().len() >= 32 {
            return Ok(existing.trim().to_owned());
        }
    }
    let mut bytes = [0u8; 32];
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(|e| FabricError::io(codes::STATE_FAILED, "could not read randomness", e))?;
    let key: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    state::atomic_write(&path, key.as_bytes(), 0o600)
        .map_err(|e| FabricError::io(codes::STATE_FAILED, "could not write control key", e))?;
    Ok(key)
}

fn read_record(dir: &Path) -> Result<Option<AgentRecord>, FabricError> {
    let path = dir.join("agent.json");
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(FabricError::io(codes::STATE_FAILED, "could not read agent state", error));
        }
    };
    let record: AgentRecord = serde_json::from_slice(&bytes).map_err(|error| {
        FabricError::new(
            codes::STATE_FAILED,
            format!("agent state {} is invalid: {error}", path.display()),
        )
    })?;
    if record.schema_version != AGENT_STATE_SCHEMA_VERSION {
        return Err(FabricError::new(
            codes::STATE_FAILED,
            format!(
                "agent state {} has schema version {}, expected {}",
                path.display(),
                record.schema_version,
                AGENT_STATE_SCHEMA_VERSION
            ),
        ));
    }
    Ok(Some(record))
}

fn write_record(dir: &Path, record: &AgentRecord) -> Result<(), FabricError> {
    let bytes = serde_json::to_vec_pretty(record)
        .map_err(|e| FabricError::new(codes::STATE_FAILED, e.to_string()))?;
    state::atomic_write(&dir.join("agent.json"), &bytes, 0o600)
        .map_err(|e| FabricError::io(codes::STATE_FAILED, "could not write agent state", e))
}

struct Journal {
    path: PathBuf,
    generation: u64,
    target: String,
    touched: Vec<Resource>,
}

impl Journal {
    fn open(dir: &Path, generation: u64, target: &str) -> Result<Self, FabricError> {
        Ok(Self {
            path: dir.join("journal.jsonl"),
            generation,
            target: target.to_owned(),
            touched: Vec::new(),
        })
    }

    fn entry(&self, event: &str) -> JournalEntry {
        JournalEntry {
            schema_version: JOURNAL_SCHEMA_VERSION,
            event: event.to_owned(),
            generation: (self.generation > 0).then_some(self.generation),
            target: (!self.target.is_empty()).then(|| self.target.clone()),
            resource: None,
            fingerprint: None,
            idempotency_key: None,
            detail: None,
            retire: Vec::new(),
            timestamp_ms: now_ms(),
        }
    }

    fn write(&mut self, entry: JournalEntry) -> Result<(), FabricError> {
        let event = entry.event.clone();
        crate::durability::append(&self.path, &entry)
            .map_err(|e| FabricError::io(codes::STATE_FAILED, "could not write the journal", e))?;
        inject_crash(&event);
        if let Some(kind) = entry
            .resource
            .as_ref()
            .and_then(|r| serde_json::to_value(r.kind).ok())
            .and_then(|v| v.as_str().map(str::to_owned))
        {
            inject_crash(&format!("{event}:{kind}"));
        }
        Ok(())
    }
}

impl ResourceJournal for Journal {
    fn touching(&mut self, resource: &Resource) -> Result<(), FabricError> {
        self.touched.push(resource.clone());
        self.write(JournalEntry {
            resource: Some(resource.clone()),
            ..self.entry("touching")
        })
    }

    fn created(&mut self, resource: &Resource) -> Result<(), FabricError> {
        if let Some(slot) = self.touched.iter_mut().find(|r| r.id == resource.id) {
            *slot = resource.clone();
        } else {
            self.touched.push(resource.clone());
        }
        self.write(JournalEntry {
            resource: Some(resource.clone()),
            ..self.entry("created")
        })
    }
}

fn read_journal(dir: &Path) -> Result<Vec<JournalEntry>, FabricError> {
    let path = dir.join("journal.jsonl");
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(FabricError::io(codes::STATE_FAILED, "could not read the journal", error)),
    };
    let mut entries = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        // A torn final line from a crash mid-write is ignored; every complete
        // line was fsynced before the next step ran.
        if let Ok(entry) = serde_json::from_str::<JournalEntry>(line) {
            entries.push(entry);
        }
    }
    Ok(entries)
}

/// One past the highest generation the record or the journal has used, so a
/// rolled-back generation number is never reused.
fn next_generation(dir: &Path, previous: Option<&AgentRecord>) -> Result<u64, FabricError> {
    let journaled = read_journal(dir)?
        .iter()
        .filter_map(|entry| entry.generation)
        .max()
        .unwrap_or(0);
    Ok(journaled.max(previous.map_or(0, |r| r.generation)) + 1)
}

fn open_intents(dir: &Path) -> Result<Vec<u64>, FabricError> {
    let mut open = BTreeMap::new();
    for entry in read_journal(dir)? {
        match (entry.event.as_str(), entry.generation) {
            ("intent", Some(g)) => {
                open.insert(g, ());
            }
            ("commit" | "rollback", Some(g)) => {
                open.remove(&g);
            }
            _ => {}
        }
    }
    Ok(open.into_keys().collect())
}

/// Resources the journal shows were touched but not committed, or were being
/// retired or destroyed when the process stopped.
pub fn remains(dir: &Path) -> Result<Vec<Remain>, FabricError> {
    let mut intents: BTreeMap<u64, String> = BTreeMap::new();
    let mut pending: BTreeMap<String, Remain> = BTreeMap::new();
    let mut by_generation: BTreeMap<String, u64> = BTreeMap::new();
    for entry in read_journal(dir)? {
        match entry.event.as_str() {
            "intent" => {
                if let Some(g) = entry.generation {
                    intents.insert(g, entry.target.clone().unwrap_or_default());
                }
            }
            "touching" | "created" => {
                if let (Some(resource), Some(g)) = (entry.resource, entry.generation) {
                    by_generation.insert(resource.id.clone(), g);
                    pending.insert(
                        resource.id.clone(),
                        Remain {
                            target: entry.target.unwrap_or_default(),
                            resource,
                            reason: "created by an apply that did not commit",
                        },
                    );
                }
            }
            "commit" => {
                if let Some(g) = entry.generation {
                    intents.remove(&g);
                    pending.retain(|id, _| by_generation.get(id) != Some(&g));
                }
                for resource in entry.retire {
                    pending.insert(
                        resource.id.clone(),
                        Remain {
                            target: entry.target.clone().unwrap_or_default(),
                            resource,
                            reason: "superseded by a committed generation but not yet retired",
                        },
                    );
                }
            }
            "rollback" => {
                if let Some(g) = entry.generation {
                    intents.remove(&g);
                }
            }
            "retiring" | "destroying" => {
                if let Some(resource) = entry.resource {
                    let reason = if entry.event == "retiring" {
                        "being retired when the process stopped"
                    } else {
                        "being destroyed when the process stopped"
                    };
                    pending.insert(
                        resource.id.clone(),
                        Remain {
                            target: entry.target.unwrap_or_default(),
                            resource,
                            reason,
                        },
                    );
                }
            }
            "cleared" => {
                if let Some(resource) = entry.resource {
                    pending.remove(&resource.id);
                }
            }
            _ => {}
        }
    }
    Ok(pending.into_values().collect())
}

fn tail(path: &Path, limit: u64) -> std::io::Result<String> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(error),
    };
    let len = file.metadata()?.len();
    if len > limit {
        file.seek(SeekFrom::Start(len - limit))?;
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn ready_timeout() -> Duration {
    crate::bimo::var("READY_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_secs(90))
}

/// Fault injection for crash-recovery E2E tests: when
/// `BIMO_INJECT_CRASH` (alias `MONOLITH_INJECT_CRASH`) names a journal event (`created`) or an event and
/// resource kind (`created:agent_process`), the process exits immediately
/// after writing that event, without cleanup, like a host crash.
fn inject_crash(event: &str) {
    if crate::bimo::var("INJECT_CRASH").as_deref() == Ok(event) {
        unsafe { libc::_exit(137) };
    }
}

fn now_ms() -> u64 {
    state::timestamp_millis() as u64
}

/// Used by status output: the handle a secret refers to, for display.
pub fn handle_tenant(handle: &str) -> Option<String> {
    Handle::parse(handle).ok().map(|h| h.tenant)
}
