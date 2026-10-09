# Golden template, warm pool and runtime delivery (U6, U8)

The Proxmox driver (`src/proxmox/`) clones agent guests from one golden LXC
template and keeps a small warm pool of started, unbound clones per tenant.
A claim takes a pooled guest and binds it through the bind agent baked into
the template (KTD10), and the same bind agent then delivers and runs the
agent's runtime (U8). This page covers what the operator builds by hand, how
the pool behaves and how a runtime gets into a guest.

Monolith never SSHes to a node. The template is built by an operator on the
node; after that the driver uses only the Proxmox HTTPS API with the
pool-scoped token.

## What is in the template

- Debian 13 standard LXC, unprivileged, `nesting=1`, 256 MB, no swap, 6 GB
  on `local-lvm` (lvmthin, so clones are linked: `full=0`).
- `python3`, `python3-venv`, `nftables` and the bind agent (API version 2):
  `bind-agent/monolith-bind-agent.py`, run by
  `bind-agent/monolith-bind-agent.service` on port 7070.
- The runtimes, baked (see "Baked, not fetched" below):
  - Node 24.21.0 linux-x64, the `node` binary only, sha256-pinned, in
    `/opt/monolith/node` (runs eve bundles);
  - `hermes-agent==0.15.2` plus `aiohttp==3.13.3` (its API server needs it) in a venv at `/opt/monolith/hermes`.
- The unprivileged runtime user `monolith-agent` (uid/gid 4990) and
  `/srv/monolith`, where bundles are unpacked.
- `/etc/monolith/template-version`, a human-readable build label.
- No SSH server, no MTA, an empty `/etc/machine-id` (each clone gets its
  own), no CA, key, secret or tenant data.
- Parked at `192.0.2.239/25` (never started again once it is a template;
  every clone gets its own address before its first start).

## Build it (operator, on the node)

```sh
# from a workstation with this repo
scp -r scripts/build-template.sh templates/bind-agent root@pve-node-a:/root/monolith-template/
ssh root@pve-node-a 'sh /root/monolith-template/build-template.sh'
```

The script reuses CT 9000 if it exists and is not yet a template, so a CT
created by hand first is fine. The `pct` commands it runs are:

```sh
pct create 9000 local:vztmpl/debian-13-standard_13.6-1_amd64.tar.zst \
  --hostname monolith-template --unprivileged 1 --features nesting=1 \
  --ostype debian --cores 1 --memory 256 --swap 0 --rootfs local-lvm:4 \
  --net0 name=eth0,bridge=vmbr0,ip=192.0.2.239/25,gw=192.0.2.129 \
  --pool pool-monolith-test --onboot 0
pct start 9000
pct exec 9000 -- systemctl is-system-running --wait   # first boot must finish
pct exec 9000 -- apt-get install -y --no-install-recommends python3 python3-venv nftables ca-certificates
pct exec 9000 -- apt-get purge -y openssh-server postfix
pct exec 9000 -- useradd --system --uid 4990 ... monolith-agent    # plus /srv/monolith
pct exec 9000 -- python3 /root/monolith-node-fetch.py ...         # Node into /opt/monolith/node, sha256-checked
pct exec 9000 -- python3 -m venv /opt/monolith/hermes && /opt/monolith/hermes/bin/pip install hermes-agent==0.15.2 aiohttp==3.13.3
pct push 9000 monolith-bind-agent.py /usr/local/lib/monolith/monolith-bind-agent.py --perms 0755
pct push 9000 monolith-bind-agent.service /etc/systemd/system/monolith-bind-agent.service
pct exec 9000 -- systemctl enable monolith-bind-agent.service
pct exec 9000 -- sh -c ': > /etc/machine-id'
pct shutdown 9000
pct template 9000
```

The build raises the CT to `BUILD_MEMORY_MB` (1024) while it installs and
sets it back to `MEMORY_MB` before templating. Settings are environment
variables (`VMID`, `OSTEMPLATE`, `STORAGE`, `DISK_GB`, `POOL`, `BRIDGE`,
`PARK_IP`, `GATEWAY`, `MEMORY_MB`, `BUILD_MEMORY_MB`, `BIND_PORT`,
`TEMPLATE_VERSION`, `NODE_VERSION`, `NODE_SHA256`, `HERMES_VERSION`,
`RUNTIME_UID`); see the top of the script. Check the exact
`OSTEMPLATE` name with `pveam list local`.

