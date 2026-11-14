#!/usr/bin/env bash
# Stop the demo herdr server and its agents, then move the demo folder to the trash.
set -uo pipefail
for ROOT in /tmp/hfd.*/; do
  ROOT="${ROOT%/}"
  [ -d "$ROOT/home" ] || continue
  env -i PATH="$PATH" HOME="$ROOT/home" herdr server stop > /dev/null 2>&1 || true
  pkill -f "$ROOT" 2>/dev/null || true
  trash "$ROOT" 2>/dev/null || true
done
trash /tmp/hfd.root /tmp/hfd.stage.log 2>/dev/null || true
