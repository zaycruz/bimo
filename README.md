# Monolith

Deploy a predefined agent workflow as one container.

```text
engineering -> qa -> testing -> done
      ^          |       |
      +----------+-------+
          on failure
```

No message bus, distributed scheduler, or generic graph engine. One runner
reads one workflow file, invokes the active role, saves one state file, and
follows the declared transition.

## Try it

```bash
npm test
MONOLITH_AGENT_COMMAND_JSON='["node","test/fixture-agent.mjs"]' \
  ./bin/monolith run workflows/engineering-loop.json --task "demo"
```

The default runtime invokes Claude Code. Each role finishes with exactly one
declared marker such as `MONOLITH_RESULT=passed` or
`MONOLITH_RESULT=failed`.

## Deploy

```bash
./bin/monolith deploy workflows/engineering-loop.json \
  --host root@your-docker-host \
  --fixture \
  --task "Build the requested change"
```

For a Docker-enabled Proxmox LXC:

```bash
./bin/monolith deploy workflows/engineering-loop.json \
  --proxmox root@pve-host --vmid 113 \
  --fixture \
  --task "Build the requested change"
```

Remote deploys currently require `--fixture`, which proves the packaged state
machine without sending credentials to the target. Authenticated Claude runs
use `monolith run` on a machine where Claude Code is already signed in. The
runner stores its only durable state at `/opt/monolith/state/run.json` on the
target.

[`workflows/engineering-loop.json`](workflows/engineering-loop.json) is the
entire control plane: role prompts, states, transitions, and a round limit.
