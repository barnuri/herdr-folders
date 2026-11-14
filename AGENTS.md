# herdr-folders: agent instructions

- No dependencies, Node >= 22, CommonJS. Run tests with `npm test`.
- The sidebar (`bin/sidebar.js`) and git panel (`bin/git-panel.js`) are long-running panes. After a code change, reopen them: `node bin/folders.js panel close`, then `node bin/folders.js panel open`.
- The state file has a fixed path (`~/.local/state/herdr-folders/state.json`), not `HERDR_PLUGIN_STATE_DIR`. The CLI runs from plain shells, so both sides must share one path.
- `herdr pane resize --amount` is a fraction of the split, not a column count.
- Popup panes do not appear in `herdr pane list`. To check the git panel's look, run it in a split pane and use `herdr pane read`.
- Never test a bulk close with `--yes` against the live session. It closes the user's panes.
- Test panel UI in an isolated herdr: run `demo/stage.sh` (temp `HOME`, temp repos), attach with `env -i PATH="$PATH" HOME=<root>/home herdr` in a detached tmux, and read it with `tmux capture-pane`. Stop it with `demo/cleanup.sh`. Never start a nested herdr client from inside the live session: it attaches to the live server.
- To re-record the README GIF, follow `skills/herdr-folders-demo/SKILL.md`.
