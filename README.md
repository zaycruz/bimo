# Bimo v0.5

Bimo deploys predefined agent work to a local or remote Docker-compatible
target. v0.5 adds a default local target and one closed target seam to the
bounded sequential workflows, fixed parallel engineering pod, and isolated
organizer agents introduced in v0.4.

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
  -> QA -> Testing -> bimo-repo-v1 -> source scan
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
  "verificationProfile": "bimo-repo-v1"
}
```

JSON is intentional. Node parses it natively with `JSON.parse`, then Bimo
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
The separate `bimo-repo-v1` profile and source scan are controller-owned
gates bound to the exact integrated commit.

After those gates pass, compute stops. A separate publisher receives the GitHub
credential, rechecks the allowlisted base and candidate SHAs, pushes the fixed
`bimo/<run-id>` branch, and opens a draft pull request. It has no Docker
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
      "contains": "BIMO_DEMO_READY"
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

Bimo is not published to the npm registry. Download the v0.5.0 release
tarball and checksum, verify the exact file, then install it locally:

```bash
curl --fail --location --remote-name \
  https://github.com/zaycruz/bimo/releases/download/v0.5.0/bimo-workflow-0.5.0.tgz
curl --fail --location --remote-name \
  https://github.com/zaycruz/bimo/releases/download/v0.5.0/bimo-workflow-0.5.0.tgz.sha256

# macOS
shasum --algorithm 256 --check bimo-workflow-0.5.0.tgz.sha256
# Linux
sha256sum --check bimo-workflow-0.5.0.tgz.sha256

npm install --global ./bimo-workflow-0.5.0.tgz
bimo list --json
bimo validate parallel-engineering-pod
BIMO_PACKAGE_ROOT="$(npm root --global)/bimo-workflow"
test -f "$BIMO_PACKAGE_ROOT/docs/organize.md"
test -f "$BIMO_PACKAGE_ROOT/examples/pod-assignment.md"
```

The tarball is platform-independent Node.js, so the same download serves
macOS and Linux on any architecture. The operator machine needs Node.js 22+,
Docker, SSH, the 1Password CLI, and `jq` for the plan-display examples. The
target must be an amd64 or arm64 Linux Docker host reachable through an
already trusted, strict-host-key-checked SSH connection. `BIMO_PACKAGE_ROOT`
makes every example below runnable from any working directory after the
global install.

## License

Apache-2.0. See [LICENSE](LICENSE).

## CLI

List and validate the installed templates:

```bash
bimo list
bimo list --json
bimo targets
bimo targets --json
bimo validate react-app
bimo validate react-solo --json
bimo validate parallel-engineering-pod --json
```

`bimo targets` probes the local Docker daemon and reports the built-in access
adapters. `local` is automatic and is the default. `ssh` and `proxmox-lxc` are
configured per command; their `on-demand` status means Bimo has not contacted a
specific host yet. Local mode uses the active Unix-socket Docker context and
rejects ambient `DOCKER_HOST` overrides.

### Inspect runs and diagnose

`runs`, `status`, and `logs` read the deployment's durable state root through a
read-only, network-disabled container on the target. `doctor` runs locally and
checks Docker, target reachability, state-root writability, disk headroom, and
credential resolvability, reporting pass, fail, or skip per check and exiting
non-zero on any failure. Every command accepts the same target flags as deploy.

```bash
bimo runs --deployment fleet-demo --proxmox root@pve-05 --vmid 113
bimo status --deployment fleet-demo --host deploy@docker-host.example --json
bimo logs --deployment fleet-demo --follow
bimo doctor --deployment fleet-demo --host deploy@docker-host.example \
  --secret-ref 'op://VAULT/ITEM/FIELD'
bimo help doctor
```

`logs --follow` replays the run's events from the start and then polls for new
ones until interrupted. `bimo help COMMAND` (or `bimo COMMAND --help`) prints a
command-specific synopsis; bare `bimo help` keeps the full usage.

### Progress, cancel, and resume

Long `organize` and `deploy` runs print the run ID to stderr as soon as it
exists, then stream bounded progress there — run events as they land in the
durable event log, plus a heartbeat every 30 seconds during quiet phases.
With `--json`, stderr stays clean and stdout carries only the final receipt;
failures then also print a single-line `{"ok":false,"error":{...}}` receipt on
stdout while the human message stays on stderr.

`cancel` sends SIGTERM to the deployment's running controller (or publisher)
container on the target; the in-container controller cancels active work and
finishes the run durably. `publish` resumes an interrupted pod publication
from the durable `publication.ready` record — replaying an already completed
publication returns its receipt with zero new side effects.

```bash
bimo cancel --deployment fleet-demo --host deploy@docker-host.example
bimo publish --deployment pod-demo --host deploy@docker-host.example \
  --github-secret-ref 'op://VAULT/ITEM/FIELD'
