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
wasm-pack build --target web --release

# 2. Sync artifacts to the web app
PKG_DIR="$SCRIPT_DIR/pkg"
WEB_PKG_DIR="$SCRIPT_DIR/../../../../apps/jamdisc_web/web/pkg"

echo "Syncing artifacts to $WEB_PKG_DIR..."
mkdir -p "$WEB_PKG_DIR"

if [ -f "$PKG_DIR/jam_audio_engine_bg.wasm" ] && [ -f "$PKG_DIR/jam_audio_engine.js" ]; then
    cp "$PKG_DIR/jam_audio_engine_bg.wasm" "$WEB_PKG_DIR/"
    cp "$PKG_DIR/jam_audio_engine.js" "$WEB_PKG_DIR/"
    echo "Build and sync complete."
else
    echo "Error: Expected build artifacts were not created."
    exit 1
fi
