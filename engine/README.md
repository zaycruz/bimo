# Monolith — local agent factory foundation

Monolith is a Rust control plane for a small local agent factory. It reads a
TOML manifest that declares pods, starts each pod as a supervised child
process, and delivers durable work messages between pods over a versioned
JSONL worker protocol.

This release is local and single-host. It does not add remote deployment, a
hosted control plane, multi-tenancy, billing, or durable model conversation
memory.

## Commands

```text
monolith targets [--targets-config <file>]
monolith deploy <manifest> [--state-dir <dir>] [--target <name>] [--targets-config <file>]
monolith validate <manifest>
monolith plan <manifest> [--state-dir <dir>] [--target <name>] [--targets-config <file>]
monolith apply <manifest> [--state-dir <dir>] [--target <name>] [--targets-config <file>]
monolith status <state-dir> [--target <name>] [--targets-config <file>]
monolith send <state-dir> --from <pod> --to <pod> --kind <kind> --payload <text> [--target <name>] [--targets-config <file>]
monolith logs <state-dir> <pod> [--target <name>] [--targets-config <file>]
monolith destroy <state-dir> [--target <name>] [--targets-config <file>]
monolith demo <manifest> [--state-dir <dir>] [--target <name>] [--targets-config <file>]
```

`pod-process` is an internal runtime subcommand used by `apply` and `demo`.

Current implementation:

- `local` works today and preserves the existing single-host process model.
- `proxmox` has a driver (U5) and a per-tenant warm pool (U6) that create,
  bind and destroy LXC guests through the Proxmox API; no runtime runs inside a
  guest yet (U8). See `templates/README.md`. `ssh` is reserved, with no driver.
- Named targets can be declared in `.monolith/targets.toml`; only targets of
  kind `local` are executable in this release.

## Process hierarchy

```text
monolith apply
  └── Rust factory process
        └── Rust pod process
              └── selected worker adapter
                    └── model engine runtime
```

The factory owns the pod process. The pod process owns the worker adapter.
The adapter owns the model loop. No worker process receives a direct
state-directory capability.

## Local-first target seam

Monolith now keeps deployment target selection separate from workflow/runtime
execution.

- The manifest still describes the workflow and worker runtime only.
- The worker protocol still defines local pod-to-worker execution only.
- The CLI target decides where that controller/runtime should execute.

This is intentionally not a general plugin system yet. There is one working
target implementation today (`local`), so the code uses a built-in target
module instead of an early plugin registry. See `docs/local-first-targets.md`
for the target model and the planned `ssh` / `proxmox` expansion path.

Example targets file:

```toml
schema_version = 1
default_target = "local"

[[targets]]
kind = "proxmox"
name = "homelab-lxc"
api_url = "https://pve-node-b:8006/api2/json"
token_env = "MONOLITH_PROXMOX_TOKEN"
cluster = "homelab"
node = "pve-node-b"
guest_type = "lxc"
guest_id = 203
artifact_lifecycle = "persistent"
```

The `targets` command reports whether the target is autodetected or
configured, whether the target's secret reference env var is present, and
whether the current build can actually execute that target.

## Worker protocol boundary

The worker protocol is `agent-worker/v1`, a versioned JSONL contract over the
adapter's stdin and stdout. The schema lives in `protocol/agent-worker-v1.schema.json`
and shared fixtures live in `protocol/fixtures/`. Both the Rust parser and the
Node adapters run the same fixtures in their test suites.

Message families:

- `hello` / `hello_ack` — handshake with protocol version and engine label.
- `work_request` — Rust delivers one durable work envelope.
- `tool_call` / `tool_result` — the worker requests one named capability and
  Rust returns a success or denial.
- `terminal` — the worker returns a bounded terminal result.
- `cancel` / `cancel_ack` — Rust asks the worker to stop the current turn.
- `heartbeat` — liveness during a turn.
- `shutdown` / `shutdown_ack` — orderly stop.

