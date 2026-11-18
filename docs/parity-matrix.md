# Parity matrix: herdr-folders TUI plugin vs the herdr-app mod

Mod: `app-mod/mods/folders` (installed copy `~/.config/herdr-app/mods/folders`, same files). TUI code: `bin/sidebar.js`, `bin/git-panel.js`, `bin/folders.js`, `lib/*`, `herdr-plugin.toml`.
Status: **done** or **limit** only. "was missing/partial" is the status before node folders-parity2.
Proof dir (P): `/Users/barnu/.harness-orch/runs/20261117-190137-8cad/out/folders-parity2/` (shots t1, p2, g1, c1, cli-proof.txt). A real pointer click or key press cannot be driven on the real display, so proofs use `herdr-app do folders.<command>`, which runs the same handler the click or key runs, then a shot or status text.

## Part 1: folders plugin

| # | Feature | TUI behaviour | App-mod status | How to prove | App limit |
|---|---|---|---|---|---|
| 1 | Folder grouping | one card per git root or cwd, folders with active agents first | done (`main.js:folders()`, `model.js`) | shot P/t1.png | |
| 2 | Tree grouping | folders nested by path, single-child dirs merged, dirs collapsible | done, was missing (`extras.js:296 renderTree`, `model.js buildTree`) | `do folders.grouping-tree`, P/t1.png | |
| 3 | Flat/tree toggle | key `v`, gear, CLI `grouping` | done, was missing (`extras.js:act grouping`, gear row) | `do folders.key-v`, state.json `grouping` flips | |
| 4 | Sort opened/status/name | key `o`, gear, CLI `sort` | done, was missing (`extras.js:act sort`, `keys.js nextSort`) | `do folders.key-o` -> state.json sort "status" | |
| 5 | Spacing comfortable/compact | key `s`, gear, CLI | done, was missing UI toggle (`extras.js:act spacing`; `main.js renderPane` honours it) | `do folders.key-s` -> state.json spacing | |
| 6 | Card backgrounds | gear, CLI `card-backgrounds` | done, was settings-only (gear row, `folders.card-backgrounds-on|off`) | cli-proof.txt | |
| 7 | Always expanded / collapsible | gear, CLI `collapsible`; chevrons gated | done (folders-click node; gear row + state.json now) | gear shot P/g1.png | |
| 8 | Expand/collapse all folders, tree dirs too | keys `e` `c`, CLI | done, dirs were missing (`extras.js:setAllCollapsed`) | `do folders.collapse-all` | |
| 9 | Agent details expand all | key `a`, CLI `expand-agents` | done (`extras.js:act agents`, `agents-on|off`) | cli | |
| 10 | Focused pane marked | accent bar, bold, blue folder name | done (`main.js renderPane/renderFolder`) | shot P/c1.png | |
| 11 | Status dots / spinner / orch | working spinner, orch magenta, blocked, done, idle, shell `›`, `▶ cmd` | done (`main.js:glyph`, `view.js`, folders-orch node) | shot P/c1.png | |
| 12 | Git line per folder | `branch ↓↑ +?±-!` or `=` | done (`view.js gitSegments`, `data.js`) | shot P/c1.png | |
| 13 | Shells read like agents | name or `▶ cmd`, ready/running | done (`main.js renderPane`) | shot | |
| 14 | Two-row cards, whole-card click, hover highlight | click focuses; hover colour | done (`main.js` `.hover`, `.on_click`) | `do pane.focus` proves the handler command (folders-click node) | real pointer not driven |
| 15 | Keyboard table (j k arrows enter space g e c a x1-4 [ ] h tab ? v s o n R r esc) | sidebar keys | done, was only `g` (`keys.js`, `extras.js:onKey/act`, `main.js:495`) | `do folders.key-<k>`: key-v/o/s changed state.json; key-x,key-3 showed confirm (P/c1.png); key-n cancelled; tests/folders-keys.test.js | keys reach the panel only when it has keyboard focus (gpui rule). Workaround shipped: global binding `cmd-ctrl-g` -> `folders.changes-focused` in keys.json |
| 16 | Selection cursor | highlighted row moved by j/k | done, was missing (`extras.js:move`, `main.js` `selKey` bg) | key-j, key-down | |
| 17 | Settings/gear list | every action with icon and key: View, Panel, Folder, Close | done, was a 1-row menu (`extras.js:322 renderActions`, `main.js:384`) | shot P/g1.png | icons are text keys, not nerd glyphs |
| 18 | Right-click menu: agent/shell | focus, details, close (asks), new tab, git changes | done, details row was missing (`main.js:330 renderCtx`) | ctx rows; close path via `close-*` confirm | real right-click not driven |
| 19 | Right-click menu: folder | new tab, git changes, expand/collapse, close all (asks) | done, expand/collapse was missing (`main.js:330`) | same | |
| 20 | New tab per folder (`+`, key `n`, CLI) | shell tab in the folder's workspace, focused | done (`main.js:228 newTab`, `extras.js act new-tab`, `new-tab-<n>`) | folders-click node + `do folders.new-tab-1` | |
| 21 | Close: per pane, per folder, 4 bulk modes with confirm | confirm popup | done, inline confirm + y/n keys + toast (`main.js:143,150,207`; `extras.js`) | key-x,key-3 -> "All terminals: close 1 pane?" (P/c1.png); key-n cancelled | |
| 22 | Confirm kill setting | trash asks or kills at once | done (`settings.confirmKill`, gear row, state.json) | gear shot | |
| 23 | Projects tab | herdr-project-manager list, filter, enter opens workspace or focuses, ctrl+t tab, ctrl+r rescan, open dots | done, was missing (`extras.js:260,270,140,151`) | `do folders.show-projects` P/p2.png (121 projects); filter-herdr-fold + open-project-1 created space "herdr-folders" (ls), closed after | |
| 24 | Projects-tab on/off, view switch | CLI `projects-tab`, `view`, key tab | done (`extras.js:extraCommand`, `renderTabs`) | cli-proof.txt | |
| 25 | Git changes view | staged/unstaged groups, split+unified diff with line numbers, stage/unstage/discard (confirm), commit, fetch/pull/push, key `v` | done (folders-own node: `changes-view.js`, `changes.js`, `diff.js`; opened by key g / git segment click / `folders-app git`) | P/c1.png (side by side, line numbers, Stage all); folders-own handoff proofs for stage..push | |
| 26 | Open git view from a folder | right-click, key g, git segment | done (`main.js`, `extras.js act git`, `changes-path-<path>`) | `folders-app.js git <folder>` -> P/c1.png | |
| 27 | Orch row | (TUI shows orch status) | done (folders-orch node, `orchjobs.js`) | node proofs | |
| 28 | state.json sharing | CLI and panel share `~/.local/state/herdr-folders/state.json` | done, was missing (`prefs.js`, `extras.js:pullPrefs`, 5 s poll + `folders.pull-prefs`) | `folders-app.js grouping folder` -> app switched; app key-v wrote state.json | |
| 29 | CLI: snapshot | JSON of folders | done (`bin/folders-app.js snapshot`, `extras.js writeSnapshot`) | cli-proof.txt | |
| 30 | CLI: expand-all collapse-all expand/collapse-agents grouping sort spacing collapsible card-backgrounds view projects-tab | state changes | done (`bin/folders-app.js`) | cli-proof.txt | |
| 31 | CLI: focus, new-tab, close <mode> [--yes] | pane actions | done (`folders-app.js`; close shows the panel confirm, `--yes` confirms; no dry-run list) | cli-proof.txt (focus) | dry-run list not shown: close plan lives in the panel |
| 32 | CLI: projects, open-project, git-status, git-diff, git-action, git | project list, open, git | done (`folders-app.js` reuses `folders.js` for git/projects) | cli-proof.txt | |
| 33 | CLI: expand-folder/collapse-folder <path> | per folder | limit | | `collapsed` lives in the mod's localStorage; no shared file the CLI may write that the mod reads. Upstream: mod-readable shared state writable from `herdr-app do` with args |
| 34 | Replace herdr's sidebar | hide TUI sidebar through config, dock panel in each tab | done as the app equivalent: `replace on|off` hides/shows the app's own `sidebar` block (`extras.js` `replace-on|off`, key R, gear) | `do folders.replace-off` | no config/dock: layout already holds the panel in every tab |
| 35 | Panel width resize, grow/shrink, width N | `[` `]`, drag grip, CLI | done (`extras.js:resize`, `width-<px>`, `layout.resize`) | `panel width 44` ok | drag grip: layout divider is the app's |
| 36 | Hide to a strip / show | key h, `panel hide|show` | done (`layout.hide folders`, `layout.show folders`) | cli | |
| 37 | Panel open/close/toggle per tab, snooze per tab, slots, dock events | one panel moved across tabs via slots | limit | | not needed: a layout block exists in every tab. The app has no per-tab panel API to replace |
| 38 | Refresh now | key r | done (`act refresh`) | gear | |
| 39 | Toast feedback (flash line) | status line texts | done (`notify` on close and project open, `extras.js:140`, `main.js:150`) | | |
| 40 | Narrow-panel layout (phone) | drops state words | limit | | the app layout is a fixed px block; no breakpoint API |

