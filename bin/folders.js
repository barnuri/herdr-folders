#!/usr/bin/env node
'use strict';

const path = require('node:path');

const herdrApi = require('../lib/herdr');
const gitApi = require('../lib/git');
const { collect } = require('../lib/snapshot');
const { planClose, CLOSE_MODES } = require('../lib/model');
const { updateState, loadState, queuePanelCommand } = require('../lib/state');
const { promptText } = require('../lib/prompt');
const { toggleSidebar, openSidebar, closeSidebar, ensureDock, replaceOn, replaceOff } = require('../lib/panel');

const USAGE = `herdr-folders — control the folders panel (all output is JSON)

  snapshot                      folders, their agents/terminals, git status
  expand-all | collapse-all     expand or collapse every folder
  expand-folder <path> | collapse-folder <path>
  expand-agents | collapse-agents   show or hide agent details
  close <mode> [--yes]          modes: ${Object.keys(CLOSE_MODES).join(', ')}
                                without --yes only lists what would close
  focus <pane_id>               focus an agent or terminal
  replace on|off                replace herdr's own sidebar with this panel (on every tab), or restore it
  replace                       show whether replace mode is on
  panel toggle|open|close       open or close the panel in the focused tab (close all: every tab)
  panel hide|show               collapse the sidebar to a strip / restore it
  panel grow|shrink [cols]      resize the sidebar (default 6 columns)
  panel width <cols>            set the sidebar width
  git <folder>                  open the git changes panel for a folder
  confirm-close <mode>          open a popup that asks before closing
  git-status <folder>           git summary and changed files
  git-diff <folder> <file> [--staged]
  git-action <folder> stage|unstage|discard <file> | stage-all|unstage-all|pull|push|fetch | commit <message>
`;

