# Agent runtimes

Bimo separates workflow semantics from the agent CLI that executes a role. A
template says which roles run and how their receipts transition. An **agent
runtime** is the agent program one role container actually spawns: the CLI,
its arguments, its environment, and the dialect of its output stream.

The registry in `src/agent-runtime.mjs` is deliberately closed:

| Runtime | Agent CLI | Default image tag | Selection |
| --- | --- | --- | --- |
| `opencode` | `opencode run` (pinned `opencode-ai` in the image) | `bimo-workflow:0.6.0` | Default, or `--agent-runtime opencode` |

`opencode` is the only entry today. This document defines the adapter
contract a second runtime must satisfy. It exists so the runtime set grows by
evidence, not by adding a plugin system — the same rule
[docs/targets.md](targets.md) sets for placement and
[docs/runtime-contract.md](runtime-contract.md) sets for the execution
runtime.

## The adapter contract

An adapter is one frozen object in the registry with a validated lowercase
name and three operations. `agentRuntimeFor(name)` resolves a name to its
adapter and fails closed on anything else; there is no registration, no
discovery, and no way to name a runtime that is not built in.

1. **`spawnArgv({ model, role })`** returns the complete argv array for the
   agent process, command included. The dispatcher
   (`src/agent.mjs`) validates the result — 1 to 64 non-empty bounded
   strings, no control characters — and executes it without a shell. An
   adapter never interpolates values into a command string.
2. **`spawnEnv({ gateway })`** returns the complete child environment: at
   most 32 `UPPER_SNAKE` entries of bounded strings, with the validated
   `BIMO_GATEWAY_URL` as the only network authority. The child never inherits
   the controller environment; every entry is explicit.
3. **`createDiagnostics()``** returns a fresh `{ stdout, stderr, failure }`
   sink. The dispatcher feeds every output chunk to it; on a non-zero exit,
   `failure(code)` returns a one-line, bounded summary. Diagnostics must
   never replay agent output content — event counts, byte totals, and an
   extracted HTTP status, never model text or secrets.

That is the whole contract. The opencode adapter is the reference
implementation: its argv pins `opencode run --pure --auto` against the
mounted instructions file, its environment carries `OPENCODE_CONFIG`, and its
diagnostics parse the opencode JSON event stream
(`createOpenCodeDiagnostics`).

## Invariants an adapter may not weaken

The cross-runtime guarantees live in the dispatcher, not the adapter. An
adapter supplies argv, env, and diagnostics — nothing more. If a runtime
cannot satisfy one of these, it is not registered.

- **Bounded output.** Combined stdout and stderr are capped at 1 MiB; the
  process tree is terminated past the cap and every byte is hashed into the
  run's `outputSha256` receipt regardless of runtime.
- **Bounded lifetime.** The `--timeout-seconds` budget applies to every
  runtime. Expiry terminates the whole process group (detached kill-tree,
  SIGTERM then SIGKILL), not just the direct child.
- **The handoff contract.** The agent reads its prompt from
  `/instructions/instructions.md` (1 to 262144 bytes) and writes exactly one
  regular, non-symlink `/handoff/result.json` (2 to 65536 bytes). The
  dispatcher validates both; a runtime that cannot produce the handoff file
  fails the role.
- **Gateway-only network authority.** The only network endpoint the agent
  receives is the validated `http://gateway:PORT/api/v1` URL, checked against
  a strict regex before spawn. The container topology (no direct egress) is
  enforced by the execution runtime and is identical for every agent runtime.
- **Operator-only authority.** Runtime selection happens only in the operator
  CLI (`--agent-runtime`) and is carried through the controller envelopes as
  exact-shape validated data. Templates, roles, and organizer votes can never
  choose an agent runtime, image, or command.
- **Fail closed everywhere.** An unknown `BIMO_AGENT_RUNTIME` in the agent
  container, an unknown name in an envelope, or an adapter result that
  violates the shape checks stops the run before any agent process starts.

## Selection, envelopes, and the image

`bimo deploy` and `bimo organize` accept `--agent-runtime NAME`. The chosen
name travels in the run envelope to the in-container controller, which
validates it against the same registry and passes it to every agent container
as `BIMO_AGENT_RUNTIME`. The agent entrypoint resolves it through
`agentRuntimeFor` before touching the workspace, and the `run.started` event
records it next to the model and image digest.

Each runtime is a different image: the agent CLI is baked in, never installed
at run time. The Dockerfile is staged — a shared `base` stage (system
packages, the Bimo sources, the React starter layer, the bundled Docker CLI)
plus one `runtime-<name>` stage per registry entry. The `runtime-opencode`
stage installs the pinned `opencode-ai` version, copies
`etc/opencode/opencode.json`, and stamps `ENV BIMO_AGENT_RUNTIME=opencode`;
the final stage is `runtime-${AGENT_RUNTIME}`. `prepareImage` passes
`--build-arg AGENT_RUNTIME=<name>` and, after building, fails closed unless
the image's `Config.Env` carries the matching `BIMO_AGENT_RUNTIME` — with one
exception: a defaulted (not explicit) `--agent-runtime` accepts an old image
that predates the stamp. A plain `docker build` with no build arguments
selects `opencode` and produces the same behavior as the pre-staged image.

When `--image` is not passed, the default tag derives from the runtime:
`bimo-workflow:0.6.0` for `opencode` (unchanged), and
`bimo-workflow:0.6.0-<name>` for any future entry. Read commands (`logs`,
`runs`, `status`, `cancel`, `publish`) do not launch agents; with a
non-default runtime image, pass `--image` explicitly to them.

## Why this is not a plugin system

One runtime exists. Loading arbitrary executable agent plugins now would
require a versioned ABI, discovery rules, trust and signing policy, secret
routing, and failure cleanup without adding a new capability — and it would
hand templates and organizers a way to smuggle in executables, which the
operator-only authority rule forbids. When a second agent runtime is
implemented, it lands as a built-in entry behind this registry, satisfying
the same contract and invariants. If two or more external runtimes then need
independent release cycles, the registry can become a versioned plugin
boundary with evidence instead of speculation.