## Part 2: other migrated plugins (features lost vs the old TUI plugin)

| Plugin | Feature | App status | Note |
|---|---|---|---|
| herdr-notifications | Telegram/Discord/Slack alerts, relay, filters | done: it already reads `hc events --json` (`lib/hc.js`), not the TUI | no loss |
| herdr-notifications | desktop toast on provider failure | lost: it used the herdr TUI toast. App has `notify()` in mods only | upstream: a CLI to post an app notification |
| herdr-hc-attach | attach / watch (observe) / attach all as panes | lost: the app lists every hc terminal itself (Agents, terminals mods), but no `attach --observe` view-only pane and no "attach all in one tab" | app has `terminal.open`, `terminal.show`; observe-only mode missing upstream |
| orch hc path | jobs in space `orch`, one tab per run | done: labels `herdr.space`/`herdr.tab`; folders mod has the Orch row | no loss |
| herdr-web `/tui` | real TUI in the browser | kept at `/tui/` (`server.js:187`); the app has no browser client, so the app UI is not reachable from a phone | upstream: a web client for herdr-app |

## Tests

`npm test` in the repo: 57 pass, 0 fail (adds tests/folders-keys.test.js, sync test covers the new mod files).

## Delta: folders-rightclick-ui (look and interaction)

Files: `app-mod/mods/folders/{ui.js,menu.js,listops.js}` (new), `main.js` (wired; old render methods removed). Proofs: `herdr-app do folders.<cmd>`, shots in the node out dir `folders-rightclick-ui/shots/` (before, after, menu). A real pointer cannot be driven.