function out(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function callerPane() {
  return process.env.HERDR_PANE_ID ? [process.env.HERDR_PANE_ID] : [];
}

async function snapshot() {
  const { folders } = await collect();
  const state = loadState();
  return folders.map((folder) => ({
    path: folder.path,
    name: folder.name,
    status: folder.status,
    collapsed: Boolean(state.collapsed[folder.path]),
    git: folder.git ? { ...folder.git, prompt: promptText(folder.git) } : null,
    panes: folder.panes,
  }));
}

async function close(mode, yes) {
  const { folders } = await collect({ withGit: false });
  const targets = planClose(folders, mode, { keepPaneIds: new Set(callerPane()) });
  if (!yes) {
    return { dryRun: true, mode, wouldClose: targets.map(({ paneId, kind, agent, status, cwd }) => ({ paneId, kind, agent, status, cwd })), hint: 'pass --yes to close' };
  }
  const results = await Promise.allSettled(targets.map((pane) => herdrApi.closePane(pane.paneId)));
  const outcomes = targets.map((pane, i) => ({ paneId: pane.paneId, result: results[i] }));
  return {
    mode,
    closed: outcomes.filter((o) => o.result.status === 'fulfilled').map((o) => o.paneId),
    failed: outcomes.filter((o) => o.result.status === 'rejected').map((o) => ({ paneId: o.paneId, error: o.result.reason?.message })),
  };
}

async function setAllCollapsed(collapsed) {
  const { folders } = await collect({ withGit: false });
  updateState((state) => {
    state.collapsed = {};
    if (collapsed) for (const folder of folders) state.collapsed[folder.path] = true;
  });
  return { collapsed, folders: folders.length };
}

async function panel(sub, arg) {
  switch (sub) {
    case 'toggle':
      return toggleSidebar();
    case 'open':
      return openSidebar();
    case 'close':
      return closeSidebar({ all: arg === 'all' });
    case 'hide':
    case 'show':
      updateState((state) => {
        state.hidden = sub === 'hide';
      });
      return { hidden: sub === 'hide' };
    case 'grow':
    case 'shrink':
      queuePanelCommand('resize', { delta: (sub === 'grow' ? 1 : -1) * (Number(arg) || 6) });
      return { queued: sub };
    case 'width':
      if (!Number(arg)) throw new Error('panel width needs a column count');
      queuePanelCommand('width', { cols: Number(arg) });
      return { queued: 'width', cols: Number(arg) };
    default:
      throw new Error(`unknown panel command "${sub}"`);
  }
}

async function gitAction(folder, action, rest) {
  const file = rest[0];
  const simple = { 'stage-all': gitApi.stageAll, 'unstage-all': gitApi.unstageAll, pull: gitApi.pull, push: gitApi.push, fetch: gitApi.fetch };
  if (simple[action]) return { action, output: await simple[action](folder) };
  if (action === 'commit') return { action, output: await gitApi.commit(folder, rest.join(' ')) };
  if (!file) throw new Error(`git-action ${action} needs a file`);
  if (action === 'stage') return { action, output: await gitApi.stage(folder, [file]) };
  if (action === 'unstage') return { action, output: await gitApi.unstage(folder, [file]) };
  if (action === 'discard') {
    const { files } = await gitApi.status(folder);
    const entry = files.find((candidate) => candidate.path === file);
    if (!entry) throw new Error(`${file} has no changes`);
    return { action, output: await gitApi.discard(folder, entry) };
  }
  throw new Error(`unknown git action "${action}"`);
}

async function main(argv) {
  const args = argv.filter((arg) => !arg.startsWith('--'));
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const [command, ...rest] = args;
  const contextCwd = () => {
    try {
      const context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || '{}');
      return context.pane?.foreground_cwd || context.pane?.cwd || null;
    } catch {
      return null;
    }
  };
  const resolve = (value) => path.resolve(value || contextCwd() || process.cwd());

  switch (command) {
    case 'snapshot':
      return snapshot();
    case 'expand-all':
      return setAllCollapsed(false);
    case 'collapse-all':
      return setAllCollapsed(true);
    case 'expand-folder':
    case 'collapse-folder':
      updateState((state) => {
        if (command === 'collapse-folder') state.collapsed[resolve(rest[0])] = true;
        else delete state.collapsed[resolve(rest[0])];
      });
      return { folder: resolve(rest[0]), collapsed: command === 'collapse-folder' };
    case 'expand-agents':
    case 'collapse-agents':
      updateState((state) => {
        state.allAgentsExpanded = command === 'expand-agents';
        state.expandedAgents = {};
      });
      return { agentsExpanded: command === 'expand-agents' };
    case 'close':
      return close(rest[0], flags.has('--yes'));
    case 'focus': {
      const { folders } = await collect({ withGit: false });
      const pane = folders.flatMap((folder) => folder.panes).find((candidate) => candidate.paneId === rest[0]);
      if (!pane) throw new Error(`pane ${rest[0]} not found`);
      await herdrApi.focusPane(pane);
      return { focused: pane.paneId };
    }
    case 'panel':
      return panel(rest[0], rest[1]);
    case 'replace':
      if (rest[0] === 'on') return replaceOn();
      if (rest[0] === 'off') return replaceOff();
      return { replace: loadState().replace };
    case 'dock':
      return ensureDock();
    case 'git':
      return herdrApi.openPluginPane('git', { placement: 'popup', width: '90%', height: '85%', env: { HERDR_FOLDERS_REPO: resolve(rest[0]) } });
    case 'confirm-close':
      if (!CLOSE_MODES[rest[0]]) throw new Error(`unknown close mode "${rest[0]}"`);
      return herdrApi.openPluginPane('confirm', { placement: 'popup', width: '70', height: '60%', env: { HERDR_FOLDERS_CLOSE_MODE: rest[0] } });
    case 'git-status': {
      const status = await gitApi.status(resolve(rest[0]));
      return { ...status, prompt: promptText(status.summary) };
    }
    case 'git-diff': {
      const { files } = await gitApi.status(resolve(rest[0]));
      const file = files.find((candidate) => candidate.path === rest[1]) || { path: rest[1], untracked: false };
      return { file: rest[1], diff: await gitApi.diff(resolve(rest[0]), file, { staged: flags.has('--staged') }) };
    }
    case 'git-action':
      return gitAction(resolve(rest[0]), rest[1], rest.slice(2));
    default:
      process.stdout.write(USAGE);
      return undefined;
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((result) => {
      if (result !== undefined) out(result);
    })
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
      process.exitCode = 1;
    });
}

module.exports = { main };
