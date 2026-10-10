# Credential boundary

An agent never holds a real credential (R7). Its outbound traffic is denied by
default, allowed per agent by the spec's `egress.allow`, and every request is
recorded (R8). The engine gets both from one iron-proxy instance per agent
generation (KTD4), plus confinement that stops the agent from going around
the proxy.

Code: `src/proxy.rs` (CA, secret files, reload), `src/proxy/config.rs`
(generated iron-proxy config), `src/substrate.rs` (start order and local
confinement). Proven by `tests/e2e_fabric.rs`.

## What the agent gets

| The agent has | The agent does not have |
|---|---|
| A placeholder in each secret's `env`, shaped by the runtime adapter so the runtime picks the same auth mode a real key would | The real value, anywhere in its environment or readable files |
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (and lowercase forms) pointing at its proxy; `NODE_USE_ENV_PROXY=1` | A network path to anything except its proxy's listener |
| `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS` pointing at its CA certificate | The CA key, the secret files, the proxy config or the audit log |

The placeholder is derived from the agent's control key and the variable
name, so it is stable across restarts and rotations.

## What the proxy does

For each agent generation the control plane writes a proxy directory
(`gen-<n>/proxy/`, mode 0700) holding:

- `ca.crt`, `ca.key`: a CA generated for this agent (ECDSA P-256). Critical
  `CA:TRUE, pathlen:0`; critical key usage `keyCertSign, cRLSign` only; name
  constraints that permit exactly the hosts in `egress.allow` (and, when the
  allowlist has no IP address, only `0.0.0.0/32` for IP names, so no
  certificate for a real IP validates). Apply parses the certificate back and
  refuses to start the agent if any of these flags is wrong. Valid for 30
  days; every new generation gets a new CA.
- `secrets/<ENV>.secret` (0600): the resolved real value, one file per secret.
- `management.key`: the bearer for the proxy's reload API.
- `iron-proxy.yaml`: generated from the spec:
  - every listener (tunnel, transparent HTTP and HTTPS, management, metrics)
    binds to `127.0.0.1` on a port the driver allocates; DNS is off;
  - the `allowlist` transform holds `egress.allow`: domains (`*.example.com`
    means subdomains) and IPv4 addresses as `/32`;
  - the `secrets` transform maps each placeholder to its file and swaps it,
    in any request header, only on requests to that secret's `hosts`. A
    placeholder sent to any other host, allowed or not, is forwarded
    unchanged;
  - `upstream_deny_cidrs` stays at iron-proxy's default (loopback, link-local
    and cloud metadata addresses) unless the target overrides it.

The driver starts the proxy first, waits for its listener, then starts the
agent. The proxy is a resource of the agent like the runtime itself: it is
journaled before and after it exists, shown by `status`, cleared by
recovery, retired with its generation and stopped by `destroy`.

## Audit log

The proxy writes one JSON line per request to
`<state-root>/<agent>/logs/egress-audit.jsonl`, read with
`bimo agent logs <name> --stream egress`. Lines with `"msg":"request"`
carry `audit.host`, `method`, `path`, `action` (`allow`, `reject`, `error`)
and `status_code`; a refusal carries `rejected_by` (for example
`allowlist`), and a swap carries `annotations.swapped` with the header it
touched. Values are never logged.

## Secret rotation

Change the value in the target's secret source and run `apply` again with
the same spec. Apply sees the new value (by a salted digest kept in the
agent record), rewrites the secret files atomically and calls the proxy's
`POST /v1/reload`. Nothing restarts and the placeholder is unchanged. The
result has `changed: true` and lists the variables in `rotated`; the journal
gets a `secrets_rotated` event. If the proxy rejects the reload, the running
proxy keeps its previous configuration and apply fails with `proxy_failed`.
On Proxmox the new values go to the agent's route in its tenant's proxy
guest, which reloads the same way.
The E2E suite confirms rotation against the live proxy by sending a request
through it and checking the upstream receives the new value.

## Confinement on the local substrate

Proxy variables are a convenience; a tool that ignores them must not get
out (plan risk "Tools bypass proxy environment variables").

On macOS the local driver runs the agent under `sandbox-exec` with a profile
written to `gen-<n>/sandbox.sb`:

- outbound network: denied, except to the proxy's listener port on
  localhost and to local Unix sockets;
- files: no reads of file contents or writes anywhere under the state root
  except the agent's own generation directory, and nothing at all in the
  proxy directory. This also keeps other agents' and other tenants' state,
  secrets and logs out of reach.

The E2E suite runs `curl` and `cat` under that same profile to prove a
direct connection fails (curl exit 7), that a host outside the allowlist is
refused (403) and audited, and that the proxy's files, the audit log, the
control key and another tenant's secrets cannot be read.

Limits of local mode, stated plainly:

- **Linux:** the local substrate does not confine agents. It is a
  development substrate there; the proxy variables are the only routing.
- **Same user:** local agents and their proxies run as the operator's user.
  The sandbox blocks file access, but a process can still read another
  same-user process's arguments and environment through `sysctl`. The proxy
  keeps secrets in files, not in its environment or arguments, so this
  exposes only the proxy's management key, and the agent has no network path
  to the management port.
- **Builds:** `prepare` steps (for eve, `npm ci` and `eve build`) run on the
  control-plane side before the agent starts, with the operator's network,
  not inside the boundary. They receive no secret values.
- The readiness probe and runtime-state check go from the control plane to
  the agent directly; they are inbound to the agent and not proxied.

Allowing loopback upstreams: a local target may set
`upstream_deny_cidrs` to replace the proxy's upstream deny list, for example
so agents can reach a model server on this host:

```toml
[[targets]]
kind = "local"
name = "loopback"
upstream_deny_cidrs = ["169.254.169.254/32"]
```

## On Proxmox

Stage 2 (U7, KTD4, KTD5, KTD10): each tenant has one always-on **proxy
guest** on the target, and every agent generation of that tenant gets a
**route** there: its own iron-proxy instance with its own CA, secret files
and allowlist. Nothing of the boundary runs on the control-plane host (no
iron-proxy, no relay), and nothing of it runs in the agent's guest.

Code: `src/proxmox/tenant_proxy.rs` (the proxy guest's lifecycle and routes),
`src/proxmox/tenant_proxy.py` (the supervisor that runs in it),
`templates/bind-agent/monolith-bind-agent.py` (API 3: the egress locks).

The proxy guest:

- a linked clone of the golden template in the target's pool and VMID
  range, with the ownership marker, `role=proxy` in its description and the
  `monolith-proxy` tag. Its record is
  `<pool dir>/<target>-proxies/<tenant>.json` (mode 0600: it holds the bind
  credential and the control token), never the pool state, so pool fill,
  drain and claim never touch it. `bimo proxy up|status|down` manages it;
  `agent apply` starts it when it is missing.
- bound like any guest (payload `role: "proxy"`), then given a bundle with
  the supervisor and the Linux iron-proxy build through the bind agent. No
  template change carries iron-proxy.
- the supervisor runs as `monolith-agent` under the bind agent's **upstream**
  lock: loopback and DNS are open, IPv6 and the private, link-local,
  carrier-grade NAT and multicast ranges are refused, the rest is open. Each
  route's iron-proxy also refuses those ranges upstream
  (`upstream_deny_cidrs`), so a route can reach only public hosts on its
  allowlist.
- route files (CA key, management key, secret values, config) live in
  `/dev/shm/monolith-proxy/routes/<route>` (tmpfs, mode 0700/0600) and in the
  control plane's memory while it applies; never on the control plane's disk.

The agent guest:

- its proxy variables are `http://<route>:<token>@<proxy guest>:3128`. The
  front listener on 3128 requires that credential as `Proxy-Authorization:
  Basic` (sent by curl, Python's httpx, requests and aiohttp, and Node's
  `NODE_USE_ENV_PROXY`), checks the token against its SHA-256 (the control
  plane keeps no copy of the token), checks that the connection comes from
  the route's agent guest address, strips the credential and hands the
  connection to the route's iron-proxy. Anything else gets `407` and a line
  in the proxy guest's refusal log.
- its bind agent installs the **proxy** lock before the runtime starts: the
  runtime user may reach its own port on loopback and the proxy guest's
  front (address and port), nothing else. A warm guest is locked when its
  launcher starts at fill, to the tenant's proxy guest, and a claim checks
  that the lock still names it.
- its CA certificate travels in the runtime bundle (or in the go body); the
  key does not.

Tenant refusal: every guest of the test target shares `vmbr0`, so tenant
separation is enforced at the application layer. An agent of tenant B never
gets a route in tenant A's proxy guest, its lock does not admit A's address,
and A's front refuses B's credential, a forged token, no credential, and
A's own credential from any other address. Handles stay tenant-scoped (an
agent of B cannot name `A/...`). With `tenant_vlans` set, the proxy guest
gets a second NIC on the tenant's VLAN (`net1`, no gateway), agents are
locked to that address and agent guests attach only to that VLAN; this path
is built but not yet exercised live.

Secret delivery: secrets reach the proxy guest only in the route request,
over the supervisor's control API (bearer token, held only by the control
plane), at apply time, the same late binding as a warm runtime's go. A
rotation sends only the new values (`POST /routes/<route>/secrets`); the
route's iron-proxy re-reads its files on `POST /v1/reload`. The audit log is
fetched from the proxy guest into `<state-root>/<agent>/logs/egress-audit.jsonl`
(per route in `egress-audit.d/`) before a generation is retired or destroyed
and when logs are read.

Restarts: pve-node-a restarts every new container about three minutes after its
first start (an outside mechanism installs Tailscale). A restart empties
tmpfs: the binding, the supervisor and every route. The supervisor's boot id
changes, so the next `proxy up` or apply provisions the guest again (same
VMID, same address). Routes are not re-sent: agents whose routes were lost
fail closed (`407`, `status` shows the route dead) until they are applied
again. Secrets are never kept anywhere to re-send them.

The Linux iron-proxy: the pinned upstream release
`iron-proxy_0.52.0_linux_amd64.tar.gz`, downloaded and checked by
`scripts/e2e-tools.sh` (it prints `IRON_PROXY_LINUX_BIN`). The control plane
reads it from `BIMO_IRON_PROXY_GUEST_BIN` (default
`target/e2e-tools/iron-proxy-0.52.0-linux_amd64/iron-proxy`), refuses any
file whose SHA-256 is not the pinned build, and delivers it in the proxy
guest's bundle. This was the simplest dependable choice: no cross build, no
template change, one binary for every proxy guest.

Proof: `tests/e2e_proxmox_agents.rs` (live, `BIMO_PROXMOX_LIVE=1`)
starts proxy guests for two tenants, waits past the restart window, applies
eve and Hermes for tenant A and Hermes for tenant B, asks each for an answer,
checks the audit log for the swap, searches the agent guest's state and
every process's environment for the real value, probes the runtime user's
egress (only the proxy front connects), checks the cross-tenant refusals
above, destroys everything and checks that the pool on the cluster holds only
the template. It needs a template whose bind agent speaks API 3
(`templates/README.md`).
