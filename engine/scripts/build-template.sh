#!/bin/sh
# Build the Bimo engine golden LXC template (U6). Run ON THE PROXMOX NODE as
# root, by an operator. The engine never runs this and never SSHes to a node;
# the driver only clones the finished template through the API.
#
#   scp -r scripts/build-template.sh templates/bind-agent root@<node>:/root/monolith-template/
#   ssh root@<node> 'sh /root/monolith-template/build-template.sh'
#
# What it does, in order:
#   1. creates CT $VMID from $OSTEMPLATE (or reuses an existing, non-template
#      CT $VMID), unprivileged, on $STORAGE, in $POOL, parked at $PARK_IP;
#   2. starts it and waits until systemd reports the boot finished (nothing
#      is stopped or templated while first boot is still running);
#   3. installs python3, nftables, the bind agent and its unit; removes
#      services the agent guest does not need (ssh, postfix) so clones boot
#      fast;
#   3b. bakes the runtimes (U8): Node $NODE_VERSION (sha256-pinned, node binary
#      only) in /opt/monolith/node for eve bundles, hermes-agent
#      $HERMES_VERSION in a venv at /opt/monolith/hermes, and the unprivileged
#      runtime user monolith-agent with /srv/monolith. Baked, not fetched at
#      bind time, so a claim never waits on a download (templates/README.md);
#   4. writes /etc/monolith/template-version, empties machine-id so each
#      clone gets its own, cleans apt caches;
#   5. shuts it down cleanly and converts it with 'pct template'.
#
# Settings (environment). PARK_IP and GATEWAY have no default: pass the
# parking address and gateway of your template network, for example
# PARK_IP=192.0.2.239/25 GATEWAY=192.0.2.129.
set -eu
VMID=${VMID:-9000}
OSTEMPLATE=${OSTEMPLATE:-local:vztmpl/debian-13-standard_13.6-1_amd64.tar.zst}
STORAGE=${STORAGE:-local-lvm}
DISK_GB=${DISK_GB:-6}
POOL=${POOL:-pool-monolith-test}
BRIDGE=${BRIDGE:-vmbr0}
PARK_IP=${PARK_IP:?set PARK_IP to the template parking address, for example 192.0.2.239/25}
GATEWAY=${GATEWAY:?set GATEWAY to the template network gateway, for example 192.0.2.129}
MEMORY_MB=${MEMORY_MB:-256}
BIND_PORT=${BIND_PORT:-7070}
# Build-time memory: pip and the Node unpack need more than a guest's 256 MB.
BUILD_MEMORY_MB=${BUILD_MEMORY_MB:-1024}
TEMPLATE_VERSION=${TEMPLATE_VERSION:-debian13-bind-v4}
NODE_VERSION=${NODE_VERSION:-24.21.0}
NODE_SHA256=${NODE_SHA256:-6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff}
HERMES_VERSION=${HERMES_VERSION:-0.15.2}
# The gateway's API server (the task API Monolith probes) needs aiohttp,
# which hermes-agent only pulls in through its messaging extras.
HERMES_AIOHTTP_VERSION=${HERMES_AIOHTTP_VERSION:-3.13.3}
RUNTIME_UID=${RUNTIME_UID:-4990}
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
AGENT_DIR=${AGENT_DIR:-$HERE/bind-agent}
[ -f "$AGENT_DIR/monolith-bind-agent.py" ] || AGENT_DIR=$HERE/../templates/bind-agent

say() { printf '== %s\n' "$*"; }
die() { printf 'build-template: %s\n' "$*" >&2; exit 1; }

command -v pct >/dev/null || die "pct not found; run this on a Proxmox node"
[ -f "$AGENT_DIR/monolith-bind-agent.py" ] || die "bind agent not found in $AGENT_DIR"
[ -f "$AGENT_DIR/monolith-bind-agent.service" ] || die "bind agent unit not found in $AGENT_DIR"

if pct config "$VMID" >/dev/null 2>&1; then
    if pct config "$VMID" | grep -q '^template: 1'; then
        die "CT $VMID is already a template. Destroy it (pct destroy $VMID) and rerun to rebuild; pooled guests from the old template are retired by the next 'monolith pool fill'."
    fi
    say "reusing existing CT $VMID"
else
    say "creating CT $VMID from $OSTEMPLATE"
    pct create "$VMID" "$OSTEMPLATE" \
        --hostname monolith-template \
        --unprivileged 1 \
        --features nesting=1 \
        --ostype debian \
        --cores 1 \
        --memory "$MEMORY_MB" \
        --swap 0 \
        --rootfs "$STORAGE:$DISK_GB" \
        --net0 "name=eth0,bridge=$BRIDGE,ip=$PARK_IP,gw=$GATEWAY" \
        --pool "$POOL" \
        --onboot 0
fi

pct set "$VMID" --memory "$BUILD_MEMORY_MB"
if ! pct status "$VMID" | grep -q running; then
    say "starting CT $VMID"
    pct start "$VMID"
fi

say "waiting for first boot to finish"
i=0
until pct exec "$VMID" -- systemctl is-system-running --wait >/dev/null 2>&1; do
    state=$(pct exec "$VMID" -- systemctl is-system-running 2>/dev/null || true)
    [ "$state" = "degraded" ] && break
    i=$((i + 1))
    [ "$i" -gt 120 ] && die "CT $VMID did not finish booting (state: $state)"
    sleep 1
done

