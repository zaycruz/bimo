# Parallel engineering pod assignment

## Goal

Add a deterministic summary of the fixed engineering-pod stages and expose the
same stages in the bundled React starter without changing the public CLI.

Use this exact ordered list everywhere; do not rename, combine, omit, or add a
stage:

1. `planner`
2. `engineering-a`
3. `engineering-b`
4. `qa-tests`
5. `checker-engineering-a`
6. `checker-engineering-b`
7. `checker-qa-tests`
8. `integration`
9. `qa`
10. `testing`
11. `trusted-verification`
12. `pre-publication-scan`
13. `draft-pr-publication`

## Requirements

- Add `src/pod-stages.mjs` with one named export, `POD_STAGES`, containing all
  13 exact stage labels in the exact order above. Freeze the exported array.
- In `starters/react/src/main.jsx`, render all 13 exact stage labels in the
  same order as accessible status text.
  Do not import files from outside the starter package.
- Add `test/pod-stages.test.mjs`. Import the summary exactly as
  `import { POD_STAGES } from "../src/pod-stages.mjs"`, assert its complete
  ordered value, and assert that the starter source contains every one of the
  13 required labels. A subset is not sufficient.
- Preserve existing CLI behavior and `BIMO_DEMO_READY`.

## Constraints

- Add no dependency and no network call.
- Modify only `src/`, `starters/`, and `test/`.
- Keep output deterministic and data-only.

## Acceptance

- The repository test suite passes.
- The summary, starter, and tests use the same complete 13-label list above.
- Existing regression and smoke commands continue to pass when present.
- The result contains no credentials, generated dependencies, or build output.
