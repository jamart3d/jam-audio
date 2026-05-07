#!/bin/bash
set -e

# Resolve paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Ensure wasm-pack is installed
if ! command -v wasm-pack &> /dev/null; then
    echo "Error: wasm-pack is required. Install it with 'cargo install wasm-pack'."
    exit 1
fi

# 1. Build Wasm
echo "Building jam_audio_engine..."
wasm-pack build --target web --release --out-name jam_audio_engine

# 2. Optionally sync artifacts to a local web app checkout
PKG_DIR="$SCRIPT_DIR/pkg"
WEB_PKG_DIR="$SCRIPT_DIR/../../apps/jamdisc_web/web/pkg"

if [ ! -f "$PKG_DIR/jam_audio_engine_bg.wasm" ] || [ ! -f "$PKG_DIR/jam_audio_engine.js" ]; then
    echo "Error: Expected build artifacts were not created."
    exit 1
fi

if [ -d "$WEB_PKG_DIR" ]; then
    echo "Syncing artifacts to $WEB_PKG_DIR..."
    cp "$PKG_DIR/jam_audio_engine_bg.wasm" "$WEB_PKG_DIR/"
    cp "$PKG_DIR/jam_audio_engine.js" "$WEB_PKG_DIR/"
    echo "Build and sync complete."
else
    echo "Build complete. Artifacts available in $PKG_DIR."
fi
