# Template boundary

A Bimo template is a data-only pack: one directory under the packaged
`templates/` root holding one JSON manifest and one Markdown prompt per role.
The manifest is parsed with `JSON.parse` and checked against an exact-field
schema; the prompts are instruction text the controller quotes into the agent
prompt as data. No field in either file is executed, interpolated into a
command, or registered as code.

This document defines what a template is, what an operator may change, and
what Bimo explicitly does not promise. It is the template-side counterpart of
[docs/targets.md](targets.md) and [docs/runtime-contract.md](runtime-contract.md):
same discipline, closed registries, evidence over speculation.

## What a template is

Two kinds exist, dispatched by which manifest file the directory contains
(`loadTemplate`, `src/bimo.mjs:278-302`):

- **Sequential workflow** — `workflow.json` plus one prompt file per role
  (`src/workflow.mjs`). Declares `version`, `name`, `start`, `maxSteps`,
  `timeouts`, `roles`, and `output`. Each role declares exactly `prompt`,
  `write`, and `on` (the receipt-outcome transition table). Bounds: 1–12
  roles, 1–8 transitions per role, `maxSteps` 1–20, step and workflow
  timeouts, an output directory of one safe path component, file and byte
  caps, and one static smoke check (`validateWorkflow`,
  `src/workflow.mjs:149-221`). The start role must reach `done` and no role
  may be unreachable (`src/workflow.mjs:185-199`).
- **Engineering pod** — `pod.json` plus the fixed prompt files
  (`src/pod-contract.mjs`). Declares `version`, `name`, `maxAttempts`,
  `timeouts`, `changes`, `writers`, `prompts`, and `verificationProfile`.
  The writer slots are exactly `engineering-a`, `engineering-b`, `qa-tests`;
  the prompt slots are exactly `planner`, `checker`, `qa`, `testing`
  (`src/pod-contract.mjs:15-17`, enforced at `src/pod-contract.mjs:401` and
  `src/pod-contract.mjs:421-425`). Each writer gets exactly one
  `allowedWriteRoots` directory; roots must be canonical portable relative
  directories, pairwise disjoint even under case folding, and may never name
  `.git` or `.github` (`src/pod-contract.mjs:408-417`,
  `src/pod-contract.mjs:137-154`). `verificationProfile` is a closed set of
  one value, `bimo-repo-v1` (`src/pod-contract.mjs:81`,
  `src/pod-contract.mjs:426-431`).

Both loaders then enforce the filesystem boundary: the manifest is a regular
file no larger than 64 KiB; every prompt is a regular file — never a symlink —
that resolves inside the template directory and is no larger than 32 KiB with
no unsafe control characters; the directory name must equal the manifest name;
a symlinked template directory is not a template at all
(`src/workflow.mjs:223-262`, `src/pod-contract.mjs:435-493`).

## The digest

Every load computes one SHA-256 over the raw manifest bytes and each prompt's
path and content (`src/workflow.mjs:247-260`,
`src/pod-contract.mjs:471-485`). The digest is the template's identity:

- `bimo validate TEMPLATE` prints it (`src/bimo.mjs:2430-2436`).
- The organizer catalog binds each template name to its digest, and a
  selector receipt is valid only when name and digest are copied from the
  same installed row (`src/organize.mjs:162-166`).
- Deploy carries the digest in the controller envelope; the in-image
  controller reloads the template from the image-baked copy and fails closed
  on any mismatch (`src/bimo.mjs:1267-1268`, `src/bimo.mjs:1393-1396`).
  Templates are baked into the image at build time (`Dockerfile:37`).

One changed byte in a manifest or prompt changes the digest, and a changed
digest stops the run before Docker or Git work begins.

## What an operator may change today

The template root is the installed package's `templates/` directory and
nothing else (`src/bimo.mjs:39`). Template names are lowercase names, not
paths, so `bimo list`, `bimo validate`, `bimo deploy`, and `bimo organize`
can only ever address directories inside that root. There is no
`--template-dir` flag, no user template directory, and no profile registry.

