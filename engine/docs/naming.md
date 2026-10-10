# Names: Bimo and the Monolith prototype

The engine began as the Monolith prototype. The binary, the crate and the
operator-facing names are now Bimo's. The names
from the engine's Monolith prototype stay as aliases, so existing
environments, scripts and state keep working.

| Bimo name | Also read |
| --- | --- |
| binary `bimo-engine`, crate `bimo_engine` | — (was `monolith`) |
| envelope schema `bimo.cli/v1` | — (was `monolith.cli/v1`; nothing reads envelopes back) |
| `.bimo/agents`, `.bimo/pools`, `.bimo/reports`, `.bimo/targets.toml` | the `.monolith/` path when only that exists |
| `BIMO_STATE_ROOT`, `BIMO_READY_TIMEOUT_MS`, `BIMO_POOL_DIR`, `BIMO_POOL_REFILL` | `MONOLITH_` of the same name |
| `BIMO_HERMES_BIN`, `BIMO_IRON_PROXY_BIN`, `BIMO_NODE_BIN`, `BIMO_IRON_PROXY_GUEST_BIN` | `MONOLITH_` of the same name |
| `BIMO_BUILD_CACHE`, `BIMO_NPM_CACHE`, `BIMO_INJECT_CRASH` | `MONOLITH_` of the same name |
| `BIMO_SECRET_<TENANT>__<NAME>` | `MONOLITH_SECRET_<TENANT>__<NAME>` |
| `BIMO_PROXMOX_LIVE`, `BIMO_PROXMOX_TARGETS`, `BIMO_PROXMOX_TARGET`, `BIMO_PROXMOX_FOREIGN_VMID` (live tests) | `MONOLITH_` of the same name |

A target's `token_env` names its token variable; the examples use
`BIMO_PROXMOX_TOKEN`, and a targets file that names `MONOLITH_PROXMOX_TOKEN`
keeps working.

## Names kept on purpose

These are part of the golden template and the guests already running from it.
Renaming them would change live substrate behaviour, so they keep their names
until a template version bump renames them together:

- variables the engine sets for a runtime, proxy or guest:
  `MONOLITH_CONTROL_KEY`, `MONOLITH_WARM_TOKEN`, `MONOLITH_WARM_PORT`,
  `MONOLITH_PROXY_*`, `MONOLITH_IRON_PROXY`, `MONOLITH_RUNTIME_ROOT`,
  `MONOLITH_RUNTIME_USER`, `MONOLITH_BIND_*`, `MONOLITH_SRV_DIR`,
  `MONOLITH_WORKER_CONFIG`;
- guest paths `/opt/monolith`, `/srv/monolith`, `/etc/monolith`, the
  `monolith-bind-agent` unit and the `monolith-agent` runtime user;
- the Proxmox ownership tag `monolith` and the bind-agent path
  `/monolith/warm/go`;

## Deferred renames

- Template v5: rename the guest variables, paths, unit, user and ownership tag
  above, with a migration that adopts guests tagged `monolith`.
- Proxmox resource pool and role names in examples (`pool-monolith-test`,
  `MonolithDriver`) follow the operator's cluster, not the code.
- `engine/workers/pi-core` (the factory's Pi adapter) is needed only by
  `engine/examples/pi-core.toml`; move or drop it with the factory.
- `engine/docs/plans/2026-08-21-agent-engine-workers.md` and
  `engine/docs/benchmarks/` keep the prototype's history and names, including
  `.monolith/reports` paths.
