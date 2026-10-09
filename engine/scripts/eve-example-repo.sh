#!/bin/sh
# Publish examples/eve-agent as a local git repository with a deterministic
# commit, so examples/eve-agent.toml can pin a real revision without a hosted
# repository. Usage: sh scripts/eve-example-repo.sh [dest]
# Default dest: target/eve-agent.git. Prints REPO=<path> and REV=<commit>.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEST=${1:-"$ROOT/target/eve-agent.git"}
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$ROOT/examples/eve-agent/." "$DEST/"
cd "$DEST"
export GIT_AUTHOR_NAME="Monolith Examples" GIT_AUTHOR_EMAIL="examples@monolith.invalid"
export GIT_COMMITTER_NAME="Monolith Examples" GIT_COMMITTER_EMAIL="examples@monolith.invalid"
export GIT_AUTHOR_DATE="2026-10-04T00:00:00Z" GIT_COMMITTER_DATE="2026-10-04T00:00:00Z"
git init --quiet --initial-branch=main
git -c core.fileMode=true add --all
git -c commit.gpgsign=false commit --quiet --no-verify -m "eve example agent"
echo "REPO=$DEST"
echo "REV=$(git rev-parse HEAD)"
