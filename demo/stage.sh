#!/usr/bin/env bash
# Build a throwaway world for the demo: temp repos, an isolated herdr server (its own HOME),
# opencode agents on free local models, and the folders panel in replace mode.
# Prints the demo root. Nothing outside that temp folder is touched.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REAL_HOME="$HOME"
# /tmp, not $TMPDIR: unix socket paths must stay under 104 bytes on macOS
ROOT="${DEMO_ROOT:-$(mktemp -d /tmp/hfd.XXXXXX)}"
DEMO_HOME="$ROOT/home"
WORK="$ROOT/work"
# Free models served locally by llama-swap through llm-hub; override with DEMO_MODEL.
DEMO_MODEL="${DEMO_MODEL:-llm-hub/llama_swap/mlx-qwen3.6-35b}"
mkdir -p "$DEMO_HOME/.config/herdr" "$WORK"
echo "$ROOT" > /tmp/hfd.root

dh() { env -i PATH="$PATH" HOME="$DEMO_HOME" TERM=xterm-256color LANG=en_US.UTF-8 "$@"; }
g() { git -C "$1" -c user.name=demo -c user.email=demo@example.com "${@:2}"; }

repo() { # repo <name> <marker file>
  local dir="$WORK/$1" remote="$ROOT/remotes/$1.git"
  mkdir -p "$dir" "$ROOT/remotes"
  git init -q --bare -b main "$remote"
  git init -q -b main "$dir"
  echo "# $1" > "$dir/README.md"
  echo "$3" > "$dir/$2"
  g "$dir" add -A && g "$dir" commit -qm "init $1"
  g "$dir" remote add origin "$remote" && g "$dir" push -qu origin main
}

# web-shop: 2 commits ahead, 2 modified, 1 untracked
repo web-shop package.json '{ "name": "web-shop", "scripts": { "dev": "vite" } }'
mkdir -p "$WORK/web-shop/src"
printf 'export const cart = [];\n' > "$WORK/web-shop/src/cart.js"
printf 'export const price = (n) => n * 1.17;\n' > "$WORK/web-shop/src/price.js"
g "$WORK/web-shop" add -A && g "$WORK/web-shop" commit -qm "cart and price" && g "$WORK/web-shop" push -q
printf 'export const coupon = (code) => code === "DEMO";\n' > "$WORK/web-shop/src/coupon.js"
g "$WORK/web-shop" add -A && g "$WORK/web-shop" commit -qm "coupons"
printf 'export const discount = 0.1;\n' >> "$WORK/web-shop/src/coupon.js"
g "$WORK/web-shop" add -A && g "$WORK/web-shop" commit -qm "discount"
printf 'export const cart = [];\nexport const add = (item) => cart.push(item);\n' > "$WORK/web-shop/src/cart.js"
printf 'export const price = (n) => Math.round(n * 1.17 * 100) / 100;\n' > "$WORK/web-shop/src/price.js"
printf 'checkout flow notes\n' > "$WORK/web-shop/TODO.md"

# api-gateway: 1 commit behind (pushed from a second clone), clean tree
repo api-gateway go.mod 'module example.com/api-gateway'
git clone -q "$ROOT/remotes/api-gateway.git" "$ROOT/other-clone"
echo 'rate limits: 100 rps' > "$ROOT/other-clone/LIMITS.md"
g "$ROOT/other-clone" add -A && g "$ROOT/other-clone" commit -qm "limits" && g "$ROOT/other-clone" push -q
g "$WORK/api-gateway" fetch -q

# ml-pipeline: one staged file, one deleted file
repo ml-pipeline pyproject.toml '[project]
name = "ml-pipeline"'
echo 'print("train")' > "$WORK/ml-pipeline/train.py"
g "$WORK/ml-pipeline" add train.py
g "$WORK/ml-pipeline" rm -q README.md

# notes: a plain folder, no git
mkdir -p "$WORK/notes" && echo "ideas" > "$WORK/notes/ideas.txt"

# isolated herdr: its own config, sockets, plugin list and state
printf 'onboarding = false\n\n[ui]\nshow_agent_labels_on_pane_borders = true\n\n[ui.toast]\ndelivery = "off"\n' > "$DEMO_HOME/.config/herdr/config.toml"
dh herdr server > "$ROOT/server.log" 2>&1 &
for _ in $(seq 1 50); do dh herdr workspace list > /dev/null 2>&1 && break; sleep 0.2; done
dh herdr plugin link "$PLUGIN_DIR" > /dev/null

# herdr-project-manager feeds the panel's Projects tab, when it is checked out next to this repo.
PM_DIR="$(dirname "$PLUGIN_DIR")/herdr-project-manager"
if [ -f "$PM_DIR/herdr-plugin.toml" ]; then
  for name in docs-site mobile-app infra-terraform; do
    mkdir -p "$WORK/$name" && git init -q -b main "$WORK/$name"
  done
  dh herdr plugin link "$PM_DIR" > /dev/null
  PM_CONFIG="$(dh herdr plugin config-dir barnuri.project-manager)"
  mkdir -p "$PM_CONFIG"
  printf '{ "globs": ["%s/*/.git"], "excludes": [], "projects": [], "autoOpen": false }\n' "$WORK" > "$PM_CONFIG/projects.json"
fi

jq_id() { python3 -c "import json,sys; d=json.load(sys.stdin)['result']; print(eval(sys.argv[1]))" "$1"; }
ws() { dh herdr workspace create --cwd "$WORK/$1" --label "$1" --no-focus | jq_id "d['root_pane']['pane_id']"; }

SHOP=$(ws web-shop)
GATE=$(ws api-gateway)
ML=$(ws ml-pipeline)
NOTES=$(ws notes)
SERVER=$(dh herdr pane split "$SHOP" --direction right --ratio 0.62 --cwd "$WORK/web-shop" --no-focus | jq_id "d['pane']['pane_id']")
dh herdr pane run "$SERVER" "clear; python3 -m http.server 0"

# opencode needs the real HOME for its model config; the model is a free local one.
start_agent() { # pane, prompt
  dh herdr pane run "$1" "clear; HOME='$REAL_HOME' OPENCODE_CONFIG_CONTENT='{\"model\":\"$DEMO_MODEL\"}' opencode --standalone --auto"
  for _ in $(seq 1 60); do
    dh herdr agent list | grep -q "\"pane_id\":\"$1\"" && break
    sleep 1
  done
  sleep 3
  dh herdr agent prompt "$1" "$2" > /dev/null || true
}
start_agent "$SHOP" "Add a removeFromCart function to src/cart.js and a unit test for it. Explain each step."
start_agent "$GATE" "Write a small Go HTTP handler in main.go that returns the rate limit from LIMITS.md. Explain each step."

# the very first workspace herdr made on start is empty: close it so the list stays clean
for id in $(dh herdr workspace list | python3 -c "import json,sys;[print(w['workspace_id']) for w in json.load(sys.stdin)['result']['workspaces'] if w['label'] not in ('web-shop','api-gateway','ml-pipeline','notes')]"); do
  dh herdr workspace close "$id" > /dev/null || true
done
dh herdr workspace focus "$(dh herdr pane get "$SHOP" | jq_id "d['pane']['workspace_id']")" > /dev/null
(cd "$PLUGIN_DIR" && dh node bin/folders.js replace on > /dev/null)
(cd "$PLUGIN_DIR" && dh node bin/folders.js panel width 42 > /dev/null)
echo "$ROOT"
