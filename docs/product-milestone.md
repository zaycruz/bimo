# Raava internal use and Aurum integration

## Accepted product direction

The owner committed to Raava as Bimo's first operator: build Raava products
and services internally, then operate agents SMB clients can interact with.
Aurum is the first named client-facing integration. Bimo manages operational
lifecycle; Aurum retains its domain behavior, tools, client-specific data and
evaluations. This is an operational relationship, not a transfer of client IP.

Durable client/agent identity survives replaceable workers. Software factories
use bounded jobs. Client interaction may require a persistent gateway with
independently bounded requests. Inference runs on a separate approved server;
cloud fallback is an explicit client policy. Initial client execution targets
are dedicated hosts or guests; naming a directory does not prove isolation.
Brains remain outside this implementation scope.

Bounded Docker workflows remain the job execution contract. Test-only systemd
controls now manage pre-provisioned Hermes units; they do not provision an
Aurum instance or establish application health, authenticated interaction or
request recovery. The full internal-use milestone remains open.

## Delivery sequence and acceptance

1. **Offline deployment intent — shipped.** Versioned, exact-shape immutable
   manifest validation, packaged Raava/Aurum test examples and bounded CLI reads.
   Planning stays offline and does not create a deployment.
2. **Internal engineering execution — Pi-Palantir profile implemented.** The
   dedicated template matches `extensions`, `omp` and `test` writer roots. Its
   locked verification image binds dependencies and tooling to the selected
   baseline; controller-owned candidate/baseline checks preserve proof. This
   addresses the selected Pi-Palantir profile/root blockers without claiming
   generic Python support or closing every repository-profile requirement.
   **Pending:** run a real approved task through to a draft PR using the actual
   execution target, approved model and credential references, with retained
   evidence. Foundry CLI's Python profile remains separate work. Existing merge
   and deployment approval boundaries remain in force.
3. **Aurum service management — test-only controls implemented.**
   `bimo service status|start|stop|restart FILE` manages only the exact derived
   `bimo-test-<clientId>.<agentId>.service` on the manifest's explicit target.
   It checks loaded identity before mutation and process state afterward;
   restart is stop then start. No logs, secrets or production defaults.
   **Pending:** provision an independent Aurum test instance from a verified
   Hermes runtime/unit/configuration, then prove application health, channel
   behavior, upgrade/rollback and request recovery. The existing live agent
   and its data remain untouched; an active unit does not satisfy these gates.
4. **Authenticated client interaction.** Bind caller, conversation and request
   to the permitted client/agent outside model control. Requests produce durable
   IDs, bounded execution and explicit completed/failed/approval-needed results.
   Test cross-client access denial and duplicate-delivery handling.
5. **Concurrent operation and interruption recovery.** Engineering runs and
   Aurum requests share explicitly budgeted capacity without starving interactive
   work. Reconcile interrupted runs after host restart; retain evidence and
   prevent duplicate publication. Increase worker counts only after these gates.

The milestone demonstration is an approved real engineering task alongside an
Aurum test interaction, followed by a worker interruption. Both workloads must
stay isolated and reach an accurate, inspectable outcome. A mocked service or
schema-valid manifest does not satisfy this demonstration.

## Product-owner defaults

- Keep the dependency-free CLI and closed adapter registry.
- Measure accepted task results, human intervention time, per-result cost and
  recovery success. Worker count is a capacity setting.
- Keep verification controller-owned. Agents cannot weaken checks or redefine
  passing evidence, permissions, target selection or resource policy.
- Prioritize recovery, per-client credentials and admission control before a
  general graph designer, marketplace or broad customer portal.
- Client-facing agents can respond through their explicitly authorized channel;
  unrelated outreach, purchases and broader mutations need separate policy.
- No automatic adoption, migration or deletion of legacy deployment resources.

## Remaining environment evidence

Before a live test: identify the execution host/guest and isolation boundary,
approved inference endpoint and authentication, test-only Aurum configuration,
authorized interaction channel, representative task/repository and promotion
criteria. These are operational inputs to discover and validate, not reasons
to delay source-only implementation or ask the owner to repeat accepted decisions.
