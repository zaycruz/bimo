#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STATE=$(mktemp -d "${TMPDIR:-/tmp}/monolith-worker.XXXXXX")
trap '"$ROOT/target/debug/monolith" destroy "$STATE" >/dev/null 2>&1 || true; rm -rf "$STATE"' EXIT
cargo build --manifest-path "$ROOT/Cargo.toml"
"$ROOT/target/debug/monolith" validate "$ROOT/examples/llm-demo.toml"
"$ROOT/target/debug/monolith" plan "$ROOT/examples/llm-demo.toml" --state-dir "$STATE"
"$ROOT/target/debug/monolith" apply "$ROOT/examples/llm-demo.toml" --state-dir "$STATE"
"$ROOT/target/debug/monolith" send "$STATE" --from planner --to worker --kind work.requested --payload '{"task":"acceptance"}'
sleep 1
"$ROOT/target/debug/monolith" status "$STATE"
test -n "$(find "$STATE/terminals" -type f -print -quit)"
"$ROOT/target/debug/monolith" destroy "$STATE"
