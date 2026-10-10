# Working on Bimo

Bimo is a zero-dependency Node.js ESM CLI that deploys bounded, auditable
agent workflows as ephemeral Docker fleets. Its engine, in `engine/`, is a
Rust crate (`bimo-engine`) that places long-running Hermes and eve agents on
local or Proxmox targets; `bimo agent|pool|proxy|engine` drive it through
`src/engine.mjs`. This file is the whole orientation: verification loop, hard
rules, PR flow, and the design docs.

## Verification loop

Node.js 22+. No install step; there is nothing to install.

```sh
npm test            # full suite: node --test test/*.test.mjs (301 tests)
for f in bin/bimo src/*.mjs test/*.mjs; do node --check "$f"; done
npm pack --dry-run  # verify the package manifest and shipped file set
```

All three must pass before opening a PR, including for docs-only changes.

A change under `engine/`, `src/engine.mjs` or the engine bridge also runs the
engine checks (Rust stable and `uv`, which installs the pinned E2E tools):

```sh
cargo build --manifest-path engine/Cargo.toml
cargo test --manifest-path engine/Cargo.toml   # live Proxmox suites skip without BIMO_PROXMOX_LIVE=1
sh engine/tests/acceptance_worker.sh
sh engine/tests/acceptance_fabric.sh
node test/engine-proof.mjs                     # bimo -> bimo-engine -> Hermes; writes engine/target/e2e-bimo/
```

Never run the live Proxmox suites (`BIMO_PROXMOX_LIVE=1`) without an operator
and a gitignored `.bimo/targets.toml`.

## Hard rules

- **Zero npm dependencies.** The package imports only the Node.js standard
  library. Do not add a `dependencies` field, a lockfile entry, or a
  vendored library. If a capability seems missing, the answer is a small
  local module, not a package.
- **`fail()` for every error.** Each module defines a local
  `fail(message)` that throws an `Error`. No custom error classes, no
  error-code enums.
- **Strict argv, no shell interpolation.** Every external command is a
  validated argv array executed without a shell (`execute`,
  `commandForTarget`). Names, paths, images, and identifiers are
  regex-validated before they reach argv. Never build a command string.
- **Bound everything.** Every read, exec, and stream carries a byte cap, a
  timeout, and a count or size limit. No unbounded buffers, no open-ended
  waits.
- **Frozen option objects.** Parsed options and cross-module inputs are
  `Object.freeze`d at the boundary and treated as immutable.
- **The engine keeps its contracts.** `engine/` follows its own docs:
  `bimo.cli/v1` envelopes, the agent spec, and the guest-side
  `MONOLITH_*` names and paths baked into the golden template. Rename those
  only with a template version bump (see docs/engine.md). Real cluster
  addresses, node names, token IDs and vault names never enter the repo;
  examples use `192.0.2.0/24` and placeholders.
- **Exact-shape receipts.** Every JSON receipt — agent, verifier,
  artifact, plan, error — is validated against an exact field set
  (`assertExactFields`). Unknown or missing fields fail closed.

## PR flow

- One worktree per change:
  `git worktree add .worktrees/<name> -b <branch>`.
- PRs squash-merge to `main`.
- Required checks: `verify`, `verify-macos` (ci), `analyze` (codeql),
  `dependency-review`, `scan` (gitleaks).

## Design docs

- [docs/targets.md](docs/targets.md) — the closed deployment-target
  registry (`local`, `ssh`, `proxmox-lxc`) and why it is not a plugin
  system.
- [docs/runtime-contract.md](docs/runtime-contract.md) — the bounded
  runtime contract a second adapter must satisfy, and the security
  invariants it may not weaken.
- [docs/agent-runtimes.md](docs/agent-runtimes.md) — the closed
  agent-runtime registry (`opencode`, `pi`), the adapter contract a third
  agent runtime must satisfy, and the invariants it may not weaken.
- [docs/engine.md](docs/engine.md) — the Bimo engine: the CLI seam, the
  deployment-manifest bridge, `BIMO_*` names and their `MONOLITH_*`
  aliases, and the renames deferred to a template bump. The engine's own
  design docs are in [engine/docs/](engine/docs/) and
  [engine/templates/README.md](engine/templates/README.md).
- [docs/templates.md](docs/templates.md) — the data-only template
  boundary: manifest schema, digest binding, customization path, and
  non-promises.

README.md is the user-facing contract. A change that alters CLI behavior
updates the README and the affected examples in the same PR.