| Item | Status | Proof / note |
|---|---|---|
| Look: app typography (13 px names, 11 px captions), 28-30 px rounded rows, avatar letter, hover/selected fills, status dots, quiet git chips, footer hint, no stripes/TUI text rows | done | after.png |
| Every earlier behaviour (focus click, Changes view via git chip, env switch, sidebar setting, keys, confirm close, projects tab) | kept | 66 node tests pass; `ctx:ask-pane` + `confirm` closed a scratch tab |
| Right-click menu: popup at pointer with icons and key hints, keyboard up/down/enter/esc | done for folder and pane; project row: items built (`menuItems` project) but the Projects rows still open on right-click as before | menu.png, `do folders.menu-folder-N`, `menu-pane-N-M` |
| Folder menu: new tab, new shell here, editor, Finder, copy path, git, rename space, move up/down, collapse/expand all (only when collapsing is on), close all asks | done | menu.png; `ctx:*` commands handled with the overlay open |
| Pane menu: focus, rename, details, move to env orch/default, copy cwd, git, close asks | done; env move runs `hc label <t> herdr.space=orch` and was not run on a real terminal | `ctx:rename-pane`, `ctx:ask-pane` proved |
| Hover actions (+ and x only on hover), tooltips with full path | done | code; not visible in a still shot |
| Drag to reorder folders | done (mouse down/move/up like the spaces sidebar), also Move up/down (`ctx:up|down` proved); order in localStorage `order` | |
| Drag a terminal between folders or spaces | limit | the app has no command to move a pane to another space or folder; only `pane.swap` inside a tab |
| Search with live filter | done: search icon or cmd-f when the panel has focus; esc clears; empty state "No match" | `do folders.search-<text>` filtered 3 folders to 1 and 0 |
| Inline rename on double-click (folder = space, agent/shell = tab), F2 | done | `ctx:rename-pane` + `rename-text-<x>` renamed a scratch tab |
| Empty states | done (no terminals, no match, no agents) | |
| TUI keys | unchanged (`keys.js`), plus cmd-f, F2; while searching or renaming the keys go to the text |
| Limits | cmd-f only reaches the panel when it has keyboard focus (gpui rule, as before); mod.json overlay for the popup sizes from `menuHeight` |
