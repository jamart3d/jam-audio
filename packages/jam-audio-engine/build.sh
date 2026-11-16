#!/bin/bash
set -e

# Resolve paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Ensure wasm-pack is installed
WASM_PACK_CMD="wasm-pack"
if ! command -v $WASM_PACK_CMD &> /dev/null; then
    if command -v wasm-pack.exe &> /dev/null; then
        WASM_PACK_CMD="wasm-pack.exe"
    else
        echo "Error: wasm-pack is required. Install it with 'cargo install wasm-pack'."
        exit 1
    fi
fi

# 1. Build Wasm
echo "Building jam_audio_engine..."
$WASM_PACK_CMD build --target web --release --out-name jam_audio_engine

# Patch pkg/package.json for scoped npm distribution
PKG_JSON="$SCRIPT_DIR/pkg/package.json"
if [ -f "$PKG_JSON" ]; then
    node -e '
      const fs = require("fs");
      const pkg = JSON.parse(fs.readFileSync(process.argv[1]));
      pkg.name = "@jamart3d/jam-audio-engine-wasm";
      pkg.license = "MIT";
      pkg.publishConfig = { access: "public" };
      pkg.repository = { type: "git", url: "git+https://github.com/jamart3d/jam-audio.git" };
      fs.writeFileSync(process.argv[1], JSON.stringify(pkg, null, 2) + "\n");
    ' "$PKG_JSON"
fi

# 2. Sync artifacts to the web app when a target directory is configured or present
PKG_DIR="$SCRIPT_DIR/pkg"
if [ ! -f "$PKG_DIR/jam_audio_engine_bg.wasm" ] || [ ! -f "$PKG_DIR/jam_audio_engine.js" ]; then
    echo "Error: Expected build artifacts were not created."
    exit 1
fi

DEFAULT_WEB_DIR="$SCRIPT_DIR/../../../jamdisc/apps/jamdisc_web/web"
if [ -n "${JAMDISC_WEB_PKG_DIR:-}" ]; then
    WEB_PKG_DIR="$JAMDISC_WEB_PKG_DIR"
elif [ -d "$DEFAULT_WEB_DIR" ]; then
    WEB_PKG_DIR="$DEFAULT_WEB_DIR/pkg"
else
    WEB_PKG_DIR=""
fi

if [ -n "$WEB_PKG_DIR" ]; then
    echo "Syncing artifacts to $WEB_PKG_DIR..."
    mkdir -p "$WEB_PKG_DIR"
    cp "$PKG_DIR/jam_audio_engine_bg.wasm" "$WEB_PKG_DIR/"
    cp "$PKG_DIR/jam_audio_engine.js" "$WEB_PKG_DIR/"
    echo "Build and sync complete."
else
    echo "Build complete. Skipping web app sync (no jamdisc checkout found; set JAMDISC_WEB_PKG_DIR to override)."
fi
