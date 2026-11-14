'use strict';

const fs = require('node:fs');
const path = require('node:path');

const herdrApi = require('./herdr');
const gitApi = require('./git');
const { buildFolders } = require('./model');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const ROOT_CACHE_TTL_MS = 60000;

const rootCache = new Map();

async function cachedRepoRoot(cwd) {
  const hit = rootCache.get(cwd);
  if (hit && Date.now() - hit.at < ROOT_CACHE_TTL_MS) {
    return hit.root;
  }
  const root = fs.existsSync(cwd) ? await gitApi.repoRoot(cwd) : null;
  rootCache.set(cwd, { root, at: Date.now() });
  return root;
}

const PANEL_SCRIPT = /bin\/(sidebar|slot|git-panel|confirm)\.js/;

// A pane whose foreground process runs one of this plugin's panel scripts is our own panel.
// herdr starts manifest commands with relative paths, so the process cwd identifies the plugin.
function isPluginPane(info, script = PANEL_SCRIPT) {
  return (info?.foreground_processes || []).some((proc) => {
    const cmdline = proc.cmdline || '';
    if (!script.test(cmdline)) return false;
    return cmdline.includes(PLUGIN_ROOT) || (proc.cwd || '') === PLUGIN_ROOT;
  });
}

let pluginRootsCache = { at: 0, roots: [] };

// Roots of the other installed herdr plugins, refreshed once a minute.
async function pluginRoots() {
  if (Date.now() - pluginRootsCache.at < ROOT_CACHE_TTL_MS) return pluginRootsCache.roots;
  const result = await herdrApi.herdr(['plugin', 'list', '--json']).catch(() => null);
  const roots = (result?.plugins || []).map((plugin) => plugin.plugin_root).filter((root) => root && root !== PLUGIN_ROOT);
  pluginRootsCache = { at: Date.now(), roots };
  return roots;
}

async function collect({ withGit = true, excludePaneIds = [] } = {}) {
  const [panes, agents, tabs, plugins] = await Promise.all([herdrApi.listPanes(), herdrApi.listAgents(), herdrApi.listTabs(), pluginRoots()]);
  const infos = await Promise.all(panes.map((pane) => herdrApi.processInfo(pane.pane_id)));
  const processInfo = {};
  const exclude = new Set(excludePaneIds);
  panes.forEach((pane, i) => {
    processInfo[pane.pane_id] = infos[i];
    if (isPluginPane(infos[i])) {
      exclude.add(pane.pane_id);
    }
  });

  const cwds = [...new Set(panes.map((pane) => pane.foreground_cwd || pane.cwd).filter(Boolean))];
  const roots = {};
  await Promise.all(
    cwds.map(async (cwd) => {
      const root = await cachedRepoRoot(cwd);
      if (root) roots[cwd] = root;
    })
  );

  const folders = buildFolders({ panes, agents, processInfo, roots, tabs, excludePaneIds: exclude, pluginRoots: plugins });
  if (withGit) {
    await Promise.all(
      folders.map(async (folder) => {
        if (!folder.isRepo) return;
        try {
          folder.git = (await gitApi.status(folder.path)).summary;
        } catch (error) {
          folder.git = { error: error.message };
        }
      })
    );
  }
  return { folders, excluded: [...exclude] };
}

module.exports = { collect, isPluginPane, PLUGIN_ROOT };
