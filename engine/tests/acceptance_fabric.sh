#!/bin/sh
# Fabric acceptance (U9). Runs the local-mode fabric E2E suite, then the live
# Proxmox suites, which reach the cluster only when BIMO_PROXMOX_LIVE=1
# (alias MONOLITH_PROXMOX_LIVE=1) and the target config and token are
# present. Writes a dated report to .bimo/reports/ either way. Exits non-zero if the local suite fails, or
# if a live run was requested and did not pass.
set -u
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
REPORTS="$ROOT/.bimo/reports"
LIVE_FLAG=${BIMO_PROXMOX_LIVE:-${MONOLITH_PROXMOX_LIVE:-}}
mkdir -p "$REPORTS"
LOG="$REPORTS/$STAMP-fabric-acceptance.log"
REPORT="$REPORTS/$STAMP-fabric-acceptance.md"
MARKER="$REPORTS/.$STAMP-start"
: >"$MARKER"

cargo build --manifest-path "$ROOT/Cargo.toml" >"$LOG" 2>&1 || {
    echo "build failed; see $LOG" >&2
    exit 1
}

echo "== cargo test --test e2e_fabric" >>"$LOG"
cargo test --manifest-path "$ROOT/Cargo.toml" --test e2e_fabric >>"$LOG" 2>&1
LOCAL_RC=$?

echo "== cargo test --test e2e_spawn_latency --test e2e_proxmox --test e2e_proxmox_agents --no-fail-fast -- --nocapture" >>"$LOG"
cargo test --manifest-path "$ROOT/Cargo.toml" --test e2e_spawn_latency --test e2e_proxmox \
    --test e2e_proxmox_agents --no-fail-fast -- --nocapture >>"$LOG" 2>&1
LIVE_RC=$?

if [ "$LIVE_FLAG" = "1" ]; then
    LIVE_REQUESTED=yes
    if [ "$LIVE_RC" -eq 0 ]; then
        LIVE_STATUS="PASSED"
    elif grep -q "^NOT RUN" "$LOG"; then
        LIVE_STATUS="NOT RUN (requested; a precondition is missing)"
    elif grep -q "BLOCKED:" "$LOG"; then
        LIVE_STATUS="BLOCKED"
    else
        LIVE_STATUS="FAILED"
    fi
else
    LIVE_REQUESTED=no
    LIVE_STATUS="NOT RUN (BIMO_PROXMOX_LIVE is not 1)"
fi

TRANSCRIPTS=$(find "$ROOT/target/e2e-fabric" -name transcript.jsonl -newer "$MARKER" 2>/dev/null | sort)
# Applies that started a generation (status envelopes repeat the number).
READY=$(for t in $TRANSCRIPTS; do grep '"command":"apply"' "$t" | grep -o '"ready_ms":[0-9][0-9]*'; done \
    | cut -d: -f2 | sort -n | tr '\n' ' ' | sed 's/^ *//; s/ *$//')
LIVE_REPORTS=$(find "$REPORTS" -name '*.json' -newer "$MARKER" 2>/dev/null | sort)
rm -f "$MARKER"

{
    echo "# Fabric acceptance $STAMP"
    echo
    echo "- Git HEAD: $(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown) (working tree may differ: $(git -C "$ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ') changed paths)"
    echo "- Host: $(uname -sm)"
    echo "- Full log: $LOG"
    echo
    echo "## Local mode (cargo test --test e2e_fabric)"
    echo
    if [ "$LOCAL_RC" -eq 0 ]; then echo "Result: PASSED"; else echo "Result: FAILED (exit $LOCAL_RC)"; fi
    echo
    echo '```text'
    sed -n '/== cargo test --test e2e_fabric/,/== cargo test --test e2e_spawn_latency/p' "$LOG" | grep -E '^test |^test result'
    echo '```'
    echo
    echo "Local request-to-first-task times, ms (cold local path, not R3 evidence): ${READY:-none}"
    echo
    echo "Transcripts (every CLI envelope, schema-validated):"
    for t in $TRANSCRIPTS; do echo "- $t"; done
    echo
    echo "## Live Proxmox (e2e_spawn_latency, e2e_proxmox, e2e_proxmox_agents)"
    echo
    echo "Requested: $LIVE_REQUESTED"
    echo
    echo "Status: $LIVE_STATUS"
    echo
    echo '```text'
    sed -n '/== cargo test --test e2e_spawn_latency/,$p' "$LOG" | grep -E '^test |^test result|^NOT RUN|BLOCKED:'
    echo '```'
    echo
    echo "Suite reports:"
    for r in $LIVE_REPORTS; do echo "- $r"; done
} >"$REPORT"

echo "report: $REPORT"
cat "$REPORT"
if [ "$LOCAL_RC" -ne 0 ]; then exit 1; fi
if [ "$LIVE_REQUESTED" = yes ] && [ "$LIVE_RC" -ne 0 ]; then exit 1; fi
exit 0
