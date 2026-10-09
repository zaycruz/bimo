# Agent CLI contract

`monolith agent` is built to be driven by an agent, unattended. Every command
takes `--output json` and then prints exactly one JSON envelope on stdout,
whether it succeeds or fails. The envelope's schema is
`docs/agent-cli.schema.json` (`monolith.cli/v1`); the E2E suite validates
every envelope it sees against it.

```text
monolith agent validate <spec>
monolith agent plan     <spec>
monolith agent apply    <spec>
monolith agent status   <name>
monolith agent logs     <name> [--stream agent|egress|journal]
monolith agent destroy  <name>
monolith agent list

Options (every option takes a value; there are no boolean flags):
  --output json|text        default text
  --state-root <dir>        default $MONOLITH_STATE_ROOT, then .monolith/agents
  --targets-config <file>   default .monolith/targets.toml when present
  --stream <name>           logs only
```

Specs are addressed by path; running agents by name. Unknown options,
duplicate options and wrong positional counts are `usage` errors.

## Envelope

```json
{
  "schema": "monolith.cli/v1",
  "command": "apply",
  "ok": true,
  "changed": true,
  "result": { "name": "demo-hermes", "generation": 1, "ready_ms": 1311, "first_task_id": "run_...", "...": "..." },
  "error": null,
  "next": ["monolith agent status demo-hermes"],
  "idempotency_key": "38381025cc5c1c223cb99ae02abeb2e3"
}
```

| Field | Meaning |
|---|---|
| `ok` | Whether the command did what was asked. |
| `changed` | Whether anything on a substrate or in agent state changed. Read-only commands are always `false`. |
| `result` | Command-specific object (schemas in `$defs` of the JSON schema). `null` on failure. |
| `error` | `null`, or `{code, message, details}`. Branch on `code`; `message` is for people. |
| `next` | Concrete next steps: commands to run or the fix to make. |
| `idempotency_key` | For `plan` and `apply`: derived from the agent name and spec fingerprint. Repeating an apply with the same key is safe and returns `changed: false` once converged. |

Exit status: `0` on success, `2` for `usage`, `1` for any other error.

## Commands

- **validate** checks the spec (see `docs/agent-spec.md`), resolves every
  secret handle in the target's secret source, and touches nothing.
- **plan** compares the spec with what runs and returns `action`: `create`,
  `replace` (with a field-level `changes` diff), `restart` (a resource is
  down) or `none`, plus any `remains` an interrupted run left.
- **apply** converges. It journals intent, asks the substrate driver for
  resources, waits until the runtime accepts a first task, checks the
  runtime's auth state, and commits. `ready_ms` is request to first accepted
  task, timed by the control plane (KTD7). On `local` each generation is two
  resources: the agent's credential proxy (`proxy_process`), started first,
  and the runtime (`agent_process`). On a proxmox target it is two: the
  agent's `proxy_route` in its tenant's proxy guest (started with or before
  the agent; `monolith proxy up|status|down` manages the proxy guest itself)
  and the `guest` the runtime runs in; see `docs/credential-boundary.md`.
  Records from before the proxy guest may still list a `relay_process`. The previous
  generation is retired only after the new one commits. An unchanged, healthy
  agent returns `changed: false` with nothing created, restarted or
  rewritten. If only a secret's value changed, apply reloads the running
  proxy, lists the variables in `rotated` and returns `changed: true`
  without a restart. Remains from an interrupted run are cleared first and
  listed in `recovered`.
- **status** reports `ready`, `degraded` (a resource is down), `destroyed` or
  `absent` (no committed agent, only remains), each resource's liveness, and
  `remains`.
- **logs** returns the tail of a stream: `agent` (runtime output, redacted;
  on a proxmox target fetched from the guest's bind agent first),
  `egress` (the credential proxy's audit log) or `journal`.
- **destroy** clears remains, stops every resource and marks the agent
  destroyed. Destroying again returns `changed: false`.
- **list** returns `status` for every agent under the state root.

## Error codes

| Code | Meaning | Typical next step |
|---|---|---|
| `spec_invalid` | The spec has problems; all are in `details`. | Fix the fields, run validate. |
| `target_unknown` | The placement or targets file names no known target. | Check `.monolith/targets.toml`. |
| `target_unavailable` | The target exists but its driver cannot run, for example a missing API token. | The `next` hint names the variable to export. |
| `tenant_conflict` | The agent name belongs to another tenant. | Choose another name or destroy the agent. |
| `agent_not_found` | No agent with that name under the state root. | `monolith agent list`. |
| `runtime_unavailable` | The runtime executable is not installed on the substrate. | Install it. |
| `source_failed` | Checkout, copy or build of the source failed. | Check the repo, rev and build output. |
| `substrate_failed` | The driver could not create, inspect or remove a resource. | Retry; check the substrate. |
| `substrate_refused` | The driver refused a resource outside its scope: a VMID outside the target's `vmid_range`, a guest outside its pool, or a guest without the ownership marker. Nothing was changed. | Check the target's scope settings; never widen them to reach a guest Monolith did not create. |
| `probe_failed` | The runtime exited, refused, or did not accept a first task in time (`MONOLITH_READY_TIMEOUT_MS`, default 90000). | `monolith agent logs <name>`. |
| `runtime_state_invalid` | The runtime accepted a task but is in the wrong auth mode. Nothing was committed. | Fix the runtime's auth configuration. |
| `secret_unresolved` | A handle stopped resolving between validation and launch. | Provide the secret. |
| `proxy_failed` | The credential proxy could not start or reload. | `monolith agent logs <name> --stream egress`. |
| `state_failed` | Agent state or the journal could not be read or written. | Check the state root. |
| `usage` | The command line is wrong. | `monolith help`. |

## State and recovery

Each agent has `agent.json` (versioned record, `schema_version` 1),
`journal.jsonl` and `control.key` under `<state-root>/<name>/`. The journal
records `intent`, `touching` and `created` for each resource before and after
it exists, `ready`, and `commit` (which also lists the generation it
supersedes), so a process killed at any point leaves every resource on
record. `status` and `plan` show those as `remains`; the next `apply` or
`destroy` clears them. A secret rotation adds a `secrets_rotated` event. The
E2E suite kills apply after the runtime is created, at `ready` and at
`commit` (`MONOLITH_INJECT_CRASH=<event>` or `<event>:<resource kind>`, for
example `created:agent_process`, a test-only fault hook that exits the
process right after journaling that event).

One gap is known for the local substrate: a kill in the instant between
spawning a process and journaling its pid leaves a `touching` entry without a
pid, which recovery cannot stop.
