# herdr-folders

A [herdr](https://herdr.dev) plugin that adds a folder sidebar. Every terminal and agent is grouped under its folder (the git repo root, or the cwd). Each folder shows a git line like the `minimal-git` zsh prompt. You can bulk close panes from the sidebar, and a VS Code-style git changes panel opens from any folder.

## Features

- **Folder tree:** one node per folder, with a type icon (rust, go, python, bun, typescript, node, java, helm, docker, agent, git, plain). Under it are its agents and terminals. A pane that runs an agent is shown once, as an agent.
- **herdr statuses:** agents show working (spinner), blocked, done, idle and unknown. Terminals show `›` at the shell prompt, or `▶ <command>` while something runs. Folders show the most urgent status. Folders with active agents sort first.
- **Git line per folder:** `branch ↓behind ↑ahead +added ?untracked ±modified -deleted !conflicts`, or `=` when clean.
- **Toolbar buttons:** collapse all, expand all, expand all agents (tab, title, pane id), narrow, widen, hide to a strip, and bulk close.
- **Resize:** use the `−`/`+` buttons or `[`/`]`, or drag the `▕` grip on the left edge. The width is saved.
- **Bulk close (with confirmation):** close empty folders (every pane is an idle shell), close idle agents and empty folders, close all terminals (agents stay), close everything.
- **Git changes panel:** right-click a folder (or press `g`) to open a popup. It has staged and unstaged groups, a diff with line numbers, stage, unstage and discard per file or per group, commit, fetch, pull (`--ff-only`) and push.

## Install

```sh
herdr plugin link ~/sandbox/private/herdr-folders
herdr plugin action invoke toggle-panel --plugin barnuri.folders
```

## Sidebar keys

| Key | Action |
|---|---|
| `j`/`k`, arrows | move |
| `enter` | focus the pane, or toggle the folder |
| `space`, `←`/`→` | toggle the folder or the agent details |
| `g` / right-click | git changes for the folder |
| `e` / `c` / `a` | expand all / collapse all / toggle all agents |
| `x`, then `1`-`4` | bulk close menu |
| `[` / `]` | narrow / widen |
| `h` | hide to a strip / show |

## Git panel keys

`s` stage or unstage · `d` discard (asks first) · `A`/`U` stage or unstage all · `c` type a commit message, `enter` to commit · `f` fetch · `p` pull · `P` push · `tab` move focus to the diff · `pgup`/`pgdn` scroll · `q` close.

## Control from an AI agent

Every feature is a CLI command that prints JSON. The CLI and the panel share `~/.local/state/herdr-folders/state.json`, so a command changes an open panel within 0.5 s.

```sh
node bin/folders.js snapshot                         # folders, panes, statuses, git
node bin/folders.js collapse-all | expand-all | expand-agents | collapse-agents
node bin/folders.js close terminals                  # dry run: lists what would close
node bin/folders.js close idle-agents-and-empty-folders --yes
node bin/folders.js panel toggle|open|close|hide|show|grow 10|shrink 10|width 50
node bin/folders.js focus w1:p3
node bin/folders.js git-status ~/repo
node bin/folders.js git-diff ~/repo src/a.js [--staged]
node bin/folders.js git-action ~/repo stage src/a.js | commit "msg" | push
node bin/folders.js git ~/repo                       # open the git popup
```

The same operations are plugin actions (`herdr plugin action list --plugin barnuri.folders`). The close actions open a confirmation popup. `close` never closes the pane that runs the command.

## Limits

- herdr keeps panes at least about 18 columns wide, so the hidden strip shows status icons with short names.
- Drag-resize uses mouse motion inside the sidebar. Dragging right narrows it. To widen, use `+` or `]`, because herdr may not send motion events outside the pane.

## Development

```sh
npm test
```

An open sidebar keeps the code it loaded at start. After a code change, run `panel close` then `panel open`.
