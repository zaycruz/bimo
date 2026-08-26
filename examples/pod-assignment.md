# Parallel engineering pod assignment

## Goal

Add a deterministic summary of the fixed engineering-pod stages and expose the
same stages in the bundled React starter without changing the public CLI.

## Requirements

- Under `src/`, add a pure data-only summary for Planner, the three writers and
  their checkers, integration, QA, Testing, verification, and publication.
- Under `starters/`, render the same ordered stages as accessible status text.
  Do not import files from outside the starter package.
- Under `test/`, cover the summary order and the starter's required stage text.
- Preserve existing CLI behavior and `MONOLITH_DEMO_READY`.

## Constraints

- Add no dependency and no network call.
- Modify only `src/`, `starters/`, and `test/`.
- Keep output deterministic and data-only.

## Acceptance

- The repository test suite passes.
- Existing regression and smoke commands continue to pass when present.
- The result contains no credentials, generated dependencies, or build output.