say "installing python3, nftables and removing services the agent guest does not need"
pct exec "$VMID" -- sh -eu -c '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -q
    apt-get install -y -q --no-install-recommends python3 python3-venv nftables ca-certificates
    apt-get purge -y -q openssh-server postfix 2>/dev/null || true
    apt-get autoremove -y -q
    apt-get clean
    rm -rf /var/lib/apt/lists/*
'

say "creating the runtime user and /srv/monolith"
pct exec "$VMID" -- sh -eu -c "
    getent group monolith-agent >/dev/null || groupadd --system --gid $RUNTIME_UID monolith-agent
    id monolith-agent >/dev/null 2>&1 || useradd --system --uid $RUNTIME_UID --gid monolith-agent \
        --home-dir /srv/monolith/runtime --no-create-home --shell /usr/sbin/nologin monolith-agent
    mkdir -p /srv/monolith /opt/monolith
    chmod 0755 /srv/monolith /opt/monolith
"

say "baking Node $NODE_VERSION (eve) into /opt/monolith/node"
NODE_FETCH=$(mktemp)
cat >"$NODE_FETCH" <<'PY'
import hashlib, os, shutil, subprocess, sys, tempfile, urllib.request
version, want = sys.argv[1], sys.argv[2]
url = "https://nodejs.org/dist/v%s/node-v%s-linux-x64.tar.gz" % (version, version)
tmp = tempfile.mkdtemp()
archive = os.path.join(tmp, "node.tar.gz")
with urllib.request.urlopen(url, timeout=120) as response, open(archive, "wb") as out:
    shutil.copyfileobj(response, out)
got = hashlib.sha256(open(archive, "rb").read()).hexdigest()
if got != want:
    sys.exit("node checksum mismatch: got %s, want %s" % (got, want))
subprocess.run(["tar", "-xzf", archive, "-C", tmp], check=True)
src = os.path.join(tmp, "node-v%s-linux-x64" % version)
shutil.rmtree("/opt/monolith/node", ignore_errors=True)
os.makedirs("/opt/monolith/node/bin")
# Only the node binary: eve bundles are self-contained and need no npm.
shutil.copy2(os.path.join(src, "bin", "node"), "/opt/monolith/node/bin/node")
shutil.copy2(os.path.join(src, "LICENSE"), "/opt/monolith/node/LICENSE")
shutil.rmtree(tmp)
PY
pct push "$VMID" "$NODE_FETCH" /root/monolith-node-fetch.py --perms 0644
rm -f "$NODE_FETCH"
pct exec "$VMID" -- python3 /root/monolith-node-fetch.py "$NODE_VERSION" "$NODE_SHA256"
pct exec "$VMID" -- rm -f /root/monolith-node-fetch.py
pct exec "$VMID" -- /opt/monolith/node/bin/node --version

say "baking hermes-agent $HERMES_VERSION into /opt/monolith/hermes"
pct exec "$VMID" -- sh -eu -c "
    rm -rf /opt/monolith/hermes
    python3 -m venv /opt/monolith/hermes
    /opt/monolith/hermes/bin/pip install --quiet --no-cache-dir 'hermes-agent==$HERMES_VERSION' 'aiohttp==$HERMES_AIOHTTP_VERSION'
    test -x /opt/monolith/hermes/bin/hermes
"
pct exec "$VMID" -- /opt/monolith/hermes/bin/python -c "import importlib.metadata as m; import aiohttp; print('hermes-agent', m.version('hermes-agent'), 'aiohttp', aiohttp.__version__)"

say "installing the bind agent"
pct exec "$VMID" -- mkdir -p /usr/local/lib/monolith /etc/monolith
pct push "$VMID" "$AGENT_DIR/monolith-bind-agent.py" /usr/local/lib/monolith/monolith-bind-agent.py --perms 0755
pct push "$VMID" "$AGENT_DIR/monolith-bind-agent.service" /etc/systemd/system/monolith-bind-agent.service --perms 0644
pct exec "$VMID" -- sh -eu -c "
    sed -i 's/^Environment=MONOLITH_BIND_PORT=.*/Environment=MONOLITH_BIND_PORT=$BIND_PORT/' /etc/systemd/system/monolith-bind-agent.service
    printf '%s\n' '$TEMPLATE_VERSION' > /etc/monolith/template-version
    systemctl daemon-reload
    systemctl enable monolith-bind-agent.service
    systemctl restart monolith-bind-agent.service
"

say "checking the bind agent answers inside the guest"
pct exec "$VMID" -- python3 -c "
import json, urllib.request
body = json.load(urllib.request.urlopen('http://127.0.0.1:$BIND_PORT/health', timeout=5))
assert body['state'] == 'unbound', body
assert body.get('api') == 3, body
print('bind agent:', body)
"

say "clearing per-guest identity"
pct exec "$VMID" -- sh -eu -c '
    rm -rf /run/monolith/claim.json /run/monolith/runtime.json /srv/monolith/runtime /srv/monolith/runtime.log
    nft delete table inet monolith_egress 2>/dev/null || true
    : > /etc/machine-id
    rm -f /var/lib/dbus/machine-id
    journalctl --rotate >/dev/null 2>&1 || true
    journalctl --vacuum-time=1s >/dev/null 2>&1 || true
'

say "shutting down cleanly"
pct shutdown "$VMID" --timeout 60
pct set "$VMID" --memory "$MEMORY_MB"
pct set "$VMID" --description "Monolith golden template $TEMPLATE_VERSION (scripts/build-template.sh). Clones are made by the Monolith driver; do not start this CT."
pct template "$VMID"
say "CT $VMID is now template $TEMPLATE_VERSION"
pct config "$VMID" | grep -E '^(template|digest|net0|memory|rootfs|tags|description)' || true
