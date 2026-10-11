# Cloudflare substrate, slice 1: Dynamic Workers behind a Bimo gateway

Status: in progress. Decided by the operator on
2026-10-10:

- The first Cloudflare build runs agents as **Dynamic Workers**. Every
  outbound request they make goes through a **Bimo gateway**.
- Tenant secrets live in an **encrypted per-tenant vault** on Cloudflare.
- Containers for eve and Hermes come later.

## Goal

`bimo agent apply agent.toml` with `placement.substrate` naming a
`cloudflare` target places a Worker agent on Cloudflare. It keeps the same
credential boundary as the local and Proxmox substrates:

- the agent holds placeholders only;
- the egress allowlist is enforced;
- a placeholder is swapped in request headers only on that secret's hosts;
- one audit line is written per request;
- rotation is live, with no restart;
- `destroy` is idempotent.

Readiness keeps its meaning: the agent accepted a first task (KTD7).

## Shape

```
bimo (Rust, operator host)            Cloudflare: one "bimo host" Worker per account/environment
--------------------------            -------------------------------------------------------
CloudflareDriver ──HTTPS + operator──▶ control API  /v1/...
  create / alive / destroy            │   AgentStore DO (one per agent): generation record, modules, egress, secret map (placeholders + hosts)
  rotate_secrets / collect_audit      │   TenantVault DO (one per tenant): secret values AES-GCM encrypted under a KEK
                                      │                                   (Worker secret), audit lines per route
probe (agent task API) ──────────────▶ /a/<agent>/g<gen>/*  ── env.LOADER.get(...) ──▶ Dynamic Worker (the agent)
                                                                                         │ every fetch()/connect()
                                                                                         ▼
                                                                   globalOutbound = Gateway({tenant, agent, gen})
                                                                   allowlist → swap placeholders on the secret's hosts → fetch → audit
```

- **Runtime `workerd`** (a new adapter in `src/runtimes/workerd.rs`):
  - The agent is a set of prebuilt ES modules, from a `config` source directory or a `git` source.
  - Its default export serves the task API, with the same contract shape as the other runtimes:
    - `POST /bimo/v1/tasks` with `Authorization: Bearer <control key>` answers 202 `{"task_id"}`;
    - an unauthenticated request is refused (`state_check`).
  - It reads its control key and its placeholders from `env`.
  - It has no local launch; it runs on a `cloudflare` target only.
- **Target `kind = "cloudflare"`:** `url` (the host Worker), `token_env` (the operator bearer), `secret_source`.
- **Driver (`src/cloudflare/mod.rs`):**
  - `proxy_placement()` is Remote, so secret values stay in memory on the operator host and are sent once, at create or rotate.
  - Resources:
    - `ResourceKind::Worker`, id `cf:<agent>:g<gen>`;
    - `ResourceKind::ProxyRoute`, id `cf:<agent>:g<gen>:route`.
  - Neither resource needs a new field.
- **The gateway** ports iron-proxy's rules as rendered in `src/proxy/config.rs`:
  - The allowlist is a host match: `*.x` matches subdomains only, and IPv4 literals must match exactly.
  - Secrets are swapped in any header, on the secret's hosts only.
  - A placeholder sent anywhere else is forwarded unchanged.
  - A refusal is a 403 with `rejected_by: "allowlist"`.
  - Audit lines use the same JSON shape (`msg`, `audit.{host,method,path,action,status_code}`, `annotations.swapped`). Values are never logged.
  - `connect()` (raw TCP) is refused.
- **Local first.** `wrangler dev` runs the host Worker in workerd, the same runtime Cloudflare runs. A `cloudflare` target with `url = "http://127.0.0.1:<port>"` exercises the whole path on this machine. Live mode deploys the same Worker with `wrangler deploy` and needs the operator's go-ahead.

## Failure list (written before the code)

