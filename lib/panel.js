'use strict';

const fs = require('node:fs');
const path = require('node:path');

const herdrApi = require('./herdr');
const herdrConfig = require('./herdr-config');
const { isPluginPane } = require('./snapshot');
const { stateDir, loadState, updateState } = require('./state');

const SIDEBAR_SCRIPT = /bin\/sidebar\.js/;
const LOCK_STALE_MS = 20000;

async function withLock(fn) {
  const lock = path.join(stateDir(), 'dock.lock');
  fs.mkdirSync(stateDir(), { recursive: true });
  try {
    fs.mkdirSync(lock);
  } catch {
    const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs || 0);
    if (age < LOCK_STALE_MS) return { skipped: 'another dock is running' };
    fs.rmdirSync(lock);
    fs.mkdirSync(lock);
  }
  try {
    return await fn();
  } finally {
    fs.rmdirSync(lock);
  }
}

async function sidebarPanes(panes) {
  const infos = await Promise.all(panes.map((pane) => herdrApi.processInfo(pane.pane_id)));
  return panes.filter((_pane, i) => isPluginPane(infos[i], SIDEBAR_SCRIPT));
}

async function findSidebars() {
  return sidebarPanes(await herdrApi.listPanes());
}

async function focusedTab() {
  const panes = await herdrApi.listPanes();
  const focused = panes.find((pane) => pane.focused);
  return { panes, focused, tabId: focused?.tab_id || null };
}

// Open the sidebar at the left edge of the focused tab: split the leftmost pane, then swap
// the two so the sidebar takes the left slot. herdr can only split right or down.
async function dockLeft({ focused }) {
  const layout = (await herdrApi.herdr(['pane', 'layout', '--pane', focused.pane_id])).layout;
  if (layout.zoomed) return { skipped: 'tab is zoomed' };
  const leftmost = layout.panes.reduce((best, pane) => (!best || pane.rect.x < best.rect.x || (pane.rect.x === best.rect.x && pane.rect.y < best.rect.y) ? pane : best), null);
  const opened = await herdrApi.herdr([
    'plugin', 'pane', 'open', '--plugin', herdrApi.PLUGIN_ID, '--entrypoint', 'sidebar',
    '--placement', 'split', '--direction', 'right', '--target-pane', leftmost.pane_id, '--no-focus',
  ]);
  const paneId = opened.plugin_pane.pane.pane_id;
  await herdrApi.herdr(['pane', 'swap', '--source-pane', paneId, '--target-pane', leftmost.pane_id]);
  // swap moves focus to the sidebar; step right to give it back to the pane next to it
  await herdrApi.herdr(['pane', 'focus', '--direction', 'right', '--pane', paneId]).catch(() => {});
  return { opened: paneId, tab: focused.tab_id };
}

// Event hook: with replace mode on, make sure the focused tab has a sidebar.
async function ensureDock() {
  if (!loadState().replace) return { skipped: 'replace mode is off' };
  return withLock(async () => {
    const ctx = await focusedTab();
    if (!ctx.focused) return { skipped: 'no focused pane' };
    if (loadState().snoozedTabs[ctx.tabId]) return { skipped: 'closed by the user in this tab' };
    const tabPanes = ctx.panes.filter((pane) => pane.tab_id === ctx.tabId);
    if ((await sidebarPanes(tabPanes)).length) return { skipped: 'already docked' };
    if (tabPanes.length === 0) return { skipped: 'empty tab' };
    return dockLeft(ctx);
  });
}

async function openSidebar() {
  const ctx = await focusedTab();
  updateState((state) => {
    delete state.snoozedTabs[ctx.tabId];
  });
  const existing = await sidebarPanes(ctx.panes.filter((pane) => pane.tab_id === ctx.tabId));
  if (existing.length) return { action: 'already-open', pane: existing[0].pane_id };
  return { action: 'opened', ...(await dockLeft(ctx)) };
}

async function closeSidebar({ all = false } = {}) {
  const ctx = await focusedTab();
  const panes = (await findSidebars()).filter((pane) => all || pane.tab_id === ctx.tabId);
  await Promise.allSettled(panes.map((pane) => herdrApi.closePane(pane.pane_id)));
  if (!all) {
    updateState((state) => {
      state.snoozedTabs[ctx.tabId] = true;
    });
  }
  return { action: 'closed', panes: panes.map((pane) => pane.pane_id) };
}

async function toggleSidebar() {
  const ctx = await focusedTab();
  const existing = await sidebarPanes(ctx.panes.filter((pane) => pane.tab_id === ctx.tabId));
  return existing.length ? closeSidebar() : openSidebar();
}

async function reloadConfig() {
  await herdrApi.herdr(['server', 'reload-config']).catch(() => {});
}

// Replace herdr's sidebar: hide it through config and dock this panel on the left of every tab.
async function replaceOn() {
  const before = herdrConfig.read();
  herdrConfig.write(herdrConfig.apply(before));
  updateState((state) => {
    state.replace = true;
    state.snoozedTabs = {};
  });
  await reloadConfig();
  const docked = await ensureDock();
  const key = herdrConfig.toggleSidebarKey(before);
  return { replace: true, config: herdrConfig.configPath(), docked, hint: `if herdr's sidebar is still expanded, press ${key} once; new clients start with it hidden` };
}

// Go back to herdr's own sidebar: restore the config and close every docked panel.
async function replaceOff() {
  herdrConfig.write(herdrConfig.revert(herdrConfig.read()));
  updateState((state) => {
    state.replace = false;
  });
  await reloadConfig();
  const closed = await closeSidebar({ all: true });
  const key = herdrConfig.toggleSidebarKey(herdrConfig.read());
  return { replace: false, closed: closed.panes, hint: `herdr's sidebar is back as a rail; click it or press ${key} to expand it` };
}

module.exports = { findSidebars, ensureDock, openSidebar, closeSidebar, toggleSidebar, replaceOn, replaceOff };
