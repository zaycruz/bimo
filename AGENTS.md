# Working on Bimo

Bimo is a zero-dependency Node.js ESM CLI that deploys bounded, auditable
agent workflows as ephemeral Docker fleets. This file is the whole
orientation: verification loop, hard rules, PR flow, and the design docs.

## Verification loop

Node.js 22+. No install step; there is nothing to install.

```sh
npm test            # full suite: node --test test/*.test.mjs (271 tests)
for f in bin/bimo src/*.mjs test/*.mjs; do node --check "$f"; done
npm pack --dry-run  # verify the package manifest and shipped file set
```

All three must pass before opening a PR, including for docs-only changes.

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
- [docs/templates.md](docs/templates.md) — the data-only template
  boundary: manifest schema, digest binding, customization path, and
  non-promises.

README.md is the user-facing contract. A change that alters CLI behavior
updates the README and the affected examples in the same PR.
