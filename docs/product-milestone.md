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

The current bounded Docker runtime is still the only supported execution
contract. Earlier no-service/no-scheduler alpha non-goals describe that released
behavior. This milestone authorizes designing the additional service contract;
it does not declare those capabilities available or replace their acceptance gates.

## Delivery sequence and acceptance

1. **Offline deployment intent (this change).** Versioned, exact-shape,
   immutable manifest validation; packaged Raava and Aurum test examples;
   bounded CLI reads; honest unsupported execution receipts. No live migration.
2. **Internal engineering execution binding.** First resolve the existing
   [repository-profile blocker (#55)](https://github.com/zaycruz/bimo/issues/55)
   and [writer-root mismatch (#41)](https://github.com/zaycruz/bimo/issues/41).
   The current Node-only src/test profile cannot execute Pi-Palantir's TypeScript
   layout or Foundry CLI's Python suite. Add one tested repository-specific
   profile and matching template with trusted verification before increasing
   worker count. Include [asset inputs (#56)](https://github.com/zaycruz/bimo/issues/56)
   when the chosen task requires them. Bind an approved repository,
   base SHA, workflow digest, image identity and runtime to a client/agent.
   Enforce tool/credential scope and limits; run a real approved task through
   candidate/baseline verification to a draft PR with retained evidence.
   Preserve existing merge and deployment approval boundaries.
3. **Aurum service adapter in a separate test instance.** Verify the current
   deployment contract before implementation. Start/stop/status/health/logs,
   bounded restart policy, versioned configuration, upgrade and rollback must
   work without modifying Aurum's live data or domain behavior. Reuse its actual
   runtime through a closed adapter. No arbitrary executable plugin mechanism.
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
