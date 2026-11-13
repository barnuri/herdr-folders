'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATE_FILE = 'state.json';

// A fixed path, not HERDR_PLUGIN_STATE_DIR: the CLI also runs from plain shells (an AI agent's),
// where herdr does not inject that variable, and both sides must share one state file.
function stateDir() {
  return process.env.HERDR_FOLDERS_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'herdr-folders');
}

function statePath() {
  return path.join(stateDir(), STATE_FILE);
}

function defaultState() {
  // collapsed: folder path -> true; expandedAgents: pane id -> true; command: last command for the panel
  return { collapsed: {}, expandedAgents: {}, allAgentsExpanded: false, width: 44, hidden: false, command: null };
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  fs.mkdirSync(stateDir(), { recursive: true });
  const tmp = `${statePath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, statePath());
}

function updateState(mutate) {
  const state = loadState();
  mutate(state);
  saveState(state);
  return state;
}

// Panel-side operations (resize, hide) need the live pane, so the CLI queues them for the panel.
function queuePanelCommand(name, args = {}) {
  return updateState((state) => {
    state.command = { name, args, seq: Date.now() };
  });
}

module.exports = { stateDir, statePath, defaultState, loadState, saveState, updateState, queuePanelCommand };
