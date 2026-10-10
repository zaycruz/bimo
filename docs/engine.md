# The Bimo engine

The Bimo engine is the Rust runtime fabric in [`engine/`](../engine/README.md).
It places spec-declared agents (Hermes and eve) on a named target, the local
machine or a Proxmox cluster, keeps a per-tenant warm pool of guests, and puts
every agent behind its own credential proxy. Bimo's Node CLI stays the user's
entry point; the engine is a separate binary, `bimo-engine`, that `bimo`
starts for the agent, pool and proxy commands.

## The seam

`bin/bimo` sends four command groups to `src/engine.mjs`, which runs
`bimo-engine` with a validated argv (at most 64 arguments, no shell,
inherited stdio) and returns its exit code:

| `bimo` command | Runs |
| --- | --- |
| `bimo agent validate\|plan\|apply\|status\|logs\|destroy\|list ...` | `bimo-engine agent ...` |
| `bimo pool status\|fill\|drain ...` | `bimo-engine pool ...` |
| `bimo proxy up\|status\|down ...` | `bimo-engine proxy ...` |
| `bimo engine ARGS...` | `bimo-engine ARGS...` unchanged |

`bimo agent --...` and `bimo proxy --...` (a flag first) are the in-container
role agent and credential proxy and are not affected. Every other command is
unchanged.

The binary is found through `BIMO_ENGINE_BIN` (an absolute path), then the
newest of `engine/target/release/bimo-engine` and
`engine/target/debug/bimo-engine`, then `PATH`. `BIMO_ENGINE_TIMEOUT_MS`
(default 30 minutes, at most 6 hours) bounds one engine run; past it the
engine gets SIGTERM and, 5 seconds later, SIGKILL.

Build it with `cargo build --release --manifest-path engine/Cargo.toml`. The
npm package does not ship the engine.

## From a deployment manifest to an engine agent

A [deployment manifest](deployment-manifests.md) whose target kind is
`engine` is executable. `bimo plan` validates it offline as before and reports
`executionSupported: true`. `bimo agent validate|plan|apply MANIFEST.json`
renders it into an engine agent spec at `.bimo/specs/<clientId>-<agentId>.toml`
(directory mode 0700, file mode 0600) and runs the engine on that spec:

| Manifest | Engine spec |
| --- | --- |
| `clientId`, `agentId` | `name = "<clientId>-<agentId>"`, `tenant_id = "<clientId>"` |
| `runtime: "hermes"`, `lifecycle: "service"` | `runtime = "hermes"` |
| `workload.config` (directory relative to the manifest) | `[source] kind = "config"` |
| `secretRefs.model` (`TENANT/NAME` handle) | `[[secrets]] env = "OPENROUTER_API_KEY"`, hosts and egress `openrouter.ai` |
| `target.name` | `[placement] substrate` |

The generated spec holds the handle, never the value. The engine resolves the
handle from its target's secret source: on `local`, the environment variable
`BIMO_SECRET_<TENANT>__<NAME>`. A manifest for any other target kind fails
with one `spec_invalid` envelope and writes no spec. The engine sizes guests
from its target configuration; the manifest's `limits` are validated but not
applied to engine agents.

`examples/deployments/engine-hermes.json` is the reference. It is proved end to
end by `node test/engine-proof.mjs`, which runs real `bimo`, real
`bimo-engine` and a real Hermes on the local target (plan, validate, apply to
the first accepted task, an unchanged re-apply, status, logs, list, destroy
twice and the negative case) and writes a transcript and `report.json` under
`engine/target/e2e-bimo/`.

## Names

The binary is `bimo-engine` and the crate `bimo_engine`. Operator settings
are `BIMO_*` variables, for example `BIMO_SECRET_<TENANT>__<NAME>`,
`BIMO_STATE_ROOT`, `BIMO_HERMES_BIN` and `BIMO_PROXMOX_LIVE`, and local state
lives under `.bimo/`. Every JSON envelope has the schema `bimo.cli/v1`.

The engine began as a separate prototype. Its earlier variable names and state
directory still work as aliases, and the names baked into the golden template
and running guests are unchanged until a template version bump.
[engine/docs/naming.md](../engine/docs/naming.md) lists them, with the renames
deferred to that bump.
