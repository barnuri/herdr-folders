'use strict';

const { execFile, spawnSync } = require('node:child_process');

const PLUGIN_ID = process.env.HERDR_PLUGIN_ID || 'barnuri.folders';

function binary() {
  return process.env.HERDR_BIN_PATH || 'herdr';
}

function parseEnvelope(args, stdout) {
  if (!stdout || !stdout.trim()) {
    return null;
  }
  try {
    return JSON.parse(stdout).result;
  } catch {
    throw new Error(`herdr ${args.join(' ')} did not print JSON: ${stdout.trim().slice(0, 200)}`);
  }
}

function herdrSync(args) {
  const child = spawnSync(binary(), args, { encoding: 'utf8' });
  if (child.error) {
    throw new Error(`failed to spawn herdr: ${child.error.message}`);
  }
  if (child.status !== 0) {
    throw new Error(`herdr ${args.join(' ')} exited ${child.status}: ${(child.stderr || '').trim()}`);
  }
  return parseEnvelope(args, child.stdout);
}

function herdr(args, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(binary(), args, { encoding: 'utf8', timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`herdr ${args.join(' ')} failed: ${(stderr || error.message).trim()}`));
        return;
      }
      try {
        resolve(parseEnvelope(args, stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

async function listPanes() {
  return (await herdr(['pane', 'list'])).panes || [];
}

async function listAgents() {
  return (await herdr(['agent', 'list'])).agents || [];
}

async function listTabs() {
  return (await herdr(['tab', 'list'])).tabs || [];
}

async function processInfo(paneId) {
  try {
    return (await herdr(['pane', 'process-info', '--pane', paneId])).process_info;
  } catch {
    return null;
  }
}

function closePane(paneId) {
  return herdr(['pane', 'close', paneId]);
}

async function focusPane(pane) {
  if (pane.kind === 'agent') {
    try {
      await herdr(['agent', 'focus', pane.paneId]);
      return;
    } catch {
      // fall back to focusing the tab
    }
  }
  await herdr(['workspace', 'focus', pane.workspaceId]);
  await herdr(['tab', 'focus', pane.tabId]);
}

function resizePane(paneId, direction, amount) {
  return herdr(['pane', 'resize', '--pane', paneId, '--direction', direction, '--amount', String(amount)]);
}

function openPluginPane(entrypoint, { placement = 'split', direction, width, height, env = {}, cwd, focus = true } = {}) {
  const args = ['plugin', 'pane', 'open', '--plugin', PLUGIN_ID, '--entrypoint', entrypoint, '--placement', placement];
  if (direction) args.push('--direction', direction);
  if (width) args.push('--width', String(width));
  if (height) args.push('--height', String(height));
  if (cwd) args.push('--cwd', cwd);
  for (const [key, value] of Object.entries(env)) {
    args.push('--env', `${key}=${value}`);
  }
  args.push(focus ? '--focus' : '--no-focus');
  return herdr(args);
}

function closePluginPane(paneId) {
  return herdr(['plugin', 'pane', 'close', paneId]);
}

module.exports = {
  PLUGIN_ID,
  herdr,
  herdrSync,
  listPanes,
  listAgents,
  listTabs,
  processInfo,
  closePane,
  focusPane,
  resizePane,
  openPluginPane,
  closePluginPane,
};
