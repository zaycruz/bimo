# Monolith v0.3

Monolith deploys predefined agent work to one Docker host. v0.3 preserves the
bounded sequential workflows, adds one fixed parallel engineering pod, and can
ask up to three isolated organizer agents to select the installed template that
best fits a prompt.

**[Open the live agent-built demo](https://thisismonolith.pages.dev/).** It is
the unchanged static artifact from the final `react-app` run on `pve-05`, not a
hosted Monolith control plane.

```text
template = workflow.json + one Markdown prompt per role
```

The CLI validates that data and starts one temporary controller. Sequential
templates launch one ephemeral role container at a time; the engineering pod
launches exactly three writers in parallel. There is no fleet service, manager
daemon, general message bus, database, scheduler, or graph engine. The Planner
is the pod's ephemeral manager role for one attempt.

The bundled three-role workflow is:

```text
Engineering [read/write] --completed--> QA [read-only] --passed--> Testing [read-only]
          ^                              |                              |
          +----------- failed -----------+                              |
          +------------------------- failed ----------------------------+

Testing --passed--> deterministic verifier --> read-only snapshot --> static app
```

The package also includes `react-solo`, a separate one-role template:

```text
Engineering [read/write] --> deterministic verifier --> read-only snapshot --> static app
```

Both templates use the same controller and deployment path. This is the
Claude-workflow/state-machine idea deployed to Docker, not three continuously
running pods.

## The fixed engineering pod

`parallel-engineering-pod` is one product path, not a configurable DAG:

```text
Planner
  -> engineering-a [src] ───────> checker ─┐
  -> engineering-b [starters] ──> checker ─┼─> fixed-order integration
  -> qa-tests [test] ────────────> checker ─┘
  -> QA -> Testing -> monolith-repo-v1 -> source scan
  -> isolated publisher -> draft pull request
```

This is the complete pod manifest:

```json
{
  "version": 1,
  "name": "parallel-engineering-pod",
  "maxAttempts": 3,
  "timeouts": {
    "executionSeconds": 1200,
    "attemptSeconds": 3600,
    "workflowSeconds": 7200
  },
  "changes": {
    "maxFiles": 200,
    "maxBytes": 5242880
  },
  "writers": {
    "engineering-a": {
      "prompt": "roles/engineering.md",
      "allowedWriteRoots": ["src"]
    },
    "engineering-b": {
      "prompt": "roles/engineering.md",
      "allowedWriteRoots": ["starters"]
    },
    "qa-tests": {
      "prompt": "roles/qa-tests.md",
      "allowedWriteRoots": ["test"]
    }
  },
  "prompts": {
    "planner": "roles/planner.md",
    "checker": "roles/checker.md",
    "qa": "roles/qa.md",
    "testing": "roles/testing.md"
  },
  "verificationProfile": "monolith-repo-v1"
}
```

JSON is intentional. Node parses it natively with `JSON.parse`, then Monolith
applies an exact, data-only schema. That adds no YAML/TOML parser and avoids
YAML aliases, tags, and implicit-type ambiguity. The manifest cannot add nodes,
commands, images, providers, repositories, or environment variables.

The Planner assigns non-overlapping paths inside the three fixed roots. Each
path has one writer. The only cross-writer handoff is a bounded dependency from
`engineering-a` to the still-running `engineering-b`: the controller validates
the requested path and requirement IDs, resumes `engineering-b`, checks its new
commit, then resumes `engineering-a` on the combined base. There is no general
chat or mailbox.

Every writer commit gets its own read-only checker. Any writer, checker,
integration, QA, Testing, or verification failure discards the attempt and
replans all three writers from the same immutable base, up to `maxAttempts`.
The Planner, checker, QA, and Testing receipts are advisory model judgments.
The separate `monolith-repo-v1` profile and source scan are controller-owned
gates bound to the exact integrated commit.

After those gates pass, compute stops. A separate publisher receives the GitHub
credential, rechecks the allowlisted base and candidate SHAs, pushes the fixed
`monolith/<run-id>` branch, and opens a draft pull request. It has no Docker
socket, agent worktrees, snapshots, or OpenRouter key. It never merges.

## The sequential workflow template contract

Each template owns its JSON and prompts:

```text
templates/
├── react-app/
│   ├── workflow.json
│   └── roles/
│       ├── engineering.md
│       ├── qa.md
│       └── testing.md
└── react-solo/
    ├── workflow.json
    └── roles/
        └── engineering.md
```

This is the complete bundled `react-app` manifest:

```json
{
  "version": 1,
  "name": "react-app",
  "start": "engineering",
  "maxSteps": 15,
  "timeouts": {
    "stepSeconds": 1200,
    "workflowSeconds": 3600
  },
  "roles": {
    "engineering": {
      "prompt": "roles/engineering.md",
      "write": true,
      "on": {
        "completed": "qa"
      }
    },
    "qa": {
      "prompt": "roles/qa.md",
      "write": false,
      "on": {
        "passed": "testing",
        "failed": "engineering"
      }
    },
    "testing": {
      "prompt": "roles/testing.md",
      "write": false,
      "on": {
        "passed": "done",
        "failed": "engineering"
      }
    }
  },
  "output": {
    "directory": "dist",
    "maxFiles": 500,
    "maxBytes": 10485760,
    "smoke": {
      "path": "/",
      "status": 200,
      "contains": "MONOLITH_DEMO_READY"
    }
  }
}
```

The manifest cannot contain commands, images, executables, provider keys, or
arbitrary environment variables. It declares bounded roles, transitions,
timeouts, and static-output checks. Markdown prompts describe how each role
should behave.

## What happens during a sequential deployment

1. The local CLI validates the template, builds one `linux/amd64` image, and
   transfers that exact image over SSH.
2. A temporary controller runs on the target with the Docker socket, the shared
   workspace, and the run-history directory.
3. The controller starts only the active role. Engineering receives the shared
   workspace read/write; QA and Testing receive it read-only. The role container
   is removed when its attempt ends.
4. A valid role receipt selects the next declared transition. A QA or Testing
   `failed` receipt returns `react-app` to Engineering, bounded by `maxSteps` and
   the whole-workflow deadline.
5. After a transition reaches `done`, a separate no-network verifier runs
   `npm test`, `npm run build`, and `npm run smoke`, enforces file and byte
   limits, rejects symlinks, and performs its own HTTP marker probe with
   image-baked server code.
6. Only verified output is copied to an immutable per-run snapshot. The
controller probes a candidate before replacing the current app. If the final
replacement fails, it restores the previous app container.

The `workflowSeconds` deadline begins before image inspection and bootstrap and
covers gateway startup, every role, verification, and publication. Cancellation
aborts active Docker commands before cleanup. Cleanup and rollback use a short,
separate bounded margin so deadline expiry does not strand an attempted
replacement.

### Receipts are not verification

Every role must write `/handoff/result.json` with exactly these fields:

```json
{
  "outcome": "passed",
  "what": "What the role did",
  "why": "Why it reached this outcome",
  "evidence": ["What it observed"],
  "files": []
}
```

The controller validates the shape, size, paths, and allowed outcome before the
receipt can move the workflow. The prose and evidence remain agent-reported.
They are useful handoff and audit context, but they do not prove the build.
Controller-owned verification is the separate fixed step described above.

## Install from GitHub

Monolith is not published to the npm registry. Download the v0.3.1 release
tarball and checksum, verify the exact file, then install it locally:

```bash
curl --fail --location --remote-name \
  https://github.com/zaycruz/monolith-v2/releases/download/v0.3.1/monolith-workflow-0.3.1.tgz
curl --fail --location --remote-name \
  https://github.com/zaycruz/monolith-v2/releases/download/v0.3.1/monolith-workflow-0.3.1.tgz.sha256
shasum --algorithm 256 --check monolith-workflow-0.3.1.tgz.sha256
npm install --global ./monolith-workflow-0.3.1.tgz
monolith list --json
monolith validate parallel-engineering-pod
MONOLITH_PACKAGE_ROOT="$(npm root --global)/monolith-workflow"
test -f "$MONOLITH_PACKAGE_ROOT/docs/organize.md"
test -f "$MONOLITH_PACKAGE_ROOT/examples/pod-assignment.md"
```

The operator machine needs Node.js 22+, Docker, SSH, the 1Password CLI, and
`jq` for the plan-display examples. The target must be an amd64 Linux Docker
host reachable through an already trusted, strict-host-key-checked SSH
connection. `MONOLITH_PACKAGE_ROOT` makes every example below runnable from any
working directory after the global install.

This repository and package are `UNLICENSED`. Public source visibility does not
grant an open-source license or general permission to use, copy, modify, or
redistribute the code.

## CLI

List and validate the installed templates:

```bash
monolith list
monolith list --json
monolith validate react-app
monolith validate react-solo --json
monolith validate parallel-engineering-pod --json
```

### Organize a prompt with agents

`-n` counts independent read-only organizers. It does not resize the selected
workflow or the fixed three-writer engineering pod. Each organizer sees the
same original assignment and the same digest-bound installed catalog. One
valid vote selects with `-n 1`; two must be unanimous; three require a majority.
Any invalid receipt, timeout, digest mismatch, or missing quorum fails without
deploying anything.

```bash
MONOLITH_PACKAGE_ROOT="${MONOLITH_PACKAGE_ROOT:-$(npm root --global)/monolith-workflow}"
SMALL_APP_PROMPT="$MONOLITH_PACKAGE_ROOT/examples/prompts/small-app.md"
SMALL_APP_ASSIGNMENT="$(<"$SMALL_APP_PROMPT")"

PLAN="$(monolith -p "$SMALL_APP_ASSIGNMENT" \
  -n 3 \
  --deployment organize-demo \
  --proxmox pve-05 \
  --vmid 113 \
  --secret-ref 'op://VAULT/ITEM/OPENROUTER_KEY' \
  --json)"

printf '%s\n' "$PLAN" | jq .
```

The equivalent explicit form starts with `monolith organize -p`. The output is
a plan receipt: prompt SHA-256, votes, selected template and digest, plus the
names of the deploy options that template accepts. Organizer agents cannot
add operational fields such as commands, targets, credentials, repositories,
images, or models. Each vote's `reason` is untrusted explanatory text: it is
never executed or used as deploy input. `deploy` remains a separate operator
action because a static app workflow and a source engineering pod require
different authority. Reuse the unchanged prompt as `--task-file` or
`--task-stdin` when running the selected template.

See [the organizer how-to](docs/organize.md) and the runnable
[small-app](examples/prompts/small-app.md) and
[parallel-pod](examples/prompts/parallel-engineering-pod.md) prompts.

### Deploy through `pve-05`

`--proxmox` connects to the Proxmox node over SSH and runs Docker inside the
selected LXC through `pct exec`. The verified demo target is the dedicated,
unprivileged Docker LXC `113` on `pve-05`:

```bash
MONOLITH_PACKAGE_ROOT="${MONOLITH_PACKAGE_ROOT:-$(npm root --global)/monolith-workflow}"
POD_TASK_FILE="$MONOLITH_PACKAGE_ROOT/examples/pod-assignment.md"
POD_ASSIGNMENT="$(<"$POD_TASK_FILE")"
REPOSITORY='https://github.com/zaycruz/monolith-v2.git'
BASE_SHA="$(git ls-remote --refs "$REPOSITORY" refs/heads/main | cut -f1)"

POD_PLAN="$(monolith -p "$POD_ASSIGNMENT" \
  -n 3 \
  --deployment pod-plan-demo \
  --proxmox root@pve-05 \
  --vmid 113 \
  --secret-ref 'op://VAULT/ITEM/OPENROUTER_KEY' \
  --json)"

printf '%s\n' "$POD_PLAN" | jq .

monolith deploy parallel-engineering-pod \
  --deployment pod-demo \
  --proxmox root@pve-05 \
  --vmid 113 \
  --task-file "$POD_TASK_FILE" \
  --secret-ref 'op://VAULT/ITEM/OPENROUTER_KEY' \
  --github-secret-ref 'op://VAULT/ITEM/GITHUB_TOKEN' \
  --repository "$REPOSITORY" \
  --base-sha "$BASE_SHA" \
  --target-branch main \
  --json
```

The pod accepts only that repository and `main`. `--base-sha` must be the exact
40-character commit currently expected at `main`; publication fails closed if
the branch moves. The two secret references must resolve to separate,
least-privilege credentials.

Read the pod's structured events using the run ID returned by deploy:

```bash
monolith logs \
  --deployment pod-demo \
  --proxmox root@pve-05 \
  --vmid 113 \
  --run <RUN_ID> \
  --json
```

Deploy the sequential three-role workflow independently:

```bash
MONOLITH_PACKAGE_ROOT="${MONOLITH_PACKAGE_ROOT:-$(npm root --global)/monolith-workflow}"
LXC_ADDRESS='10.200.160.143' # Replace this when targeting another LXC.

monolith deploy react-app \
  --deployment fleet-demo \
  --proxmox root@pve-05 \
  --vmid 113 \
  --task-file "$MONOLITH_PACKAGE_ROOT/examples/fleet-demo.md" \
  --secret-ref 'op://VAULT/ITEM/FIELD' \
  --public-url "http://${LXC_ADDRESS}:8080"
```

Deploy the sequential one-role template independently:

```bash
monolith deploy react-solo \
  --deployment solo-demo \
  --proxmox root@pve-05 \
  --vmid 113 \
  --task-file "$MONOLITH_PACKAGE_ROOT/examples/solo-demo.md" \
  --secret-ref 'op://VAULT/ITEM/FIELD' \
  --public-url "http://${LXC_ADDRESS}:8081" \
  --port 8081
```

Read the latest sequential human log or one run's JSON events:

```bash
monolith logs \
  --deployment fleet-demo \
  --proxmox root@pve-05 \
  --vmid 113

monolith logs \
  --deployment fleet-demo \
  --proxmox root@pve-05 \
  --vmid 113 \
  --run <RUN_ID> \
  --json
```

### Deploy to a Docker host

Use `--host` instead of `--proxmox` and `--vmid` when Docker runs directly on
the SSH target:

```bash
MONOLITH_PACKAGE_ROOT="${MONOLITH_PACKAGE_ROOT:-$(npm root --global)/monolith-workflow}"

monolith deploy react-app \
  --deployment fleet-demo \
  --host deploy@docker-host.example \
  --task-file "$MONOLITH_PACKAGE_ROOT/examples/fleet-demo.md" \
  --secret-ref 'op://VAULT/ITEM/FIELD' \
  --public-url 'http://docker-host.example:8080'

monolith logs \
  --deployment fleet-demo \
  --host deploy@docker-host.example
```

Deploy accepts exactly one target (`--host`, or `--proxmox` with `--vmid`) and
exactly one task source (`--task-file FILE` or `--task-stdin`). Every deployment
requires `--deployment` and `--secret-ref`. Sequential workflows also require
`--public-url`. The fixed pod instead requires `--github-secret-ref`, the fixed
repository URL, an immutable `--base-sha`, and `--target-branch main`.

Optional shared flags are `--account`, `--model`, `--image`, and `--json`;
sequential deploys also accept `--port`. `logs` accepts `--run`, `--image`, and
`--json`.

Defaults are port `8080`, model `openrouter/deepseek/deepseek-v4-flash`, and
image tag `monolith-workflow:0.3.1`. `--account` selects a 1Password account;
`--json` requests machine-readable output.

Quote each `op://` reference as one shell argument. Vault, item, and field names
may contain literal spaces; Monolith passes the validated reference directly to
`op read` without invoking a shell.

`--public-url` is only the address Monolith records and reports for the published
port. Monolith does not create DNS records, TLS certificates, firewall rules,
routes, or a reverse proxy. Supply an address that is actually reachable in
your environment; this repository does not claim a public hosted domain.

## State and logs

One deployment keeps its state on the target:

```text
/var/lib/monolith/deployments/<deployment>/
├── workspace/
└── runs/
    ├── latest
    └── <run-id>/
        ├── events.jsonl
        ├── CHANGELOG.md
        └── artifact/
```

The controller appends structured events to `events.jsonl` and atomically
renders a human-readable `CHANGELOG.md`. Approved handoffs are included in
successor prompts. These files are durable operator logs, not tamper-evident
records against target-host root.

Each successful verification creates a separate artifact snapshot that Monolith
treats as immutable: it is created once, permission-locked, and mounted by the
retained app read-only. Monolith performs automatic rollback only when replacing
the current app fails; v0.3 has no user-facing rollback command or remote
artifact backup.

The fixed pod uses the same deployment root but keeps private run records under
`runs/<run-id>/`, including `run.json`, `events.jsonl`, and per-attempt plans,
writer results, gate receipts, and any bounded inbox entry. `source/`,
`worktrees/`, and `snapshots/` are controller-owned temporary roots. Worktrees
and snapshots are removed when compute stops; only the exact Git source needed
for a publication-ready run crosses into the publisher, then it is removed after
durable completion on a best-effort basis.

Before creating a pod run, Monolith retains the newest 20 validated terminal
run records. Active, malformed, or unsafe entries are never deleted
automatically.

A cooperative interruption cancels active agents, records failure, and cleans
owned workspaces. An abrupt host or container loss can leave a `running` record
and private temporary roots. The pod does not resume a partial Planner, writer,
or checker attempt. Confirm no controller or publisher is active, preserve the
run records for diagnosis, then recover only that dedicated deployment root
before starting a new run. The internal publisher can reconcile an interrupted
durable publication, but v0.3 has no general user-facing resume command.

## Security boundary

- The OpenRouter key is resolved locally with `op read`, sent through SSH and
  controller stdin, then sent to a run-scoped credential gateway through stdin.
  It is not placed in workflow JSON, prompts, command-line arguments, the shared
  workspace, or role-container environment.
- Role containers join an internal Docker network with no direct egress. Only
  the credential gateway is attached to both that internal network and a
  separate egress network. The gateway accepts the expected host and API route,
  fixes the allowed model, replaces client credentials, and bounds requests,
  response size, concurrency, and lifetime.
- Roles run as a non-root user with a read-only root filesystem, dropped Linux
  capabilities, `no-new-privileges`, resource limits, temporary storage, and no
  Docker socket or host home directory.
- The temporary controller is different: it runs as root with the Docker socket
  so it can create containers and publish the app. Docker-socket access is
  root-equivalent for that Docker daemon. On Proxmox, use only a dedicated,
  unprivileged Docker LXC with no unrelated workloads or secrets. A direct
  `--host` target needs the same single-purpose isolation; never use a shared
  general-purpose Docker host.
- Use a dedicated OpenRouter key with a provider-side spend cap and rate limit.
  The gateway's local request limits reduce exposure but are not a billing cap.
- The pod resolves the GitHub credential only after compute passes. The isolated
  publisher receives the private source and run state, but not the Docker socket,
  worktrees, snapshots, or OpenRouter key. Use a dedicated single-repository
  credential limited to branch push and pull-request creation.
- A draft pull request is a review boundary, not an execution boundary. Opening
  it triggers this repository's `pull_request` CI, which executes candidate code
  on a GitHub-hosted runner. The workflow has a read-only repository token and no
  repository secrets, environments, or self-hosted runner; candidate paths cannot
  include `.github`, and checkout credentials are not persisted into the working
  tree. Re-audit this boundary before adding secrets, write-capable CI tokens,
  `pull_request_target`, `workflow_run`, self-hosted runners, or another
  repository. Candidate code is still untrusted code executing on the ephemeral
  GitHub-hosted runner.

Never put a credential in a task, prompt, workflow file, repository file,
`--public-url`, or deployment name.

## Scope and limitations

- `react-app` and `react-solo` remain sequential ephemeral workflows. The fixed
  engineering pod runs exactly three parallel writers; it is not arbitrary
  fan-out and none of its containers are persistent.
- `react-app` and `react-solo` are two independent templates, but both use the
  same bundled React/npm starter and static-output verifier. This is not an
  arbitrary workload platform.
- The workspace persists across runs of the same deployment. Engineering can
  modify it; review roles cannot.
- An interruption during the first bootstrap can leave a partial non-empty
  workspace. Inspect the dedicated deployment directory before clearing its
  `workspace/` and retrying; that recovery intentionally discards the partial
  workspace.
- OpenRouter is the only provider. There is no provider discovery, marketplace,
  generic DAG, manager service, inter-agent chat, message bus, or graph runtime.
- Deployment is Docker over SSH, directly or through Proxmox `pct exec`. There
  is no Helm, Terraform, Kubernetes scheduler, multi-host placement, HA, or
  autoscaling layer.
- Publication serves static files only. Replacement is preflighted and can
  restore the prior app on failure, but zero downtime is not guaranteed.
- History and artifacts remain on one target host. There is no database, remote
  backup, or user-invoked rollback.
- Organizer audit runs are retained on the target and are not automatically
  pruned in v0.3.
- Pod publication stops at an isolated, draft pull request. It does not approve,
  mark ready, merge, deploy, or delete the branch.

## v0.3 release evidence

Local verification on 2026-08-26: **202/202 automated tests passed**. The final
`linux/amd64` image also executed its baked Git askpass helper while the private
credential tmpfs remained `noexec`; the helper was root-owned and mode `0555`.

Live organizer and deployment proof on `pve-05`, LXC `113`:

- Organizer run `20260826040815-1e83d274` gave the unchanged small-app prompt
  to three selectors; all three chose `react-solo` at digest
  `af6c7d09debd98a4abb86170384242e76d8235f0177755b5cc4ae4b67371af98`.
- The selected app then completed as run `20260826040943-3524acea`. Its
  controller-owned artifact receipt was 3 files, 147,220 bytes, SHA-256
  `4e47307d3654f9faac87f78bd11ff3a1772093f68ee00ecde703f9b177810d7c`;
  the hardened retained container returned HTTP 200 at the recorded LXC URL.
- Organizer run `20260826041417-b7c94c44` gave the parallel-pod prompt to three
  selectors; all three chose `parallel-engineering-pod` at digest
  `8ad45c2908a1c3626e5badea95f06161ca88b630ab064aa58412799b398347cd`.
- Pod run `20260826051009-0fc6b396` passed all three writers, all three dedicated
  checkers, QA, Testing, candidate and immutable-baseline source verification,
  and the pre-publication scan on its first attempt. It published exact candidate
  `8b4556fe0d725fe9e06a379e8551c6a93ab7e30a` as
  [draft pull request #4](https://github.com/zaycruz/monolith-v2/pull/4), bound
  to base `26864850cfd78521cfa95112513fc18a72e8bb51`; its GitHub `verify` job passed.
- The source-verifier regression was reproduced against the exact candidate in
  the production sandbox, then passed all **186/186** candidate tests with
  `/tmp` still `noexec`, a separate bounded executable test-fixture tmpfs, no
  network, no Docker socket, dropped capabilities, and a read-only source mount.
- The final publisher image on the LXC had config digest
  `sha256:bc35072f2efb296c7a1cdd3c6ac4e0979b4708c6b54249eb7c130a977c68b44d`.
  After durable publication, no pod controller, role, publisher container,
  transient network, worktree, snapshot, or private source clone remained.

These receipts prove the bounded templates and isolated publication path
described here. They do not prove arbitrary workload support, production HA,
or Kubernetes-equivalent isolation.

## v0.2 release evidence

Local verification on 2026-08-25: **82/82 automated tests passed**. The suite
includes the QA/Testing failure transitions back to Engineering, deadline and
cancellation behavior, credential isolation, immutable artifact binding, and
publication rollback.

Live `pve-05` verification on the same date:

- `react-app` run `20260825074857-82d5a68b` completed Engineering, QA, and
  Testing in three role attempts, then passed controller-owned verification and
  publication.
- `react-solo` run `20260825075237-ce8b4881` completed in one Engineering
  attempt, then passed the same controller-owned verification and publication
  path.
- Both runs recorded image digest
  `sha256:28a837c94fcad9bef3b2ca05816ac1b52f0f36336356703eac161a10337b6efe`,
  matching the final image transferred for this release.
- Both retained apps returned HTTP 200 with `MONOLITH_DEMO_READY` when probed
  from the Proxmox node. Only each static app remained for its deployment; role,
  gateway, and controller containers were removed.
- A browser replayed the `react-app` workflow twice, returned to its published
  state both times, and produced no console or page errors.
- The final fleet artifact was direct-uploaded unchanged to
  [Cloudflare Pages](https://thisismonolith.pages.dev/). Its controller receipt
  was 3 files, 151,507 bytes, SHA-256
  `8e47126f917d033d7ca930b74f4a10b0134bd0d2cb13bd81b509bb7ef9bd862e`.
  The public origin returned HTTP 200 and all three served files matched the
  exported artifact byte-for-byte.

These run IDs prove only the bounded workflows described here, not production
HA, arbitrary workload support, or Kubernetes-equivalent isolation.
