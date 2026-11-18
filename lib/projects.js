'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const herdrApi = require('./herdr');
const { stateDir } = require('./state');
const { fuzzyScore, filterProjects } = require('../core/fuzzy');

const PM_PLUGIN_ID = 'barnuri.project-manager';
const CACHE_FILE = 'projects-cache.json';

// Find the herdr-project-manager plugin and its config dir. Returns null when it is not installed.
function locateProjectManager() {
  try {
    const plugins = herdrApi.herdrSync(['plugin', 'list', '--json']).plugins || [];
    const plugin = plugins.find((candidate) => candidate.plugin_id === PM_PLUGIN_ID);
    if (!plugin) return null;
    const out = spawnSync(process.env.HERDR_BIN_PATH || 'herdr', ['plugin', 'config-dir', PM_PLUGIN_ID], { encoding: 'utf8' });
    const configDir = (out.stdout || '').trim();
    return configDir ? { root: plugin.plugin_root, enabled: plugin.enabled, configDir } : null;
  } catch {
    return null;
  }
}

function cachePath() {
  return path.join(stateDir(), CACHE_FILE);
}

function loadCachedProjects() {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Discover with project-manager's own code and config, so both lists stay identical.
async function discoverProjects(pm) {
  const previous = process.env.HERDR_PLUGIN_CONFIG_DIR;
  process.env.HERDR_PLUGIN_CONFIG_DIR = pm.configDir;
  try {
    const { loadConfig } = require(path.join(pm.root, 'lib', 'config.js'));
    const discover = require(path.join(pm.root, 'lib', 'discover.js'));
    const config = loadConfig();
    const found = await discover.discoverProjects(config.globs, config.excludes);
    // realpath, so /tmp/x matches the /private/tmp/x that git reports for an open folder
    const real = (p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    };
    const projects = discover.mergeProjects(config.projects, found).map(({ name, path: projectPath }) => ({ name, path: real(projectPath) }));
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(cachePath(), `${JSON.stringify(projects)}\n`, 'utf8');
    return projects;
  } finally {
    if (previous === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    else process.env.HERDR_PLUGIN_CONFIG_DIR = previous;
  }
}

// Open a project the way project-manager does: a new workspace (default) or a tab, labelled by name.
function openProject(project, mode = 'workspace') {
  const kind = mode === 'tab' ? 'tab' : 'workspace';
  return herdrApi.herdr([kind, 'create', '--cwd', project.path, '--label', project.name, '--focus']);
}

module.exports = { PM_PLUGIN_ID, locateProjectManager, loadCachedProjects, discoverProjects, fuzzyScore, filterProjects, openProject };
