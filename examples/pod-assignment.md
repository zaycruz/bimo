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

- Under `src/`, add a pure data-only summary containing all 13 exact stage
  labels in the exact order above.
- Under `starters/`, render all 13 exact stage labels in the same order as
  accessible status text.
  Do not import files from outside the starter package.
- Under `test/`, assert the complete 13-label summary order and every one of the
  starter's 13 required stage labels. A subset is not sufficient.
- Preserve existing CLI behavior and `MONOLITH_DEMO_READY`.

## Constraints

- Add no dependency and no network call.
- Modify only `src/`, `starters/`, and `test/`.
- Keep output deterministic and data-only.

## Acceptance

- The repository test suite passes.
- The summary, starter, and tests use the same complete 13-label list above.
- Existing regression and smoke commands continue to pass when present.
- The result contains no credentials, generated dependencies, or build output.