```

### Deploy locally

With Docker available, no target flags are required. On this Mac, for example,
the `local` adapter uses the active Colima Docker daemon and builds the image for
the daemon's native `linux/arm64` platform:

```bash
BIMO_PACKAGE_ROOT="${BIMO_PACKAGE_ROOT:-$(npm root --global)/bimo-workflow}"

bimo deploy react-solo \
  --deployment solo-local \
  --task-file "$BIMO_PACKAGE_ROOT/examples/solo-demo.md" \
  --secret-ref 'op://VAULT/ITEM/OPENROUTER_KEY' \
  --public-url 'http://127.0.0.1:8080'

bimo logs --deployment solo-local
```

`--target local` is the equivalent explicit form. Local state lives under
`~/.local/share/bimo/deployments/<deployment>/`. Local deployment still uses
Linux containers and a Docker socket; it does not silently substitute macOS
Seatbelt or Apple's `container` runtime.

### Organize a prompt with agents

`-n` counts independent read-only organizers. It does not resize the selected
workflow or the fixed three-writer engineering pod. Each organizer sees the
same original assignment and the same digest-bound installed catalog. One
valid vote selects with `-n 1`; two must be unanimous; three require a majority.
Any invalid receipt, timeout, digest mismatch, or missing quorum fails without
deploying anything.

```bash
BIMO_PACKAGE_ROOT="${BIMO_PACKAGE_ROOT:-$(npm root --global)/bimo-workflow}"
SMALL_APP_PROMPT="$BIMO_PACKAGE_ROOT/examples/prompts/small-app.md"
SMALL_APP_ASSIGNMENT="$(<"$SMALL_APP_PROMPT")"

PLAN="$(bimo -p "$SMALL_APP_ASSIGNMENT" \
  -n 3 \
  --deployment organize-demo \
  --secret-ref 'op://VAULT/ITEM/OPENROUTER_KEY' \
  --json)"

printf '%s\n' "$PLAN" | jq .
```

The equivalent explicit form starts with `bimo organize -p`. The output is
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
BIMO_PACKAGE_ROOT="${BIMO_PACKAGE_ROOT:-$(npm root --global)/bimo-workflow}"
POD_TASK_FILE="$BIMO_PACKAGE_ROOT/examples/pod-assignment.md"
POD_ASSIGNMENT="$(<"$POD_TASK_FILE")"
REPOSITORY='https://github.com/zaycruz/bimo.git'
BASE_SHA="$(git ls-remote --refs "$REPOSITORY" refs/heads/main | cut -f1)"

POD_PLAN="$(bimo -p "$POD_ASSIGNMENT" \
  -n 3 \
  --deployment pod-plan-demo \
  --target proxmox-lxc \
  --proxmox root@pve-05 \
  --vmid 113 \
  --secret-ref 'op://VAULT/ITEM/OPENROUTER_KEY' \
  --json)"

printf '%s\n' "$POD_PLAN" | jq .

bimo deploy parallel-engineering-pod \
  --deployment pod-demo \
  --target proxmox-lxc \
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
bimo logs \
  --deployment pod-demo \
  --proxmox root@pve-05 \
  --vmid 113 \
  --run <RUN_ID> \
  --json
```

Deploy the sequential three-role workflow independently:

```bash
BIMO_PACKAGE_ROOT="${BIMO_PACKAGE_ROOT:-$(npm root --global)/bimo-workflow}"
LXC_ADDRESS='10.200.160.143' # Replace this when targeting another LXC.

bimo deploy react-app \
  --deployment fleet-demo \
  --target proxmox-lxc \
  --proxmox root@pve-05 \
  --vmid 113 \
  --task-file "$BIMO_PACKAGE_ROOT/examples/fleet-demo.md" \
  --secret-ref 'op://VAULT/ITEM/FIELD' \
  --public-url "http://${LXC_ADDRESS}:8080"
```

Deploy the sequential one-role template independently:

```bash
bimo deploy react-solo \
  --deployment solo-demo \
  --target proxmox-lxc \
  --proxmox root@pve-05 \
  --vmid 113 \
  --task-file "$BIMO_PACKAGE_ROOT/examples/solo-demo.md" \
  --secret-ref 'op://VAULT/ITEM/FIELD' \
  --public-url "http://${LXC_ADDRESS}:8081" \
  --port 8081
```

Read the latest sequential human log or one run's JSON events:

```bash
bimo logs \
  --deployment fleet-demo \
  --proxmox root@pve-05 \
  --vmid 113

bimo logs \
  --deployment fleet-demo \
  --proxmox root@pve-05 \
  --vmid 113 \
  --run <RUN_ID> \
  --json
```

### Deploy to a Docker host

Use `--target ssh --host HOST` when Docker runs directly on the SSH target:

```bash
BIMO_PACKAGE_ROOT="${BIMO_PACKAGE_ROOT:-$(npm root --global)/bimo-workflow}"

bimo deploy react-app \
  --deployment fleet-demo \
  --target ssh \
  --host deploy@docker-host.example \
  --task-file "$BIMO_PACKAGE_ROOT/examples/fleet-demo.md" \
  --secret-ref 'op://VAULT/ITEM/FIELD' \
  --public-url 'http://docker-host.example:8080'

bimo logs \
  --deployment fleet-demo \
  --host deploy@docker-host.example
```

Deploy defaults to local Docker. The explicit forms are `--target local`,
`--target ssh --host HOST`, and `--target proxmox-lxc --proxmox HOST --vmid ID`.
The older `--host` and `--proxmox ... --vmid ...` forms remain aliases. Target
options cannot be mixed. Deploy also accepts exactly one task source
(`--task-file FILE` or `--task-stdin`). Every deployment
requires `--deployment` and `--secret-ref`. Sequential workflows also require
`--public-url`. The fixed pod instead requires `--github-secret-ref`, the fixed
repository URL, an immutable `--base-sha`, and `--target-branch main`.

Optional shared flags are `--account`, `--model`, `--image`, and `--json`;
sequential deploys also accept `--port`. `logs` accepts `--run`, `--image`, and
`--json`.

Defaults are port `8080`, model `openrouter/deepseek/deepseek-v4-flash`, and
image tag `bimo-workflow:0.5.0`. `--account` selects a 1Password account;
`--json` requests machine-readable output.

Quote each `op://` reference as one shell argument. Vault, item, and field names
may contain literal spaces; Bimo passes the validated reference directly to
`op read` without invoking a shell.

`--public-url` is only the address Bimo records and reports for the published
port. Bimo does not create DNS records, TLS certificates, firewall rules,
routes, or a reverse proxy. Supply an address that is actually reachable in
your environment; this repository does not claim a public hosted domain.

## State and logs

One deployment keeps its state on the target. Remote targets use
`/var/lib/bimo/deployments/<deployment>/`; local targets use
`~/.local/share/bimo/deployments/<deployment>/`:

```text
/var/lib/bimo/deployments/<deployment>/
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

Each successful verification creates a separate artifact snapshot that Bimo
treats as immutable: it is created once, permission-locked, and mounted by the
retained app read-only. Bimo performs automatic rollback only when replacing
the current app fails; v0.5 has no user-facing rollback command or remote
artifact backup.

The fixed pod uses the same deployment root but keeps private run records under
`runs/<run-id>/`, including `run.json`, `events.jsonl`, and per-attempt plans,
writer results, gate receipts, and any bounded inbox entry. `source/`,
`worktrees/`, and `snapshots/` are controller-owned temporary roots. Worktrees
and snapshots are removed when compute stops; only the exact Git source needed
for a publication-ready run crosses into the publisher, then it is removed after
durable completion on a best-effort basis.

Before creating a pod run, Bimo retains the newest 20 validated terminal
run records. Active, malformed, or unsafe entries are never deleted
automatically.

A cooperative interruption cancels active agents, records failure, and cleans
owned workspaces. An abrupt host or container loss can leave a `running` record
and private temporary roots. The pod does not resume a partial Planner, writer,
or checker attempt. Confirm no controller or publisher is active, preserve the
run records for diagnosis, then recover only that dedicated deployment root
before starting a new run. The internal publisher can reconcile an interrupted
durable publication, but v0.5 has no general user-facing resume command.

## Security boundary

- The OpenRouter key is resolved locally with `op read`, sent to the controller
  through stdin (and over SSH for remote targets), then sent to a run-scoped
  credential gateway through stdin.
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
- Deployment uses the local Docker daemon, Docker over SSH, or Docker inside a
  Proxmox LXC through `pct exec`. There is no Proxmox API adapter, native Linux
  LXC lifecycle manager, Apple `container` adapter, Seatbelt runtime, Helm,
  Terraform, Kubernetes scheduler, multi-host placement, HA, or autoscaling
  layer.
- Deployment targets are a closed built-in registry, not executable third-party
  plugins. Templates remain data-only packs. A plugin ABI would add lifecycle,
  trust, and compatibility surface before Bimo has a second container runtime
  that needs it; see [the target boundary](docs/targets.md).
- Publication serves static files only. Replacement is preflighted and can
  restore the prior app on failure, but zero downtime is not guaranteed.
- History and artifacts remain on one target host. There is no database, remote
  backup, or user-invoked rollback.
- Organizer audit runs are retained on the target and are not automatically
  pruned in v0.5.
- Pod publication stops at an isolated, draft pull request. It does not approve,
  mark ready, merge, deploy, or delete the branch.

## v0.5 verification

The release gate runs the full Node test suite, package manifest verification,
Docker image build, all template validations, and the bundled starter offline
test, build, and smoke commands. The Bimo brand contract also rejects any
legacy product identifier in the shipped package. Exact results are attached to
the tagged release and its exact-SHA GitHub Actions run.