To rebuild, `pct destroy 9000` and run the script again. The driver's
template version is the first 12 hex digits of the template config's
`digest`, so any rebuild or config change is a new version: the next
`monolith pool fill` retires pooled guests from the old one, and a claim
never takes a guest whose version differs from the one the last fill saw.

## Token and scope

The driver token (`agent-driver@pve!example`, role `MonolithDriver` on
`/pool/pool-monolith-test`, `PVEDatastoreUser` on `/storage/local-lvm`,
`PVESDNUser` on `/sdn/zones/localnetwork`) is read from the target's
`token_env` and never written anywhere. The driver also limits itself:

- it creates and destroys only VMIDs inside the target's `vmid_range`
  (9100-9199), and refuses others before any API call (`substrate_refused`);
- every clone is created in the target's `pool` with the description marker
  `monolith-owned`; destroy refuses a guest that is not visible to the token,
  not in the pool, not on the node, or lacks the marker;
- addresses come only from `address_range` (192.0.2.230-.238), never one
  held by a guest the token can see or the pool state records.

## The bind agent

| Endpoint | Meaning |
|---|---|
| `GET /health` | `{"state": "unbound"|"bound", "hostname", "template_version", "api": 2}` |
| `POST /bind` | First bind wins: `{"claim_id", "credential", "payload"}`. A second bind gets 409. |
| `GET /status` | The bound claim. |
| `PUT /runtime/bundle` | Unpack a tar.gz runtime bundle into `/srv/monolith/runtime` (owned by `monolith-agent`; links out of the root are refused). 409 while a runtime runs. |
| `POST /runtime/start` | `{"program", "args", "env", "cwd", "port", "egress_port"}`: install the egress lock, open the loopback egress port, start and supervise the runtime as `monolith-agent` (restarts with backoff; relaunched if the bind agent restarts). |
| `GET /runtime`, `GET /runtime/log` | Supervisor state; the last 256 KiB of the runtime's output. |
| `GET /tunnel` | 101: the connection becomes an idle egress tunnel for the relay. |
| `POST /probe/egress` | `{"host", "port"}`: try a direct connection as `monolith-agent` (the live test expects a refusal). |
| `GET /inspect` | A tar of the guest's writable state and every process's environment and command line, for the no-secret audit. |

Every endpoint except `/health` and `/bind` needs `Authorization: Bearer
<credential>` and answers 401 without it.

The credential is minted by the control plane for this one claim and kept in
the agent's generation directory (`guest-credential`, mode 0600). The guest
keeps only its SHA-256, in `/run` (tmpfs). The payload carries identity
(agent, tenant, generation, target, template version), no secret and no
source; secrets stay with the per-tenant credential proxy (U7).

Stage-1 limit: the first bind is trust-on-first-use. Anything that can reach
an unbound pooled guest's port 7070 before the control plane can bind it.
Per-tenant segments with firewall rules (KTD5, provisioned out of band) are
what close that window; until they exist the test pool shares `vmbr0`.

## Runtime delivery (U8)

After the bind, `monolith agent apply` (`src/proxmox/delivery.rs`):

1. packs the adapter's guest recipe on the control plane: eve ships its
   built `.output` server bundle (made by `eve build`), Hermes its config
   directory as `HERMES_HOME`, plus the agent CA certificate;
2. starts the agent's iron-proxy on the control-plane host (loopback only);
3. raises the guest's memory if the runtime needs more than the pool
   default (eve: 384 MB; Hermes: 256 MB), through the API;
4. uploads the bundle (`PUT /runtime/bundle`);
5. starts the relay (`monolith relay`, a journaled `relay_process`) that
   carries the guest's egress to the proxy;
6. starts the runtime (`POST /runtime/start`) on port 8080 with its proxy
   variables pointing at the guest's `127.0.0.1:7071`;
