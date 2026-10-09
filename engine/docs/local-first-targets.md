# Local-first deployment targets

Monolith now treats deployment target selection as a separate module from the
workflow runtime.

That seam is intentionally small:

- The manifest still describes one workflow/runtime topology.
- The worker protocol still describes one pod-to-worker execution contract.
- The deployment target decides where the controller/runtime will execute.

## Current target model

The CLI has two target-oriented commands:

- `monolith targets` shows the resolved target catalog.
- `monolith deploy <manifest> --target <name>` resolves one target and runs the
  existing local runtime only when that target is executable in the current
  build.

All operator commands also accept `--target <name>`.

Supported target kinds:

- `local` — implemented. This is the existing single-host process model and the
  only executable target kind in this release.
- `ssh` — reserved. Planned for running the same Monolith controller on a
  remote Unix host over an operator-managed transport.
- `proxmox` — driver implemented for spec-declared agents (U5, U6): linked
  LXC clones of a golden template, a per-tenant warm pool, static addresses,
  hard scoping to one pool and VMID range. Launching a runtime inside the
  guest is not built yet (U8). See `templates/README.md` and the driver
  fields in `examples/targets.toml`.

Named targets may be declared in `.monolith/targets.toml`. The target name is
what users pass to `--target`. The target kind tells Monolith which runtime
adapter would be responsible for that target.

Example:

```toml
schema_version = 1
default_target = "local"

[[targets]]
kind = "proxmox"
name = "homelab-lxc"
api_url = "https://pve-node-b:8006/api2/json"
token_env = "MONOLITH_PROXMOX_TOKEN"
cluster = "homelab"
node = "pve-node-b"
guest_type = "lxc"
guest_id = 203
artifact_lifecycle = "persistent"
```

The current build reads that configuration and reports it through
`monolith targets`. Factory manifests (`monolith deploy`) still run only on
`local`; spec-declared agents placed on a proxmox target go through the
Proxmox driver, which needs the driver fields shown in
`examples/targets.toml` (pool, template_id, vmid_range, bridge,
address_range, prefix_len, gateway, and tls_ca_file or tls_verify).

## Autodetect policy

Autodetect does:

- add a built-in `local` target when no configured target named `local` exists
- report the current host OS for the local target
- report whether the local target is executable on the current platform
- report whether a configured target's secret-ref env var is present

Autodetect does not:

- guess Proxmox clusters, nodes, LXC IDs, VM IDs, or guest names
- create or mutate local containers, seatbelt profiles, LXCs, or VMs
- probe remote APIs just to populate the target list
- infer secret env var names or materialize secret values
- decide whether an artifact should be ephemeral or persistent

## Why this is not a plugin system yet

The codebase has one real implementation today: `local`.

Adding a general plugin registry now would create a shallow module: more
surface, more indirection, and no second working adapter yet. The current seam
is therefore a built-in target module with explicit reserved variants.

When a second target is real, the module can deepen naturally:

- `local` keeps direct process and state-directory access.
- `ssh` can own remote command construction, state lookup, and log retrieval.
- `proxmox` can own VM/LXC placement, remote controller bootstrapping, and
  post-deploy attachment.

Until then, Monolith stays honest: local-first is implemented, remote targets
are named and configurable, but not claimed as deployable.
