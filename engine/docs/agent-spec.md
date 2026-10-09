# Agent spec

An agent spec is a TOML file that declares one agent: what runs, from which
source, for which tenant, which secrets it may use, where it may connect, and
on which substrate it is placed. The same format deploys every runtime
Monolith supports (today Hermes and eve). Substrate settings never appear in
a spec; they belong to the named target in `.monolith/targets.toml`.

Examples: `examples/hermes-agent.toml` and `examples/eve-agent.toml`.

```toml
schema_version = 1
name = "demo-hermes"
tenant_id = "demo"
runtime = "hermes"

[source]
kind = "config"
path = "hermes-agent"

[[secrets]]
env = "OPENROUTER_API_KEY"
handle = "demo/openrouter"
hosts = ["openrouter.ai"]

[egress]
allow = ["openrouter.ai"]

[placement]
substrate = "local"
```

## Fields

Unknown fields are errors (KTD9). The spec is versioned by `schema_version`.

| Field | Required | Rule |
|---|---|---|
| `schema_version` | yes | `1`. |
| `name` | yes | 1 to 63 lowercase letters, digits or `-`, not starting or ending with `-`. Agents are addressed by name. |
| `tenant_id` | yes | Same shape as `name`. A name belongs to one tenant: applying the same name for another tenant fails with `tenant_conflict`. |
| `runtime` | yes | A registered runtime: `hermes` or `eve`. |
| `source` | yes | Where the runtime's code or configuration comes from (below). |
| `secrets` | no | Secret references (below). |
| `egress.allow` | yes | Hosts the agent may reach: `example.com`, `*.example.com` (subdomains only, not the apex) or an IPv4 address. Enforced by the agent's credential proxy; anything else is refused and recorded (`docs/credential-boundary.md`). |
| `placement.substrate` | yes | The name of a target: `local`, or a named target from the targets file. Nothing else is allowed in `placement`. |

### Source

Each runtime accepts the source kinds it can launch from.

| Kind | Fields | Runtime | Meaning |
|---|---|---|---|
| `config` | `path` | hermes | A directory, relative to the spec, copied privately per generation. For Hermes it becomes `HERMES_HOME` (`config.yaml`, `SOUL.md`, skills). Symlinks are rejected. |
| `git` | `repo`, `rev` | eve | A repository at a full 40-character commit id, so the source is immutable. `repo` is a URL, or a path relative to the spec. |

### Secrets

```toml
[[secrets]]
env = "OPENROUTER_API_KEY"     # variable the runtime reads
handle = "demo/openrouter"     # <tenant>/<name>
hosts = ["openrouter.ai"]      # where the real value may be sent
```

- The agent never receives the real value. It gets a placeholder in `env`
  whose shape keeps the runtime in the auth mode a real key would select; the
  per-agent credential proxy substitutes the real value on requests to
  `hosts` only. See `docs/credential-boundary.md`.
- `handle` must name the spec's own tenant. A handle from another tenant is
  rejected before anything runs.
- Every entry in `hosts` must be allowed by `egress.allow`.
- Each `env` may appear once.
- Every handle must resolve in the target's secret source at validate, plan
  and apply time. Sources are configured per target:
  - `env` (default): `MONOLITH_SECRET_<TENANT>__<NAME>` in the control plane's
    environment, with non-alphanumerics mapped to `_`. Example:
    `demo/openrouter` reads `MONOLITH_SECRET_DEMO__OPENROUTER`.
  - `onepassword_connect`: a 1Password Connect server. Each tenant has its own
    vault named `vault_prefix` + tenant (default `monolith-<tenant>`); the item
    title is the handle name and its password field is the value.

    ```toml
    [[targets]]
    kind = "proxmox"
    name = "lab"
    # ...
    [targets.secret_source]
    kind = "onepassword_connect"
    url = "https://op-connect.internal:8080"
    token_env = "OP_CONNECT_TOKEN"
    ```

### Placement

`placement.substrate` names a target and nothing else. Substrate-specific
fields (`node`, `vmid`, `guest_id`, `guest_type`, `template`, `storage`,
`pool`, `cluster`, `api_url`, `bridge`, `vlan`, `address`, `ip`, `image`,
`cores`, `memory` and similar) are rejected with a message naming the field,
whether they appear inside `placement` or at the top level. Put them in the
target config.

### Guest classes

On a guest substrate the runtime adapter describes how its runtime runs in a
guest (`RuntimeAdapter::guest`, `src/runtimes/mod.rs`): the files to bundle,
the program and environment, the port, the memory it needs, and the guest
class it needs. The driver picks how to acquire a guest from the class;
delivery into it (bundle upload and start through the bind agent, egress
locked to the agent's route in its tenant's proxy guest) is the same for
every class.

| Class | Acquired | Agents per guest | Status |
|---|---|---|---|
| `pooled_container` | an LXC clone of the golden template, from the tenant's warm pool | one | built (eve, Hermes) |
| `platform_vm` | a VM created on demand, never pooled | many: one platform deployment hosts many agents | reserved, no driver |

`platform_vm` is the seam for a heavy multiplayer runtime (for example a
k3s-based multi-agent platform). Such a runtime would add an adapter whose
`guest` returns `platform_vm`, and a driver path that creates the VM once per
deployment and places further agents into the running platform instead of
claiming a guest per agent. Nothing in delivery or the proxy guest changes. Asking for it today fails with `runtime_unavailable`.

## Validation

`monolith agent validate <spec>` checks everything above without touching a
substrate and reports every problem at once:

```text
error [spec_invalid]: spec 'bad.toml' has 3 problem(s): ...
  vmid: substrate-specific field 'vmid' is not allowed outside placement; ...
  tenant_id: required
  secrets[0].hosts: host 'api.openai.com' is not in egress.allow; ...
```

With `--output json` the problems are in `error.details` as
`{"field", "message"}` objects. See `docs/agent-cli.md`.

## Fingerprint and change detection

The fingerprint is SHA-256 over the normalized spec and, for `config`
sources, the content of every file in the source directory. Apply compares it
with the running agent's fingerprint: equal and alive means nothing to do
(`changed: false`); different means a new generation replaces the old one; a
`git` source changes only when `repo` or `rev` changes.
