# Deployment targets

Bimo keeps workflow semantics separate from placement. A template says which
roles run and how their receipts transition. A deployment target says where the
same Docker commands execute and where durable run state lives.

The current built-in target set is deliberately closed:

| Target | Command execution | State root | Selection |
| --- | --- | --- | --- |
| `local` | Active local Docker context over a Unix socket | `~/.local/share/bimo/deployments/<name>` | Default, or `--target local` |
| `ssh` | Docker over strict, batch-mode SSH | `/var/lib/bimo/deployments/<name>` | `--target ssh --host HOST` |
| `proxmox-lxc` | `pct exec VMID -- docker ...` over strict, batch-mode SSH | `/var/lib/bimo/deployments/<name>` in the LXC | `--target proxmox-lxc --proxmox HOST --vmid ID` |

Run `bimo targets` to probe the local daemon and list the command-time adapters.
The legacy `--host HOST` and `--proxmox HOST --vmid ID` forms still resolve to
the same `ssh` and `proxmox-lxc` adapters.

Local mode follows the active Docker context and accepts only `linux/amd64` or
`linux/arm64` daemons exposed through a Unix socket. Bimo rejects ambient
`DOCKER_HOST` overrides so an inherited shell variable cannot silently redirect
a local deployment. Remote targets are probed before build, and Bimo builds the
transferred image for the target daemon's reported architecture.

## The seam

The implementation has four small operations:

1. Resolve one target from exact CLI options.
2. Convert a trusted argv array into a local process or strict SSH invocation.
3. Choose the target-visible deployment root.
4. Prepare or transfer the architecture-matched Bimo image.

Templates and organizer agents cannot choose a target, inject a command, or
install code. Target authority stays in the operator CLI.

## Why this is not a plugin system yet

There is one execution runtime today: Docker. Local, SSH, and Proxmox-LXC are
different access paths to that same runtime. Loading arbitrary executable
plugins now would require a versioned ABI, discovery rules, trust and signing
policy, secret routing, failure cleanup, and compatibility guarantees without
adding a new capability.

When a real second runtime is implemented, it should first satisfy the same
bounded target contract as a built-in adapter. Apple `container`, native Linux
LXC lifecycle management, and Proxmox API provisioning each have materially
different image, network, storage, and cleanup semantics; none is represented
as working until its end-to-end deploy and log path is verified. If two or more
external adapters then need independent release cycles, the built-in registry
can become a versioned plugin boundary with evidence instead of speculation.
