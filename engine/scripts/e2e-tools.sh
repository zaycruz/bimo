#!/bin/sh
# Install the pinned real runtimes the fabric E2E suite drives, into
# target/e2e-tools (gitignored). Idempotent: a tool already installed at the
# pinned version is left alone. Prints KEY=path lines for the test harness.
#
#   hermes-agent 0.15.2 (PyPI, via uv)    -> HERMES_BIN
#   iron-proxy   0.52.0 (GitHub release)   -> IRON_PROXY_BIN, sha256-pinned
#   node         24.21.0 (nodejs.org)      -> NODE_BIN_DIR, sha256-pinned (eve needs Node 24+)
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TOOLS="$ROOT/target/e2e-tools"
mkdir -p "$TOOLS"

HERMES_VERSION=0.15.2
HERMES_DIR="$TOOLS/hermes-$HERMES_VERSION"
if [ ! -x "$HERMES_DIR/bin/hermes" ]; then
  command -v uv >/dev/null 2>&1 || { echo "e2e-tools: uv is required to install hermes-agent (brew install uv)" >&2; exit 1; }
  rm -rf "$HERMES_DIR"
  uv venv --quiet --python 3.12 "$HERMES_DIR" >&2
  VIRTUAL_ENV="$HERMES_DIR" uv pip install --quiet "hermes-agent==$HERMES_VERSION" >&2
fi
echo "HERMES_BIN=$HERMES_DIR/bin/hermes"

IRON_VERSION=0.52.0
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) IRON_ASSET=darwin_arm64; IRON_SHA=ad730f0c41a6ed96778f947c29d2eb907b81affb8c682c0807ee2a36aed772c0 ;;
  Darwin-x86_64) IRON_ASSET=darwin_amd64; IRON_SHA=bacf09fabfcbc9f7d72c000e2c3715ada7893e2af88555356b46d12c208dc0e1 ;;
  Linux-x86_64) IRON_ASSET=linux_amd64; IRON_SHA=caae756f0aa7d87fc6ba2843bbae663b67b29d1b3eddd43a55925b39c1b2ab94 ;;
  Linux-aarch64|Linux-arm64) IRON_ASSET=linux_arm64; IRON_SHA=0c56dfe335827cf6862bf5e2dfc7e0f42b31bd36bcec32858b7091a526bde435 ;;
  *) echo "e2e-tools: no iron-proxy build for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
IRON_DIR="$TOOLS/iron-proxy-$IRON_VERSION"
IRON_TAR="iron-proxy_${IRON_VERSION}_${IRON_ASSET}.tar.gz"
if [ ! -x "$IRON_DIR/iron-proxy" ]; then
  mkdir -p "$IRON_DIR"
  curl -fsSL -o "$IRON_DIR/$IRON_TAR" \
    "https://github.com/ironsh/iron-proxy/releases/download/v$IRON_VERSION/$IRON_TAR"
  ACTUAL=$(shasum -a 256 "$IRON_DIR/$IRON_TAR" | cut -d' ' -f1)
  if [ "$ACTUAL" != "$IRON_SHA" ]; then
    echo "e2e-tools: iron-proxy checksum mismatch: got $ACTUAL, want $IRON_SHA" >&2
    rm -f "$IRON_DIR/$IRON_TAR"
    exit 1
  fi
  tar -xzf "$IRON_DIR/$IRON_TAR" -C "$IRON_DIR"
fi
echo "IRON_PROXY_BIN=$IRON_DIR/iron-proxy"

NODE_VERSION=24.21.0
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) NODE_ASSET=darwin-arm64; NODE_SHA=bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057 ;;
  Darwin-x86_64) NODE_ASSET=darwin-x64; NODE_SHA=1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097 ;;
  Linux-x86_64) NODE_ASSET=linux-x64; NODE_SHA=6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff ;;
  Linux-aarch64|Linux-arm64) NODE_ASSET=linux-arm64; NODE_SHA=724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5 ;;
esac
NODE_DIR="$TOOLS/node-v$NODE_VERSION-$NODE_ASSET"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  NODE_TAR="$TOOLS/node-v$NODE_VERSION-$NODE_ASSET.tar.gz"
  curl -fsSL -o "$NODE_TAR" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$NODE_ASSET.tar.gz"
  ACTUAL=$(shasum -a 256 "$NODE_TAR" | cut -d' ' -f1)
  if [ "$ACTUAL" != "$NODE_SHA" ]; then
    echo "e2e-tools: node checksum mismatch: got $ACTUAL, want $NODE_SHA" >&2
    rm -f "$NODE_TAR"
    exit 1
  fi
  tar -xzf "$NODE_TAR" -C "$TOOLS"
  rm -f "$NODE_TAR"
fi
echo "NODE_BIN_DIR=$NODE_DIR/bin"
