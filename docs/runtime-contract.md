# Runtime contract

Bimo separates placement from execution. A **target** is where a payload runs:
which host executes commands and where durable run state lives
([docs/targets.md](targets.md)). A **runtime** is how the payload executes:
the isolation mechanism that turns one validated image and one strict argv
into a bounded, sandboxed execution.

Today there is one runtime, Docker, behind three target access paths
(`local`, `ssh`, `proxmox-lxc` in `src/deployment-target.mjs`). This document
defines the contract a second runtime adapter must satisfy. It exists so the
runtime matrix in [#12](https://github.com/zaycruz/bimo/issues/12) grows by
evidence, not by adding a plugin system.

The matrix is local-first and Unix-only. Every adapter must work as a local
runtime on Linux or macOS before any remote form is considered. Windows is
not a target platform and is not planned.

## The bounded runtime contract

The contract is the operation set `DockerRuntime`
(`src/docker-runtime.mjs`) actually performs, reduced to its semantics. An
adapter implements these operations and nothing more. If a platform cannot
express one, the adapter fails closed; it does not silently degrade.

1. **Prepare the payload.** Build or import one architecture-matched image
   for the runtime, and prove identity after transfer: Bimo today builds for
   the target platform, transfers with `docker save`/`load`, and compares
   content fingerprints on both sides (`prepareImage` in `src/bimo.mjs`).
   The runtime never pulls a mutable reference at run time: every
   `docker run`/`create` is pinned with `--pull=never`, and the read paths
   (`logs`, `runs`, `status`, `cancel`, `publish`) preflight local image
   presence and fail closed with a build hint instead of letting Docker
   attempt an implicit pull.
2. **Provision the deployment environment.** Create the isolated internal
   network, the separate egress network, and the run-scoped credential
   gateway, then health-probe the gateway before any agent starts
   (`DockerRuntime.start`). An adapter must reproduce the topology: agents on
   a network with no direct egress; only the gateway attached to both.
3. **Run bounded executions.** Create and start one sandboxed payload from a
   trusted argv array, with the full sandbox posture below, a per-phase
   deadline bounded by the deployment deadline, and capped output
   (`#runAgentExecution`, `verify`, `verifySource`). Execution output ends
   in one machine-readable receipt line the controller validates.
4. **Exec verification gates.** Run the deterministic gates — output
   verifier, source candidate/baseline suites, publication health probes —
   as no-network executions inside the runtime, and return their exact
   output for controller-side receipt validation. Gates are controller-owned;
   the runtime supplies only execution and output.
5. **Expose logs.** Return bounded stdout/stderr and the exit code of every
   execution. Durable logs (`events.jsonl`, `CHANGELOG.md`) remain
   controller-owned files under the state root; the runtime only has to
   surface execution output faithfully and within its byte cap.
6. **Cancel.** Abort active operations and terminate every running execution
   owned by the deployment, promptly and before cleanup (`cancel`,
   `commandWithin` abort listeners).
7. **Clean up.** Remove every runtime-owned resource — executions, the
   gateway, networks — on success, failure, cancellation, and deadline
   expiry, within a short separate cleanup margin (`performClose`,
   `reconcileTransientResources`). Resources carry deployment-scoped labels
   so reconciliation can find and remove strays.
8. **Verify artifacts.** Hand verified output to the controller's snapshot
   path, which copies, permission-locks, and re-hashes it into an immutable
   per-run snapshot with a sha256 receipt (`snapshotDirectory`). The runtime
   supplies the workspace mount; the receipt check is controller-side and
   must not be bypassable by the payload.
9. **Hold the durable state root.** Present a target-visible deployment root
   (`deploymentRootForTarget`) containing the workspace and run records, as
   private regular directories with ownership and mode the controller
   asserts before every execution.

That is the whole contract. There is no service registration, no discovery,
no hooks API, no lifecycle events stream, and no per-template runtime
options. Same discipline as the target seam: the registry stays closed and
built-in until two or more external runtimes demonstrably need independent
release cycles.

## Security invariants

No adapter may weaken these, regardless of platform capability. If the
platform cannot express one, the adapter is not supported.

- **Operator-only authority.** Target and runtime selection happen only in
  the operator CLI. Templates are data-only manifests; agents and organizer
  votes can never choose a target, runtime, image, command, or credential.
  This mirrors the target seam's rule and extends it unchanged to runtimes.
- **Strict argv construction.** Every runtime operation is a validated argv
  array executed without a shell (`commandForTarget`, `execute`). Names,
  images, paths, and roles are regex-validated before they reach argv. An
  adapter never interpolates values into a command string.
- **Bounded deadlines.** One deployment deadline bounds image inspection,
  bootstrap, every role, verification, and publication. Phase timeouts clamp
  to it; cleanup gets its own short margin. An adapter must make deadline
  expiry and cancellation actually stop the payload, not just return early.
- **Sandbox posture.** Executions run as a non-root user with a read-only
  root filesystem, all capabilities dropped, `no-new-privileges`, pid,
  memory, CPU, and file-size limits, private temporary storage, and no
  runtime control socket. Where a platform lacks an exact equivalent, the
  adapter maps to the strongest available primitive and documents the delta;
  a missing isolation primitive is a documented weakness, never a silent
  omission.
- **Private credential handling.** The model key is resolved locally with
  `op read` and delivered only through stdin to the controller and then the
  run-scoped gateway. It never appears in argv, environment, workflow JSON,
  prompts, logs, or the shared workspace. The adapter's transport must
  preserve this: no credential in an API payload that the platform logs or
  persists.
- **Deterministic receipts.** Image digests, execution receipts, artifact
  receipts, and verifier evidence are exact-shape, hash-bound values the
  controller validates (`validateArtifactReceipt`,
  `validateSourceVerifierReceipt`). The runtime produces evidence; the
  controller alone decides pass/fail.

## Adapter acceptance criteria

An adapter is not "supported" until all of the following pass end to end on
its platform, in CI where the platform allows hosted runners and as an
operator-run E2E rig elsewhere:

1. **Deploy**: a bundled template runs to a verified, published result.
2. **Logs**: `bimo logs` returns the deployment's events and run records.
3. **Cancellation**: an interrupted deployment stops its payload and reports
   failure instead of hanging or completing.
4. **Cleanup**: after success, failure, and cancellation, no adapter-owned
   resources remain (executions, networks, gateway, temporary roots).
5. **Verification**: the deterministic gates run and their receipts gate the
   result exactly as under Docker.
6. **Artifact recovery**: the immutable snapshot, its sha256 receipt, and
   rollback-on-failed-replacement behave identically.

Partial support is reported as unsupported. `bimo targets` lists an adapter
only after this evidence exists. This is the same bar
[docs/targets.md](targets.md) sets for the target seam, applied per runtime.

## Rollout order

Order is fixed by [#12](https://github.com/zaycruz/bimo/issues/12). Each
adapter lands as a built-in behind the closed registry, proving the seam
before the next one starts.

### 1. podman — seam-prover

- **Isolation model**: OCI containers, rootless by default. Near-Docker CLI
  surface; most `DockerRuntime` argv maps directly.
- **Platform requirements**: Linux; rootless podman socket on the target.
- **Image/payload format**: OCI image, `podman save`/`load` transfer with the
  same content-fingerprint check.
- **Open questions**: SELinux labeling on bind mounts (`:z`/`:Z` versus the
  current plain bind flags); rootless network parity for the internal +
  dual-attach gateway topology; label-filter reconciliation parity; whether
  `no-new-privileges` and the exact resource-limit flags behave identically.
- **Why first**: smallest semantic delta from Docker. Its job is to prove
  the runtime seam exists as a real interface before any platform with
  different semantics arrives.

### 2. Apple container — native macOS

- **Isolation model**: per-container lightweight VMs via Apple's
  Virtualization.framework. Stronger kernel isolation than Docker on macOS;
  this is a priority platform for the owner.
- **Platform requirements**: macOS 26+ on Apple silicon; the `container`
  CLI and its system service.
- **Image/payload format**: OCI image imported into the `container` image
  store; transfer path and fingerprint check need a new implementation —
  there is no `docker save` equivalent byte stream to pipe over SSH.
- **Open questions**: sandbox-flag parity (read-only root, capability drop,
  `no-new-privileges`, resource limits, tmpfs mounts); network model for the
  no-egress agent network plus dual-attached gateway; UID/GID mapping for
  the permission-locked snapshot. Biggest single unknown: whether the
  two-network gateway topology is expressible at all.
- **Why second**: it is the owner's primary machine, and it forces the
  contract to survive a genuinely different network and filesystem model.

### 3. Proxmox API target — LXC or QEMU at deploy time

- **Isolation model**: unchanged runtime semantics; this is a **target**,
  not a runtime. The operator chooses LXC or QEMU VM at deploy time, and
  Bimo provisions the guest through the Proxmox API instead of assuming an
  existing guest.
- **Platform requirements**: the owner's Proxmox host PV05 is the E2E rig;
  API token scoped to guest lifecycle on a dedicated pool.
- **Image/payload format**: the guest still runs Docker (or a later
  runtime); the API replaces SSH as the provisioning and command transport
  where the guest allows it.
- **Open questions**: credential handling — the API token must not appear in
  argv, logs, or run records; command execution channel into the guest
  (guest agent versus SSH after provisioning); teardown guarantees so a
  failed deploy never strands a guest on PV05.
- **Why third**: it widens the target side using runtime evidence already
  gathered, and PV05 is already the proven Proxmox rig.

### 4. native LXC — no nested Docker

- **Isolation model**: one dedicated unprivileged LXC per execution or per
  deployment, with cgroups, seccomp, and capability bounding applied by LXC
  itself. The payload runs directly in the container rootfs; there is no
  Docker daemon inside.
- **Platform requirements**: Linux host with LXC tooling; unprivileged
  containers only.
- **Image/payload format**: the OCI image must be unpacked into a rootfs the
  runtime assembles (or an equivalent payload bundle); no daemon performs
  this step.
- **Open questions**: rootfs assembly and caching; network namespace
  topology for the gateway pattern; how per-phase bounded exec gates map
  onto `lxc-execute` with hard timeouts; snapshot semantics without a
  layered image store.
- **Why fourth**: it removes the nested-Docker dependency of
  `proxmox-lxc`, but only after the seam has absorbed podman and Apple
  container.

### 5. Firecracker microVM

- **Isolation model**: KVM microVM, one per execution; the strongest
  isolation in the matrix.
- **Platform requirements**: Linux with `/dev/kvm`; a host-side agent or
  vsock channel to drive execution and collect output.
- **Image/payload format**: rootfs image plus kernel; the OCI payload must
  be repacked into a microVM rootfs, and the guest needs a small init that
  runs the bounded execution and emits the receipt.
- **Open questions**: the guest-agent/exec channel for gates and log
  capture; network egress model, since dual-attaching one gateway VM to two
  networks differs from container networking; boot-time budget against the
  deployment deadline.
- **Why fifth**: highest engineering cost per unit of new capability; only
  justified once the contract is proven on four cheaper adapters.

### 6. Seatbelt (`sandbox-exec`) — weakest isolation

- **Isolation model**: macOS process sandbox profile. No filesystem image,
  no separate user, no network namespaces, no kernel isolation.
- **Platform requirements**: macOS; `/usr/bin/sandbox-exec`.
- **Image/payload format**: none. The payload runs as a host process under a
  profile with a deny-by-default filesystem and network rule set.
- **Open questions**: the profile must reproduce the sandbox posture as
  process rules — read-only workspace masking, tmpfs equivalents, network
  deny except the gateway — and several Docker primitives (read-only root,
  capability drop, pid limits) have no equivalent. Whether Seatbelt can
  satisfy the contract at all, or ships only as a reduced capability local
  runtime with documented weaker isolation, is a decision the evidence from
  adapters 1–2 informs.
- **Why last**: it tests the contract's lower bound. If the invariants
  cannot be met, the honest outcome is exclusion, documented here in
  advance.

## Non-goals for alpha

- No daemon, service manager, or long-lived control plane.
- No scheduler, queue, or multi-host placement.
- No graph engine or general DAG execution.
- No plugin marketplace or third-party executable adapters; the registry
  stays closed and built-in.
- No Windows support, in either target or runtime.

## Open design questions

Consolidated from the rollout notes, to be answered by adapter evidence in
order:

1. Can Apple's `container` express the two-network credential-gateway
   topology, and if not, what equivalent no-direct-egress shape does the
   contract accept?
2. How do image transfer and content-fingerprint verification work without
   a `docker save`-style byte stream (Apple container, native LXC,
   Firecracker)?
3. Where does the Proxmox API token live so it never enters argv, logs, or
   run records, and what is the exec channel into API-provisioned guests?
4. Which Docker sandbox primitives lack any Seatbelt equivalent, and does
   that leave Seatbelt inside the contract or out?
5. Does the contract need a formal capability matrix (adapter × invariant)
   once two adapters exist, or does prose plus CI evidence stay enough?