The supported customization path is a fork: edit or add template directories
in a private copy of the package, rebuild the image so the same bytes are
baked in, and deploy with `--image`. The validation above is the boundary a
forked template must satisfy — it is enforced identically on the operator
machine and inside the controller, so a forked template cannot smuggle in
shape the packaged ones are denied.

Within a forked manifest, the legitimate knobs are data: role and transition
declarations within the numeric bounds, prompt text, timeouts, output caps,
the smoke check, and — for the pod — the three write roots, the attempt and
change bounds, and prompt text. The pod topology itself is fixed in
controller code, not in `pod.json`: the pod controller accepts only the
`parallel-engineering-pod` template name (`src/bimo.mjs:1382`), so a forked
pod can retune prompts, roots, and bounds but cannot rename, resize, or
re-wire the pod without changing controller code.

## What a template cannot do

Enforced by validation and cited tests:

- **Carry executable content.** Exact-field schemas reject any unknown key —
  a `command`, `args`, `executable`, `hooks`, `image`, `env`, or similar
  field fails validation (`assertExactFields`, `src/workflow.mjs:44-51`;
  `src/pod-contract.mjs:103-110`; tests at `test/workflow.test.mjs:58-61`
  and `test/pod-contract.test.mjs:130-133`).
- **Escape its directory.** Prompt paths are canonical relative paths, and
  each prompt is re-checked with `realpath` against the template directory
  (`src/workflow.mjs:249-256`, `src/pod-contract.mjs:472-481`).
- **Escape its write authority.** A workflow role's `write` boolean is the
  whole decision; the runtime mounts the workspace read-only for `write:
  false` roles (`src/workflow.mjs:536,545`,
  `src/docker-runtime.mjs:59-74`). Pod write roots are validated as above,
  and planner-assigned `writePaths` must subdivide existing directories
  inside the writer's template-owned root (`src/pod-contract.mjs:585-597`;
  tests at `test/pod-contract.test.mjs:155-198` and
  `test/pod-contract.test.mjs:352`).
- **Arrive tampered.** A digest mismatch between the operator CLI and the
  controller fails the run before Docker or Git work
  (`test/cli.test.mjs:908-959`).
- **Choose operational authority.** Templates cannot name a target, runtime,
  image, command, credential, repository, provider, or model. Target
  authority stays in the operator CLI ([docs/targets.md](targets.md));
  runtime authority likewise
  ([docs/runtime-contract.md](runtime-contract.md)); organizer agents are
  instructed never to propose template content and their receipts are
  validated against the digest-bound catalog
  (`etc/organizer/organizer.md`, `src/organize.mjs:150-172`).

## Non-promises

- No executable plugins, hooks, or template-supplied code — now or as a
  roadmap commitment. A template never adds behavior; it declares bounds on
  behavior the controller already implements.
- No user-supplied template directory, template discovery, or template
  marketplace. The supported set is the packaged root plus private forks.
- No user-registered verification profiles, runtimes, verifiers, or
  publishers. `verificationProfile` is a closed set; the runtime registry is
  closed and built-in ([docs/runtime-contract.md](runtime-contract.md)).
- No general DAG or graph engine. The sequential kind is one bounded state
  machine; the pod kind is one fixed product path.

If any of these is ever reconsidered, it lands the same way the target and
runtime seams do: as a built-in behind the closed registry, with end-to-end
evidence, before any external boundary is promised.

## Proof

The boundary holds in tests:

- `test/workflow.test.mjs` — the packaged workflow loads; unknown fields,
  multi-component output directories, and the reserved smoke path are
  rejected; template loading fails closed on a name mismatch, a symlinked
  template directory, an escaping prompt path, a symlinked prompt, an
  oversized manifest, and a one-byte prompt tamper changes the digest.
- `test/pod-contract.test.mjs` — executable fields, extra writers, and
  unsupported profiles are rejected; write roots are canonical, disjoint,
  and exclude repository control paths; pod loading fails closed on the same
  filesystem boundary and digest tamper class.
- `test/cli.test.mjs` — `internal-run` and `internal-pod-run` reject an
  invalid or mismatched template digest before Docker or Git work.
