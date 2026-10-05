#!/bin/sh
# Copy lab files the CLI ships with into assets/ (run from packages/vltx).
set -eu
ROOT=../..
mkdir -p assets/nono assets/skills
cp "$ROOT/config/registry.profiles.json" assets/registry.profiles.json
cp "$ROOT/examples/04-vlt-as-installer/gate.default.json" assets/gate.default.json
cp "$ROOT"/examples/07-nono-sandboxing/profiles/*.jsonc assets/nono/
cp "$ROOT/examples/07-nono-sandboxing/phases.json" assets/nono/phases.json
echo "assets synced"