The E2E suite (`tests/e2e_cloudflare.rs`, `BIMO_CLOUDFLARE_E2E=local|live`) must show none of these happen. It writes a repeatable JSON report (`.bimo/reports/<time>-cloudflare-<pid>.json`).

| # | Failure | How the suite catches it |
|---|---|---|
| F1 | Apply reports ready before the agent accepted a task, or never reports ready | Apply's result has `ready_ms`, and the test agent's task log shows the probe task |
| F2 | A real secret value is visible to the agent (env, or any response from the host) | The test agent's `/env` dump (behind the control key) and every control API response are checked for the value |
| F3 | A placeholder is not swapped on a secret's own host | The echo upstream receives the real value |
| F4 | A placeholder is swapped on an allowed host that is not the secret's host | The echo on the second host receives the placeholder unchanged |
| F5 | A request to a host outside the allowlist goes out | The response is 403; the audit line has `rejected_by: allowlist`; the echo never saw it |
| F6 | `connect()` (raw TCP) reaches the network | The agent's connect attempt fails |
| F7 | Tenant B's agent gets tenant A's secret | B sends A's placeholder to A's secret host, and the echo sees the placeholder unchanged |
| F8 | Rotation needs a restart or is not applied | Re-apply with a new value keeps the same generation and endpoint; the echo sees the new value |
| F9 | A request has no audit line, or an audit line contains a value | `bimo agent logs --stream egress` has one line per request and no line contains a real value |
| F10 | `destroy` fails the second time, or leaves the agent or its route behind | Destroy runs twice; afterwards the endpoint answers 404 and the vault route is gone |
| F11 | The control API accepts a missing or wrong operator token | Both get 401, compared in constant time |
| F12 | Secret values are stored unencrypted on Cloudflare | Local mode scans workerd's persisted Durable Object files for the value's bytes |
| F13 | The control host writes a secret value to disk | The generation directory and record are scanned for the value |
| F14 | The agent's task API answers without the control key | The adapter's `state_check` fails apply |
| F15 | A new generation leaves the old one reachable | After a source change, the old generation's endpoint answers 404 |
| F16 | `status` reports ready for a destroyed agent, or degraded for a live one | Status is checked after apply and after destroy |
| F17 | The gateway follows a redirect to a host outside the allowlist, or carries a swapped secret across it | An allowed echo answers 302 to a disallowed host; the agent receives the 302 itself, and nothing reaches the disallowed host |
| F18 | One tenant's agent name is reused by another tenant, so it takes over that agent | A second apply with the same name and a different tenant gets 409 |

## Out of scope for slice 1

- Agents SDK agents: Durable Object classes inside a Dynamic Worker.
- Workers AI and other bindings granted to the agent.
- Agent console log collection.
- A `bimo cloudflare up` wrapper; deploy with `wrangler deploy` from `cloudflare/host/`.
- A warm pool: Dynamic Workers start in milliseconds, so none is needed.

## Risks

- Dynamic Workers are in open beta and need the Workers Paid plan.
- The gateway reimplements iron-proxy's rules, so F3 to F7 are its parity tests.
- Durable Object values are limited in size, so slice 1 caps an agent's modules at 1 MiB in total.

## Progress

- 2026-10-10, slice 1 local: driver, `workerd` runtime, host Worker and
  `tests/e2e_cloudflare.rs` are in. With `BIMO_CLOUDFLARE_E2E=local`, all 40
  checks covering F1 to F18 pass. The first run caught a real F18 defect: a
  refused takeover's rollback deleted the owner's generation by name. Worker
  resources and host deletes are now scoped to the tenant.
- Live mode is wired: `BIMO_CLOUDFLARE_E2E=live` with `BIMO_CLOUDFLARE_URL`
  and `BIMO_CLOUDFLARE_TOKEN`. Public echo services stand in for the
  upstreams. F12 and the never-arrived checks are local only.
- 2026-10-10, first live deploy: blocked. The account is on the Workers Free
  plan and Dynamic Workers need Paid (API error 10195). Nothing was created.