7. probes the runtime at `http://<guest>:8080` until it accepts a first task.

A guest cloned from a template without the v2 bind agent answers 404, and
apply fails with `target_unavailable` and the rebuild step.

### Baked, not fetched

Node and Hermes are baked into the template rather than fetched at bind
time: a claim then only uploads the agent's own files (the eve example's
bundle is about 4 MB compressed), it never waits on nodejs.org or PyPI, and a
guest has no route to them anyway (its egress goes only to the agent's
allowlist). The cost is template size (about 120 MB for Node, 125 MB for the
Hermes venv) on a linked-clone base, and a template rebuild to change a
runtime version.

Stage-1 limit: the eve bundle is built on the control-plane host. Native
addons in its traced `node_modules` (`node-liblzma`, `@mongodb-js/zstd`,
loaded lazily by just-bash only for `xz`/`zstd` commands) are built for that
host, so those two commands fail in a Linux guest when the control plane is
a Mac. Everything else in the bundle is plain JavaScript.

## The warm pool

Pool state is `.monolith/pools/<target>.json` (override the directory with
`MONOLITH_POOL_DIR`), under an exclusive lock, so separate CLI invocations
share it.

```sh
monolith pool fill   --target proxmox-live --tenant acme --output json
monolith pool status --target proxmox-live --output json
monolith pool drain  --target proxmox-live [--tenant acme] --output json
```

- `fill` brings the tenant up to `warm_pool_size` (default 2, cap 4): it
  clears records left by a filler that died, retires stale or stopped guests,
  then clones the shortfall one at a time (clone, set address, memory and
  tags, start, wait for the bind agent).
- A claim (`monolith agent apply` on a proxmox placement) takes a ready guest
  for the spec's tenant with no Proxmox API call, journals it, binds it and
  confirms the bind with the credential. A guest that will not bind is
  destroyed, never handed out. With no ready guest the claim falls back to a
  cold clone and reports `pooled: false`.
- After a claim the CLI starts `monolith pool fill` in the background to
  replace it (`MONOLITH_POOL_REFILL=0` turns that off).
- `drain` destroys unclaimed guests. Claimed guests belong to agents and are
  removed by `monolith agent destroy`.

Pools are per tenant: a tenant's claim only ever takes that tenant's guests,
and a guest is cloned fresh from the template, so it holds no other tenant's
data. With `tenant_vlans` set on the target, each tenant's guests go on its
own VLAN and an unmapped tenant is refused.

Sizing on pve-node-a: about 15 GB free, shared with other guests. Two
pooled guests per tenant at 256 MB each is the default; the benchmark
records the idle memory each pooled guest actually uses. A claimed eve guest
is raised to 384 MB (Node RSS is about 190 MB); Hermes idles at about 90 MB.

## Warm runtimes (R3: apply to first task under one second)

Measured on pve-node-a before this work, through `monolith agent apply` on a
pooled guest, request to first task accepted (KTD7):

| Runtime | Total | Where it went |
|---|---|---|
| eve | 7.8 s | `eve build` on every apply 5.6 s, bundle 0.4 s, upload 0.3 s, Node start to first task 1.2 s |
| Hermes | 11.9 s | control plane 0.2 s; in the guest, Hermes installed `discord.py` from PyPI at start (8.5 to 9.7 s, lazy install), imports 1.1 s, bundled skills sync 0.4 s, gateway start, and the probe stopping its own run 1.2 to 2 s |

Decisions:

