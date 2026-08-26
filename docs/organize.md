# Organize an assignment

`organize` is a read-only planning step. It gives one assignment to one or
more independent selectors, each of which sees the same original assignment
and the same exact installed catalog. Selectors may choose only one
digest-bound catalog template and must return this exact receipt shape:

```json
{"version":1,"template":"...","templateDigest":"...","reason":"..."}
```

The digest is part of the selection: a name without its matching digest is not
a valid receipt. Selector output is not execution authority and cannot add
operational handoff fields. The `reason` value remains untrusted agent text; it
is displayed for context but never executed or reused as deployment input.

Use one selector for the smallest, deterministic path:

```sh
bimo organize -p "Build a small React app that displays a task list." -n 1 --deployment organize-demo --proxmox pve-05 --vmid 113 --secret-ref op://VAULT/ITEM/FIELD --json
```

The root shorthand accepts the same prompt without the subcommand:

```sh
bimo -p "Build a small React app that displays a task list." -n 1 --deployment organize-demo --proxmox pve-05 --vmid 113 --secret-ref op://VAULT/ITEM/FIELD --json
```

These values show the complete command shape. Replace the `op://` placeholder
with an authorized OpenRouter secret reference, and substitute the deployment
name, target, or VM ID when using another environment. Keep these operational
values in the command boundary only: they are never fields in the selector
receipt.

Voting is deterministic. With `-n 1`, the one valid receipt wins. With `-n 2`,
both valid receipts must select the same digest-bound template; disagreement is
a failure. With `-n 3`, the majority of valid receipts wins; a tie or no
majority is a failure. Any invalid receipt fails the run before selection, and
every receipt must use a catalog name paired with its installed digest.

The planned handoff is safe and narrow: it contains the selected template name,
selected template digest, and accepted deploy-option names. The plan binds the
unchanged assignment by SHA-256 and keeps every organizer reason in `votes`.
Reuse the original prompt as the later deploy task; do not substitute an
agent-rewritten task. That execution step must revalidate the digest against
its local catalog before doing work. `deploy` remains a separate, explicit
command and continues to be the authority for deployment; organizing never
deploys.
