# Operator deployment manifests: preview version 1

`bimo plan FILE [--json]` validates deployment intent offline. This contract
is experimental. Only a manifest whose target kind is `engine` can run, through
`bimo agent apply FILE` and the [Bimo engine](engine.md); `plan` itself never
deploys or adopts resources. It is separate from
workflow manifests and organizer-generated plans: only an operator supplies
deployment identity, placement, credentials and budgets.

## Exact schema

All fields are required. Unknown fields fail closed at every object boundary.
The packaged JSON examples are the complete reference shape.

| Field | Accepted values |
| --- | --- |
| schemaVersion | Integer 1 |
| clientId, agentId | 1–32 lowercase letters, digits and dashes; starts with a letter |
| lifecycle | job or service |
| runtime | opencode or pi for jobs; hermes for services |
| target | `{kind:"local"}`, `{kind:"ssh",host:"operator@host"}`, `{kind:"proxmox-lxc",proxmox:"operator@host",vmid:"100"}`, or `{kind:"engine",name:"local"}` (a Bimo engine target name) |
| workload | Jobs: `{template:"react-solo"}`, `{template:"react-app"}` or `{template:"parallel-engineering-pod"}`; services: `{service:"aurum"}`; engine Hermes services: `{config:"DIR"}`, a Hermes configuration directory relative to the manifest |
| model | `{provider:"openrouter",fallback:"disabled"}` or `{provider:"local",fallback:"disabled"}`; engine targets accept OpenRouter only |
| secretRefs | `{model:"op://VAULT/ITEM/FIELD"}` for OpenRouter; `{model:null}` for local inference; engine targets: `{model:"TENANT/NAME"}`, a handle the engine resolves from its target's secret source |
| limits | memoryMiB: integer 128–65536; cpus: finite number 0.25–64; maxConcurrentRuns: integer 1–8; runTimeoutSeconds: integer 1–7200 |

Host and VM identifiers follow the existing deployment target restrictions.
No filesystem check occurs for local target validation. Runtime and target
names describe requested intent; they do not extend the executable registries.
The local provider's null reference is a placeholder policy, not a claim that
future local endpoints cannot require authentication.

These bounds reject malformed or unreasonable declarations. They do not
certify a workload's hardware fit. maxConcurrentRuns means requested simultaneous
runs for this agent, not the number of workers inside an engineering pod.
runTimeoutSeconds bounds a requested job or service request, not the lifetime
of a persistent gateway. Aggregate host admission and service request handling
must enforce these policies before they become operational.

An `engine` target runs Hermes services only, and `bimo plan` does not read the
engine's targets file: the target name, the secret handle and the
configuration directory are checked by `bimo agent validate FILE`. See
[the engine bridge](engine.md#from-a-deployment-manifest-to-an-engine-agent).

## Receipt and errors

Success emits exactly schemaVersion, planOnly, executionSupported, identity,
manifest, limitations, and sourceDigest. identity is the unambiguous pair
`clientId/agentId`; it is not converted to a deployment path. sourceDigest
hashes the bytes read, including whitespace, and does not establish signature,
authorization, installation status, or template/image identity.

The normalized manifest and receipt are immutable in the module API. The CLI
does not resolve credential references; their identifiers appear in JSON
output, but credential values must never appear in an input manifest.
Malformed JSON errors omit parser excerpts to avoid echoing input contents.
With --json, failures produce one existing Bimo error envelope and nonzero exit.
A valid plan exits zero even when execution is unsupported, because the command
certifies only the intent schema. Automation must inspect executionSupported
and must not treat exit zero as permission to deploy. executionSupported is
true only for engine targets.

The reader accepts a regular non-symlink file, at most 64 KiB, with a two-second
read deadline and capped allocation. It rejects directories, named pipes,
device files, invalid UTF-8, and unknown command flags. The command never
resolves secrets, probes targets, executes workloads, writes state, or adopts
existing Aurum infrastructure.

## Deliberately deferred operational fields

Repository and revision bindings, approved tool sets, artifact pinning,
conversation identity, authenticated channel bindings, local inference endpoint
configuration, storage ownership and restart policy require executor-specific
validation. They are not silently accepted as arbitrary JSON or commands.
An execution contract must add and enforce them before deployment is enabled.
