# Bimo host Worker

The substrate behind a `cloudflare` target. One host per Cloudflare account
and environment. The engine's driver (`src/cloudflare/mod.rs`) is its only
client. Each `workerd` agent generation runs here as a Dynamic Worker whose
outbound requests all pass through the credential gateway. The boundary is
described in `docs/credential-boundary.md` ("On Cloudflare"), and the plan
and failure list are in `docs/plans/2026-10-10-cloudflare-substrate.md`.

| File | Role |
|---|---|
| `src/index.ts` | Control API (`/v1/`, operator token) and agent traffic (`/a/<agent>/g<n>/`) |
| `src/gateway.ts` | The credential gateway: allowlist, placeholder swap, no redirects, no TCP, audit |
| `src/vault.ts` | `TenantVault` Durable Object: routes with sealed values, audit lines |
| `src/agents.ts` | `AgentStore` Durable Object: which tenant owns a name, each generation's code |
| `src/crypto.ts` | AES-256-GCM sealing under `BIMO_VAULT_KEK`, constant-time token check |

## Requirements

- Workers Paid plan. Dynamic Workers (`worker_loaders`) are in open beta.
  On the Free plan, `wrangler deploy` fails with API error 10195.
- Two secrets, never in `wrangler.jsonc`:
  - `BIMO_OPERATOR_TOKEN`: the bearer token the engine sends. Put the same
    value in the variable named by the target's `token_env`.
  - `BIMO_VAULT_KEK`: 32 random bytes, base64 (`openssl rand -base64 32`).
    It seals every secret value. If you lose it, every stored route becomes
    unreadable: re-apply the agents. If you change it, do the same.

## Local

```sh
npm ci
printf 'BIMO_OPERATOR_TOKEN=%s\nBIMO_VAULT_KEK=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -base64 32)" > .dev.vars
npx wrangler dev --port 8787
```

The target is then `url = "http://127.0.0.1:8787"`. The engine's E2E suite
starts its own host with fresh secrets:

```sh
BIMO_CLOUDFLARE_E2E=local cargo test --test e2e_cloudflare
```

## Deploy

```sh
npx wrangler secret put BIMO_OPERATOR_TOKEN
npx wrangler secret put BIMO_VAULT_KEK
npx wrangler deploy
```

Then declare the target (`examples/targets.toml`):

```toml
[[targets]]
kind = "cloudflare"
name = "cf"
url = "https://bimo-host.<account>.workers.dev"
token_env = "BIMO_CLOUDFLARE_TOKEN"
```

## Control API

All routes under `/v1/` need `Authorization: Bearer <BIMO_OPERATOR_TOKEN>`.
No response contains a secret value.

| Method and path | Does |
|---|---|
| `PUT /v1/agents/<agent>/generations/<n>` | Store the route first, then the generation. Returns `409 tenant_conflict` if another tenant owns the name. |
| `GET /v1/agents/<agent>/generations/<n>[?tenant=<t>]` | The generation's tenant, route and code hash. |
| `DELETE /v1/agents/<agent>/generations/<n>?tenant=<t>` | Remove the generation and its route. Only the owner can do this. |
| `GET /v1/tenants/<t>/routes/<route>` | The route without values. |
| `DELETE /v1/tenants/<t>/routes/<route>` | Remove a route left without a generation. |
| `POST /v1/tenants/<t>/routes/<route>/secrets` | Rotate: `{"secrets": [{"env", "value"}]}`. Takes effect on the next request. |
| `GET /v1/tenants/<t>/routes/<route>/audit` | The audit lines, as NDJSON. |
