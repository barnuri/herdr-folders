// GENERATED from core/ by app-mod/scripts/sync-core.js. Do not edit.
const basename = (p) => p.split('/').filter(Boolean).pop() || '';

import { tokenSummary } from './orch.js';

const STATUS_RANK = { blocked: 5, working: 4, orch: 3.5, done: 3, idle: 2, unknown: 1 };
const IDLE_AGENT_STATUSES = new Set(['idle', 'done']);

function isShellBusy(info) {
  if (!info || !info.shell_pid) {
    return false;
  }
  return info.foreground_process_group_id !== info.shell_pid;
}

function foregroundCommand(info) {
  if (!info || !isShellBusy(info)) {
    return null;
  }
  const leader = (info.foreground_processes || []).find((proc) => proc.pid === info.foreground_process_group_id);
  const proc = leader || (info.foreground_processes || [])[0];
  if (!proc) return null;
  // "/usr/bin/python3 -m http.server" reads better as "python3 -m http.server"
  const [first, ...rest] = (proc.cmdline || proc.name).split(' ');
  return [basename(first), ...rest].join(' ');
}

// "-zsh" (login shell) -> "zsh"
function shellName(info) {
  const proc = (info?.foreground_processes || []).find((candidate) => candidate.pid === info.shell_pid);
  const name = proc?.name || (proc?.argv0 || '').replace(/^-/, '');
  return name ? name.replace(/^-/, '') : null;
}

function rollupStatus(statuses) {
  let best = null;
  for (const status of statuses) {
    if (!best || (STATUS_RANK[status] || 0) > (STATUS_RANK[best] || 0)) {
      best = status;
    }
  }
  return best;
}

// One row per pane: a pane hosting an agent is an agent row only, never also a terminal row.
// True when `cwd` is inside another installed herdr plugin's folder.
function isPluginRootPath(cwd, pluginRoots) {
  return pluginRoots.some((root) => cwd === root || cwd.startsWith(`${root}/`));
}

function buildFolders({ panes, agents, processInfo = {}, roots = {}, tabs = [], excludePaneIds = new Set(), pluginRoots = [], orchLookup = () => null }) {
  const agentByPane = new Map(agents.map((agent) => [agent.pane_id, agent]));
  const tabLabel = new Map(tabs.map((tab) => [tab.tab_id, tab.label]));
  const folders = new Map();

  const folderOf = (pane) => {
    const cwd = pane.foreground_cwd || pane.cwd || '';
    return roots[cwd] || cwd;
  };
  // herdr labels plugin panes with their manifest title; a plain shell in a plugin's repo has none.
  const isPluginPane = (pane) => Boolean(pane.label) && isPluginRootPath(pane.foreground_cwd || pane.cwd || '', pluginRoots);
  for (const pane of panes) {
    if (excludePaneIds.has(pane.pane_id)) {
      continue;
    }
    const cwd = pane.foreground_cwd || pane.cwd || '';
    // Panes of other herdr plugins (mod views, logs) are tools, not work: leave them out.
    if (isPluginPane(pane)) continue;
    const folderPath = folderOf(pane);
    if (!folders.has(folderPath)) {
      folders.set(folderPath, { path: folderPath, name: basename(folderPath) || folderPath, isRepo: Boolean(roots[cwd]), panes: [] });
    }
    const agent = agentByPane.get(pane.pane_id);
    const info = processInfo[pane.pane_id];
    const base = {
      paneId: pane.pane_id,
      tabId: pane.tab_id,
      workspaceId: pane.workspace_id,
      tabLabel: tabLabel.get(pane.tab_id) || null,
      cwd,
      title: pane.terminal_title_stripped || pane.terminal_title || '',
      focused: Boolean(pane.focused),
    };
    if (agent) {
      const rawStatus = agent.agent_status || 'unknown';
      // An idle agent that coordinates running orch work is busy, not idle.
      const orch = IDLE_AGENT_STATUSES.has(rawStatus) ? orchLookup(agent.agent_session?.value) || tokenSummary(agent.tokens) : null;
      folders.get(folderPath).panes.push({
        ...base,
        kind: 'agent',
        agent: agent.agent,
        name: agent.name || null,
        status: orch ? 'orch' : rawStatus,
        rawStatus,
        ...(orch ? { orchSummary: orch } : {}),
      });
    } else {
      const busy = isShellBusy(info);
      folders.get(folderPath).panes.push({
        ...base,
        kind: 'terminal',
        busy,
        command: foregroundCommand(info),
        shell: shellName(info),
        status: busy ? 'running' : 'shell',
      });
    }
  }

  return [...folders.values()]
    .map((folder) => ({
      ...folder,
      status: rollupStatus(folder.panes.filter((pane) => pane.kind === 'agent').map((pane) => pane.status)),
      agentCount: folder.panes.filter((pane) => pane.kind === 'agent').length,
      terminalCount: folder.panes.filter((pane) => pane.kind !== 'agent').length,
    }))
;
}

