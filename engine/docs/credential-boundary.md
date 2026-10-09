# Credential boundary

An agent never holds a real credential (R7). Its outbound traffic is denied by
default, allowed per agent by the spec's `egress.allow`, and every request is
recorded (R8). Monolith gets both from one iron-proxy instance per agent
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
`monolith agent logs <name> --stream egress`. Lines with `"msg":"request"`
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

Stage 1 (U7, minimal): the agent's iron-proxy runs on the control-plane
host, exactly as on `local`, listening on loopback only. It never runs in a
guest, so the CA key, the secret files and the real values never enter one.
The runtime runs inside its guest (U8, `src/proxmox/delivery.rs`) and gets
the same table as above, with two differences:

- its proxy variables point at `http://127.0.0.1:7071` inside the guest, a
  listener the bind agent opens; each connection to it is carried to the
  proxy by the egress relay (`src/relay.rs`, resource `relay_process`), over
  connections the relay opens to the bind agent with the per-guest
  credential (`GET /tunnel`). The proxy is never exposed on the network.
- its CA certificate travels in the runtime bundle
  (`/srv/monolith/runtime/trust/monolith-agent-ca.pem`); the key does not.

What crosses into the guest: the bind payload (identity only), the bundle
(the built runtime, its config source and the CA certificate) and the start
request (program, arguments, the runtime's environment with placeholders and
the control key, ports). None carries a real secret.

Confinement in the guest: the runtime runs as the unprivileged user
`monolith-agent`, under the bind agent's unit (`ProtectSystem=strict`, private
`/tmp`; it can write only its runtime directory). An nftables rule the bind
agent installs before it starts the runtime rejects every packet that user
sends except to the loopback egress port and its own port, so a client that
ignores the proxy variables fails instead of leaking. If the rule cannot be
installed the runtime is not started.

Proof: `tests/e2e_proxmox_agents.rs` (live, `MONOLITH_PROXMOX_LIVE=1`)
applies the eve and Hermes examples to the proxmox target, asks each for an
answer through its runtime, checks the proxy's audit log for the swap,
downloads the guest's state and every process's environment (`GET /inspect`)
and searches it for the real value, and checks that a direct connection from
the runtime user is refused.

Not yet: KTD4's always-on per-tenant proxy guest and KTD5's per-tenant
segments. Until the segments are provisioned, guests share `vmbr0`, so the
runtime's API port and an unbound pooled guest's bind port are reachable from
that segment (both authenticated, the first bind trust-on-first-use), and the
control-plane host must stay up for its agents' egress.
