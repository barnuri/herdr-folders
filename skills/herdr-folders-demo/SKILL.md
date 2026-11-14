---
name: herdr-folders-demo
description: >
  Record the herdr-folders demo GIF (demo/demo.gif) in a throwaway world: temp folders, temp git
  repos with a bare remote, an isolated herdr server, and opencode agents on free local models.
  Use when the README GIF needs to be made or refreshed after a change to the panel, the git
  popup or the Projects tab. Triggers: "record the herdr-folders demo", "update the demo gif",
  "re-record the folders panel gif".
allowed-tools: Bash, Read
---

# herdr-folders-demo

Records `demo/demo.gif`, about 50 seconds. The panel replaces herdr's sidebar, then the GIF shows
collapse and expand, agent details, resize, the bulk close menu (cancelled), the git popup (stage,
commit, push), hide and show, restoring herdr's sidebar, and opening a project from the Projects tab.

## Rules

- Never record the user's live herdr session. `demo/stage.sh` starts its own herdr server with
  `HOME` set to a temp folder, so config, sockets, plugins and panel state are all separate.
- Every repo is a temp repo under `/tmp/hfd.*`, with a bare remote in the same folder. Never point
  the demo at a real repo. Do not add a real repo name, path or branch to `demo/`.
- The agents are opencode on a free local model (llama-swap through llm-hub, default
  `llm-hub/llama_swap/mlx-qwen3.6-35b`). Set `DEMO_MODEL` to change it. They run with the real
  `HOME` only so opencode finds its model config.
- The demo never confirms a bulk close: the tape cancels it.

## Needs

`vhs` (with `ttyd` and `ffmpeg`), `herdr`, `opencode`, `python3`, `trash`, a running llama-swap,
and a Nerd Font named `JetBrainsMono Nerd Font Mono`. For the Projects tab, check out
`herdr-project-manager` next to this repo. Without it, the demo still runs but has no Projects tab.

## Steps

1. Run `npm test` from the repo root. Stop if it fails.
2. Run `bash demo/cleanup.sh` to stop any earlier demo server.
3. Run `vhs demo/folders.tape` from the repo root, with a 6-minute timeout. Before recording
   (hidden), it runs `demo/stage.sh` and waits 70 s for the agents to start working. Then it runs
   `demo/run.sh`, which attaches a client and starts `demo/driver.sh` (the timeline).
4. Check the driver timeline: `cat "$(cat /tmp/hfd.root)/driver.log"` must end with `t=61 done`.
5. Look at the GIF before you keep it. Extract frames and read three of them:
   `ffmpeg -v error -y -i demo/demo.gif -vf "fps=1/3,scale=1100:-1" "$TMPDIR/g%02d.png"`
   - The panel is on the left, with no herdr sidebar beside it.
   - At least one agent row shows `working`.
   - The git popup shows a staged `src/price.js` with a red and a green diff line.
   - The Projects tab lists `mobile-app` with a green dot after it opens.
6. Run `bash demo/cleanup.sh`. It stops the demo server and moves `/tmp/hfd.*` to the trash.
7. Keep the GIF under about 3 MB. The README embeds it.

## Change the scenario

- Repos, agents and prompts: `demo/stage.sh`.
- Timeline (CLI calls and keys sent to the panel): `demo/driver.sh`.
- Git popup keys and window size: `demo/folders.tape`. The tape's sleeps match the driver's
  times, so change both together.
