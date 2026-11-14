#!/usr/bin/env bash
# The demo tour. Each step is a real plugin command, the same ones an AI agent would run.
# Keys for the git popup are typed by the vhs tape at matching times (see folders.tape).
set -uo pipefail
ROOT="$1"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
START=$(date +%s)

dh() { env -i PATH="$PATH" HOME="$ROOT/home" TERM=xterm-256color LANG=en_US.UTF-8 "$@"; }
cli() { (cd "$PLUGIN_DIR" && dh node bin/folders.js "$@" > /dev/null); }
at() { while (( $(date +%s) - START < $1 )); do sleep 0.1; done; echo "t=$1 ${*:2}"; }
sidebar() {
  dh herdr pane list | python3 -c "
import json,sys
panes=json.load(sys.stdin)['result']['panes']
tab=next((p['tab_id'] for p in panes if p['focused']), None)
print(next((p['pane_id'] for p in panes if p.get('label')=='Folders' and p['tab_id']==tab), ''))"
}
key() { dh herdr pane send-text "$(sidebar)" "$1"; }

at 3 collapse all;          cli collapse-all
at 5 expand all;            cli expand-all
at 7 expand agents;         cli expand-agents
at 10 collapse agents;      cli collapse-agents
at 11 widen;                cli panel grow 12
at 13 narrow;               cli panel shrink 12
at 15 bulk close menu;      key x
at 17 pick idle + empty;    key 2
at 20 cancel;               key n
at 21 git popup;            cli git "$ROOT/work/web-shop"
# t=23..37: the tape stages a file, commits and pushes inside the popup, then closes it
at 39 hide to strip;        cli panel hide
at 41 show;                 cli panel show
at 43 restore herdr sidebar; key R
at 47 replace again;        cli replace on
at 50 projects tab;         cli view projects
at 52 filter;               key mob
at 54 open project;         key $'\r'
at 58 folders tab;          cli view folders
at 61 done