Every frame carries `protocol`, `direction`, `type`, `factory_gen`, `pod`,
`session`, `seq`, and a bounded payload. Work and capability frames also carry
`request_id` or `tool_call_id`.

Adapter stdout carries protocol frames only. Diagnostic output goes to stderr
and the durable pod log.

## Capabilities

The first release exposes exactly two capabilities. Rust derives the caller
identity from the supervised pod and validates every request before applying
an effect.

- `pod.send_message` — enqueue a durable message to a declared destination
  pod. Rust validates the destination, message kind, payload size, and
  correlation ID.
- `factory.read_state` — return a sanitized projection of factory and pod
  status. The worker never receives state-directory paths, unrelated process
  IDs, secrets, or raw log files.

A pod declares its capabilities and destinations in the manifest. Requests
for undeclared capabilities, destinations, or kinds are denied without
mutating state.

## Failure semantics

- Delivery is at-least-once. Stable delivery IDs and deterministic effect keys
  prevent duplicate local message insertion on replay.
- Rust persists a terminal result before it marks the source delivery
  complete.
- A worker timeout, malformed line, unexpected exit, protocol-version
  mismatch, provider error, or oversized message produces an observable
  failure state through `status`.
- A dead worker is restarted by re-running `apply`. The durable source message
  is replayed; the effect key prevents duplicate side effects.
- One pod processes one model turn at a time. The supervisor applies bounded
  line, frame, tool-call, turn, and process-output limits.

## Secret handling

- Provider credentials live in environment variables, not the manifest.
- A pod declares `allowed_env`; the pod process passes only those variables to
  the adapter.
- Logs and terminal results redact API keys, bearer tokens, cookies,
  authorization headers, and provider response bodies.

## Adapter replacement contract

Rust treats the worker engine and worker configuration as opaque data. To
replace the harness, change only the adapter package and the manifest command:

- `engine` — an opaque label.
- `command` — a shell-free argv vector. Rust passes arguments directly to
  `Command`; no shell interpolation.
- `config` — an opaque JSON object passed to the adapter.

`workers/fixture/fixture-worker.mjs` is the deterministic test worker.
`workers/replacement/replacement-worker.mjs` is a deliberately different
implementation that completes the same contract without Rust changes.
`workers/pi-core/` is the Pi Agent Core adapter.

## Pi Agent Core adapter

- Node `>=22`.
- Pinned packages: `@mariozechner/pi-agent-core@0.73.1` and
  `@mariozechner/pi-ai@0.73.1`.
- The adapter exposes only `pod.send_message` and `factory.read_state` as
  tools. Tool execution is sequential; each tool call blocks until Rust
  returns the matching result.
- Provider and model are selected by the operator in the manifest `config`.
  Credentials come from the provider's supported environment variables.
- Build and test: `npm ci && npm test` inside `workers/pi-core`.

## Local Unix assumptions

- The runtime targets macOS and Linux. Process-group ownership uses `setsid`
  and `kill(-pgid, ...)`; the pod process is the process-group leader.
- Process identity is verified by PID, process group, and start time to
  prevent PID-reuse confusion.
- State directories reject symlinks and use `0o700`/`0o600` permissions.

## Spec-declared agents

`monolith agent validate|plan|apply|status|logs|destroy|list` deploys an agent
(Hermes or eve) from a TOML spec onto a named target. Each agent runs behind
its own credential proxy and holds only placeholders for its secrets.

- Spec format: `docs/agent-spec.md`
- Commands, JSON envelopes and state: `docs/agent-cli.md`
- Credential boundary and its local limits: `docs/credential-boundary.md`

Today only the `local` target runs agents. The Proxmox driver, guest template
and pool are not built yet.

## Development

```bash
cargo build
cargo test
sh tests/acceptance_worker.sh   # golden path with the deterministic fixture
sh tests/acceptance_fabric.sh   # agent fabric E2E; live Proxmox only with MONOLITH_PROXMOX_LIVE=1
cd workers/pi-core && npm test
```
