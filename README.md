# Monolith v0.2

Monolith deploys a predefined agent workflow to one Docker host. The complete
workflow definition is deliberately small:

**[Open the live agent-built demo](https://thisismonolith.pages.dev/).** It is
the unchanged static artifact from the final `react-app` run on `pve-05`, not a
hosted Monolith control plane.

```text
template = workflow.json + one Markdown prompt per role
```

The CLI validates that data, starts one temporary controller, and the controller
launches one ephemeral role container at a time. There is no fleet service,
manager agent, message bus, database, scheduler, or general-purpose graph
engine.

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

## The template contract

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

## What happens during a deployment

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

Monolith v0.2 is not published to the npm registry. Download the release
tarball, verify it, and install that exact file:

```bash
curl --fail --location --remote-name \
  https://github.com/zaycruz/monolith-v2/releases/download/v0.2.0/monolith-workflow-0.2.0.tgz
printf '%s  %s\n' \
  3f93ed7439313066e5fa031f3a6b63df45519cd03c04d3b198bccfa8ef10051c \
  monolith-workflow-0.2.0.tgz | shasum --algorithm 256 --check
npm install --global ./monolith-workflow-0.2.0.tgz
monolith list --json
monolith validate react-app
```

To build the package from source instead:

```bash
git clone --depth 1 https://github.com/zaycruz/monolith-v2.git
cd monolith-v2
npm ci
npm test
npm pack
npm install --global ./monolith-workflow-0.2.0.tgz
monolith --help
```

The operator machine needs Node.js 22+, Docker, SSH, and the 1Password CLI. The
target must be an amd64 Linux Docker host reachable through an already trusted,
strict-host-key-checked SSH connection.

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
```

### Deploy through `pve-05`

`--proxmox` connects to the Proxmox node over SSH and runs Docker inside the
selected LXC through `pct exec`. Replace every angle-bracket placeholder before
running this example:

```bash
monolith deploy react-app \
  --deployment fleet-demo \
  --proxmox root@pve-05 \
  --vmid <DEDICATED_DOCKER_LXC_VMID> \
  --task-file examples/fleet-demo.md \
  --secret-ref 'op://VAULT/ITEM/FIELD' \
  --public-url 'http://<LXC_ADDRESS>:8080'
```

Deploy the one-role template independently:

```bash
monolith deploy react-solo \
  --deployment solo-demo \
  --proxmox root@pve-05 \
  --vmid <DEDICATED_DOCKER_LXC_VMID> \
  --task-file examples/solo-demo.md \
  --secret-ref 'op://VAULT/ITEM/FIELD' \
  --public-url 'http://<LXC_ADDRESS>:8081' \
  --port 8081
```

Read the latest human log or one run's JSON events:

```bash
monolith logs \
  --deployment fleet-demo \
  --proxmox root@pve-05 \
  --vmid <DEDICATED_DOCKER_LXC_VMID>

monolith logs \
  --deployment fleet-demo \
  --proxmox root@pve-05 \
  --vmid <DEDICATED_DOCKER_LXC_VMID> \
  --run <RUN_ID> \
  --json
```

### Deploy to a Docker host

Use `--host` instead of `--proxmox` and `--vmid` when Docker runs directly on
the SSH target:

```bash
monolith deploy react-app \
  --deployment fleet-demo \
  --host deploy@docker-host.example \
  --task-file examples/fleet-demo.md \
  --secret-ref 'op://VAULT/ITEM/FIELD' \
  --public-url 'http://docker-host.example:8080'

monolith logs \
  --deployment fleet-demo \
  --host deploy@docker-host.example
```

Deploy accepts exactly one target (`--host`, or `--proxmox` with `--vmid`) and
exactly one task source (`--task-file FILE` or `--task-stdin`). Required fields
are `--deployment`, `--secret-ref`, and `--public-url`. Optional deploy flags are
`--account`, `--port`, `--model`, `--image`, and `--json`. `logs` additionally
accepts `--run`, `--image`, and `--json`.

Defaults are port `8080`, model `openrouter/deepseek/deepseek-v4-flash`, and
image tag `monolith-workflow:0.2.0`. `--account` selects a 1Password account;
`--json` requests machine-readable output.

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
the current app fails; v0.2 has no user-facing rollback command or remote
artifact backup.

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

Never put a credential in a task, prompt, workflow file, repository file,
`--public-url`, or deployment name.

## Scope and limitations

- Roles are sequential ephemeral containers, not persistent pods and not
  parallel workers.
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
  manager hierarchy, inter-agent chat, or general graph runtime.
- Deployment is Docker over SSH, directly or through Proxmox `pct exec`. There
  is no Helm, Terraform, Kubernetes scheduler, multi-host placement, HA, or
  autoscaling layer.
- Publication serves static files only. Replacement is preflighted and can
  restore the prior app on failure, but zero downtime is not guaranteed.
- History and artifacts remain on one target host. There is no database, remote
  backup, or user-invoked rollback.

## Release evidence

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
