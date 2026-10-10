# Bimo engine

The Bimo engine (`bimo-engine`) is the Rust runtime fabric behind Bimo. It
places spec-declared agents (Hermes and eve) on a named target, the local
machine or a Proxmox cluster, runs each one behind its own credential proxy,
and reports every step as one JSON envelope. It also keeps the earlier local
agent factory: a TOML manifest of pods, supervised child processes and a
versioned JSONL worker protocol.

Users reach it through the `bimo` CLI (see `../docs/engine.md` for the seam,
the names and the manifest bridge):

```text
bimo agent validate|plan|apply <spec.toml | manifest.json>
bimo agent status|logs|destroy <name>
bimo agent list
bimo pool status|fill|drain --target <name> [--tenant <id>]
bimo proxy up|status|down --target <name> [--tenant <id>]
bimo engine <any bimo-engine arguments>     # for example: bimo engine help
```

`bimo` finds the binary through `BIMO_ENGINE_BIN`, then the newest
`engine/target/{release,debug}/bimo-engine`, then `PATH`.

## Agents

- Spec format: `docs/agent-spec.md` (examples: `examples/hermes-agent.toml`,
  `examples/eve-agent.toml`).
- Commands, JSON envelopes and state: `docs/agent-cli.md`.
- Credential boundary and its local limits: `docs/credential-boundary.md`.
- Proxmox golden template, bind agent, warm pool and proxy guests:
  `templates/README.md`.
- Measured readiness: `docs/benchmarks/spawn-latency.md`.

Local state lives under `.bimo/` in the working directory (agents, pools,
reports, `targets.toml`). A directory that only has the earlier `.monolith/`
layout keeps working; `docs/naming.md` lists every renamed and kept name.

## Targets

`local` always exists. Proxmox targets are declared in `.bimo/targets.toml`
(`--targets-config FILE` points elsewhere). Keep real
addresses, node names and token IDs in that file, which stays out of git; the
committed example uses documentation placeholders:

```toml
schema_version = 1
default_target = "local"

[[targets]]
kind = "proxmox"
name = "homelab-lxc"
api_url = "https://pve-node-a:8006/api2/json"
token_env = "BIMO_PROXMOX_TOKEN"     # user@realm!tokenid=secret, read from the environment only
node = "pve-node-a"
pool = "pool-monolith-test"
template_id = 9000
vmid_range = [9100, 9199]
address_range = "192.0.2.230-192.0.2.238"
gateway = "192.0.2.129"
```

The full field list is in `examples/targets.toml` and
`docs/local-first-targets.md`. `bimo engine targets` reports each target,
whether its token variable is set and whether this build can execute it.

## Factory commands

```text
bimo engine targets [--targets-config <file>]
bimo engine deploy <manifest> [--state-dir <dir>] [--target <name>] [--targets-config <file>]
bimo engine validate <manifest>
bimo engine plan|apply <manifest> [--state-dir <dir>] [--target <name>] [--targets-config <file>]
bimo engine status|destroy <state-dir> [--target <name>] [--targets-config <file>]
bimo engine send <state-dir> --from <pod> --to <pod> --kind <kind> --payload <text>
bimo engine logs <state-dir> <pod>
bimo engine demo <manifest> [--state-dir <dir>]
```

Factory manifests run on `local` only. `pod-process` is an internal runtime
subcommand used by `apply` and `demo`.

## Process hierarchy

```text
bimo engine apply
  └── Rust factory process
        └── Rust pod process
              └── selected worker adapter
                    └── model engine runtime
```

The factory owns the pod process. The pod process owns the worker adapter.
The adapter owns the model loop. No worker process receives a direct
state-directory capability.

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

## Development

```bash
cargo build
cargo test                      # live Proxmox tests skip unless BIMO_PROXMOX_LIVE=1
sh tests/acceptance_worker.sh   # golden path with the deterministic fixture
sh tests/acceptance_fabric.sh   # agent fabric E2E; live Proxmox only with BIMO_PROXMOX_LIVE=1
node ../test/engine-proof.mjs   # bimo -> bimo-engine -> Hermes, through a deployment manifest
```

A live run also needs the target's token variable and
`BIMO_PROXMOX_FOREIGN_VMID`, an existing guest outside the target's pool that
the driver must refuse to touch.

`scripts/e2e-tools.sh` installs the pinned iron-proxy and hermes-agent the
E2E tests use (it needs `uv`). The `MONOLITH_*` names of every `BIMO_*`
variable still work.