1. **Hermes: a warm runtime per (tenant, runtime), late-bound by go.**
   `monolith pool fill --tenant T --warm hermes` binds each ready guest of
   the tenant's pool to the pool itself (payload `{tenant, warm: <key>,
   target, template_version}`, no agent), uploads a launcher bundle
   (`src/runtimes/hermes_warm.py` and its module list) and starts it under
   the egress lock as `monolith-agent`. The launcher imports the
   third-party modules Hermes loads (the list is from `python -X importtime`,
   minus Hermes modules that read configuration at import), syncs the
   bundled skills into `HERMES_HOME` (configuration-free), then listens on
   8080 and answers everything 503 `{"state": "warm"}`. The guest counts as
   warm only after that answer. At claim the control plane checks the
   binding (`/status`: claim id, tenant, warm key) and the runtime
   (`/runtime`), starts the relay, and sends one `POST /monolith/warm/go`
   with the per-guest go token: the agent's env (placeholder, control key,
   proxy variables), cwd, its `HERMES_HOME` files and the agent CA. The
   launcher writes them, records go in the runtime root (0600, so a
   supervisor restart resumes the same agent), replaces its environment,
   trusts the CA in aiohttp's import-time SSL context, and runs
   `hermes gateway run` in the same process. A claim prefers a guest warm
   with the runtime's current key, then an unwarmed guest (cold-pooled
   delivery), then a cold clone. Keys are `hermes-<hash of launcher and
   module list>`; a fill retires guests warmed with an older key.
2. **Hermes boot trims, all paths:** `HERMES_DISABLE_LAZY_INSTALLS=1` in the
   guest (the guest has no route to PyPI anyway, so the install could only
   fail slowly); the readiness probe no longer stops its run before ready
   (`settle` stops it after the ready journal entry).
3. **eve: build once per source revision.** `eve build` output is cached
   under `MONOLITH_BUILD_CACHE` (default `.monolith/cache`) by a key of the
   source revision, Node version and platform; the staged bundle is cached
   by content. A cache hit makes prepare and bundle about 10 to 20 ms. eve
   has no generic warm runtime: the agent is compiled into its server bundle
   (`.output/server/_libs/eve.mjs`, 4.9 MB), so the runtime cannot start
   before the agent is known. A per-artifact standby (pre-start a given
   build in a pooled guest) would be the next step and is not built.
4. **Memory is raised beside the upload,** not before it.
5. **No template rebuild.** Everything above uses the v2 bind agent as it is
   (bind, bundle, start, status, runtime); template 9000 is unchanged.

Security properties of a warm guest:

- It holds no tenant secret, placeholder, control key or CA before go, and
  serves no task: every request but an authenticated go gets 503. The live
  latency test checks this through `/inspect` before every run.
- The go token and the pool's bind credential are minted per guest by the
  control plane and kept in `<pool dir>/<target>-warm/<vmid>.json` (0600);
  the guest keeps the bind credential's hash only.
- It is bound to its tenant at fill, so it can only ever be claimed by that
  tenant (the claim checks the binding again); the latency test fills
  another tenant's warm guests and shows a claim with an empty pool clones
  rather than take them.
- Egress is locked before the launcher starts, exactly as for a cold start.
- A warm runtime's `/proc/<pid>/environ` shows its pre-claim environment;
  the agent's environment is in the go record, which `/inspect` captures.

Restarts: a warm guest's binding and runtime live in tmpfs, so a guest
restart empties it. A claim that finds a warm guest emptied does not use it:
the guest becomes a dead record for the next fill or drain to destroy (off
the request path), and the claim takes the next guest. `pool fill --warm`
re-checks warm guests and re-warms emptied ones. On pve-node-a something outside
Monolith installs tailscale into every new container and restarts it about
three minutes after its first start;
that also kills any agent claimed in that window, cold or warm, and is an
operator item.

Floors (live, pve-node-a, 1 vCPU guests): Hermes go to first task accepted is
about 0.6 to 0.8 s (gateway construction, adapters, API server start), so
warm Hermes lands at about 0.8 to 0.95 s apply to ready (final run, n=6:
p50 834 ms, p95 1004 ms, the one sample over 1 s in a noisy round; R3 is
borderline, STOP by 4 ms). eve, n=6: p50 1622 ms, p95 2297 ms. eve's floor on a
pooled guest is Node loading its server bundle in the guest (0.8 to 0.9 s;
150 ms on the control-plane Mac) plus upload (0.3 s), about 1.5 s: eve does
not meet R3 without a per-artifact standby. Of the Hermes breakdown,
`proxy_plan`, `proxy_start` and `relay_start` (about 90 ms together) are the
control-plane iron-proxy and its relay, and move when the proxy moves to a
per-tenant proxy guest; the go protocol carries the proxy variables and CA
it is given and does not depend on where the proxy runs.
