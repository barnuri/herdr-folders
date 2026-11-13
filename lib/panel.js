'use strict';

const herdrApi = require('./herdr');
const { isPluginPane } = require('./snapshot');

const SIDEBAR_SCRIPT = /bin\/sidebar\.js/;

async function findSidebars() {
  const panes = await herdrApi.listPanes();
  const infos = await Promise.all(panes.map((pane) => herdrApi.processInfo(pane.pane_id)));
  return panes.filter((_pane, i) => isPluginPane(infos[i], SIDEBAR_SCRIPT));
}

async function rightmostPane(paneId) {
  const layout = (await herdrApi.herdr(['pane', 'layout', '--pane', paneId])).layout;
  return layout.panes.reduce((best, pane) => (!best || pane.rect.x + pane.rect.width > best.rect.x + best.rect.width ? pane : best), null);
}

async function openSidebar() {
  const panes = await herdrApi.listPanes();
  const focused = panes.find((pane) => pane.focused);
  const args = ['plugin', 'pane', 'open', '--plugin', herdrApi.PLUGIN_ID, '--entrypoint', 'sidebar', '--placement', 'split', '--direction', 'right', '--no-focus'];
  if (focused) {
    const target = await rightmostPane(focused.pane_id);
    if (target) args.push('--target-pane', target.pane_id);
  }
  return herdrApi.herdr(args);
}

// Toggle the sidebar in the focused tab: close it when present, open it otherwise.
async function toggleSidebar() {
  const panes = await herdrApi.listPanes();
  const tabId = panes.find((pane) => pane.focused)?.tab_id || null;
  const existing = (await findSidebars()).filter((pane) => pane.tab_id === tabId);
  if (existing.length) {
    await Promise.all(existing.map((pane) => herdrApi.closePane(pane.pane_id)));
    return { action: 'closed', panes: existing.map((pane) => pane.pane_id) };
  }
  return { action: 'opened', result: await openSidebar() };
}

module.exports = { findSidebars, openSidebar, toggleSidebar };