const SORTS = ['opened', 'status', 'name'];

// Folder order for the panel. `opened` (default) keeps herdr's order: workspaces, then tabs, then
// panes, as they were opened. `status` puts folders with busy agents first; `name` is A to Z.
function sortFolders(folders, mode = 'opened') {
  if (mode === 'opened' || !SORTS.includes(mode)) return folders;
  const agentsFirst = (panes) => [...panes].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'agent' ? -1 : 1));
  const byName = (a, b) => a.name.localeCompare(b.name);
  const order = mode === 'status' ? (a, b) => (STATUS_RANK[b.status] || 0) - (STATUS_RANK[a.status] || 0) || byName(a, b) : byName;
  return [...folders].map((folder) => ({ ...folder, panes: agentsFirst(folder.panes) })).sort(order);
}

// Agent titles look like "OC | session title"; shells set "Current Folder: ~/x".
function displayTitle(pane) {
  const title = (pane.title || '').trim();
  if (!title || /^Current Folder:/.test(title)) return '';
  const clean = title.replace(/^[A-Z]{1,4} \| /, '');
  return pane.agent && clean.toLowerCase() === pane.agent.toLowerCase() ? '' : clean;
}

const isIdleShell = (pane) => pane.kind === 'terminal' && !pane.busy;
const isIdleAgent = (pane) => pane.kind === 'agent' && IDLE_AGENT_STATUSES.has(pane.status);

const CLOSE_MODES = {
  'empty-folders': (folders) => folders.filter((folder) => folder.panes.every(isIdleShell)).flatMap((folder) => folder.panes),
  'idle-agents-and-empty-folders': (folders) =>
    folders.flatMap((folder) => {
      if (folder.panes.every((pane) => isIdleShell(pane) || isIdleAgent(pane))) {
        return folder.panes;
      }
      return folder.panes.filter(isIdleAgent);
    }),
  terminals: (folders) => folders.flatMap((folder) => folder.panes.filter((pane) => pane.kind === 'terminal')),
  all: (folders) => folders.flatMap((folder) => folder.panes),
};

function planClose(folders, mode, { keepPaneIds = new Set() } = {}) {
  const select = CLOSE_MODES[mode];
  if (!select) {
    throw new Error(`unknown close mode "${mode}" (use one of: ${Object.keys(CLOSE_MODES).join(', ')})`);
  }
  return select(folders).filter((pane) => !keepPaneIds.has(pane.paneId));
}

// Nest folder groups by path. A directory with no panes of its own and a single child is merged
// into that child's label ("sandbox/private"), like compact folders in VS Code.
function buildTree(folders) {
  const root = { segment: '', children: new Map(), folder: null };
  const split = (p) => p.split('/').filter(Boolean);
  for (const folder of folders) {
    let node = root;
    for (const segment of split(folder.path)) {
      if (!node.children.has(segment)) node.children.set(segment, { segment, children: new Map(), folder: null });
      node = node.children.get(segment);
    }
    node.folder = folder;
  }
  const convert = (node, prefix) => {
    let name = node.segment;
    let current = node;
    let full = prefix ? `${prefix}/${node.segment}` : `/${node.segment}`;
    while (!current.folder && current.children.size === 1) {
      const [only] = current.children.values();
      if (only.folder) break;
      current = only;
      name = `${name}/${only.segment}`;
      full = `${full}/${only.segment}`;
    }
    const children = [...current.children.values()]
      .map((child) => convert(child, full))
      .sort((a, b) => a.name.localeCompare(b.name));
    return current.folder
      ? { type: 'folder', name: current.folder.name, path: full, folder: current.folder, children }
      : { type: 'dir', name, path: full, children };
  };
  // Skip the shared ancestors ("/", "Users", ...) down to the deepest directory that every folder
  // shares, and show that one as the top node.
  let top = root;
  let topPath = '';
  for (;;) {
    if (top.folder || top.children.size !== 1) break;
    const [only] = top.children.values();
    if (only.folder || only.children.size !== 1) break;
    top = only;
    topPath = `${topPath}/${only.segment}`;
  }
  if (top.children.size === 1 && !top.folder) {
    const [only] = top.children.values();
    return [convert(only, topPath)];
  }
  return [...top.children.values()].map((child) => convert(child, topPath)).sort((a, b) => a.name.localeCompare(b.name));
}

// State keys of every directory node, for collapse-all in tree mode.
function dirKeys(nodes) {
  return nodes.flatMap((node) => [...(node.type === 'dir' ? [`dir:${node.path}`] : []), ...dirKeys(node.children)]);
}

export { SORTS, sortFolders, isPluginRootPath, STATUS_RANK, CLOSE_MODES, isShellBusy, foregroundCommand, rollupStatus, buildFolders, buildTree, dirKeys, displayTitle, planClose };
