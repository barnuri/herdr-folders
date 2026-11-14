#!/usr/bin/env bash
# Attach a herdr client to the demo server and play the scripted tour in the background.
set -uo pipefail
ROOT="$(cat /tmp/hfd.root)"
bash "$(dirname "$0")/driver.sh" "$ROOT" > "$ROOT/driver.log" 2>&1 &
exec env -i PATH="$PATH" HOME="$ROOT/home" TERM=xterm-256color LANG=en_US.UTF-8 herdr
