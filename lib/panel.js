'use strict';

const fs = require('node:fs');
const path = require('node:path');

const herdrApi = require('./herdr');
const herdrConfig = require('./herdr-config');
const { PLUGIN_ROOT } = require('./snapshot');
const { stateDir, loadState, updateState } = require('./state');

const SIDEBAR_LABEL = 'Folders';
const SLOT_LABEL = 'Folders slot';
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

// The panel is the pane herdr labels with our manifest title and starts in our plugin folder.
// Reading that from `pane list` costs no extra herdr calls, so a tab switch moves the panel fast.
const ours = (pane, label) => pane.label === label && (pane.cwd === PLUGIN_ROOT || pane.foreground_cwd === PLUGIN_ROOT);

async function sidebarPanes(panes) {
  return panes.filter((pane) => ours(pane, SIDEBAR_LABEL));
}

function slotPanes(panes) {
  return panes.filter((pane) => ours(pane, SLOT_LABEL));
}

async function findSidebars() {
  return sidebarPanes(await herdrApi.listPanes());
}

async function focusedTab() {
  const panes = await herdrApi.listPanes();
  const focused = panes.find((pane) => pane.focused);
  return { panes, focused, tabId: focused?.tab_id || null };
}

function leftmostPane(layout) {
  return layout.panes.reduce((best, pane) => (!best || pane.rect.x < best.rect.x || (pane.rect.x === best.rect.x && pane.rect.y < best.rect.y) ? pane : best), null);
}

// Put `paneId` (just opened or moved into the tab) at the left edge: herdr can only split right
// or down, so swap it with the leftmost pane, then hand focus back to the pane beside it.
async function settleLeft(paneId, leftmost, tabHasFocus = true) {
  await herdrApi.herdr(['pane', 'swap', '--source-pane', paneId, '--target-pane', leftmost.pane_id]);
  // swap focuses the moved pane; give focus back, but only in the tab the user is in
  if (tabHasFocus) await herdrApi.herdr(['pane', 'focus', '--direction', 'right', '--pane', paneId]).catch(() => {});
}

// Open a new panel at the left edge of the focused tab.
async function dockLeft({ focused }, entrypoint = 'sidebar') {
  const layout = (await herdrApi.herdr(['pane', 'layout', '--pane', focused.pane_id])).layout;
  if (layout.zoomed) return { skipped: 'tab is zoomed' };
  const leftmost = leftmostPane(layout);
  const opened = await herdrApi.herdr([
    'plugin', 'pane', 'open', '--plugin', herdrApi.PLUGIN_ID, '--entrypoint', entrypoint,
    '--placement', 'split', '--direction', 'right', '--target-pane', leftmost.pane_id, '--no-focus',
  ]);
  const paneId = opened.plugin_pane.pane.pane_id;
  await settleLeft(paneId, leftmost, focused.focused);
  return { opened: paneId, tab: focused.tab_id };
}

// Fast path: the tab already holds a slot at the left. Move the panel in right beside it, then
// close the slot; the panel takes the slot's space and width, so nothing else moves.
async function moveIntoSlot(sidebar, slot) {
  const moved = await herdrApi.herdr([
    'pane', 'move', sidebar.pane_id, '--tab', slot.tab_id, '--split', 'right', '--target-pane', slot.pane_id, '--no-focus',
  ]);
  await herdrApi.closePane(slot.pane_id);
  return { moved: moved.move_result.pane.pane_id, from: sidebar.pane_id, tab: slot.tab_id, via: 'slot' };
}

// Give every tab without the panel a slot, and close slots that are orphaned or doubled, so the
// next tab switch takes the fast path. Runs after the switch, so it never delays it.
async function prepareSlots() {
  const panes = await herdrApi.listPanes();
  const tabs = new Map();
  for (const pane of panes) {
    if (!tabs.has(pane.tab_id)) tabs.set(pane.tab_id, []);
    tabs.get(pane.tab_id).push(pane);
  }
  const done = [];
  for (const [tabId, tabPanes] of tabs) {
    const slots = slotPanes(tabPanes);
    const panel = tabPanes.some((pane) => ours(pane, SIDEBAR_LABEL));
    const work = tabPanes.filter((pane) => !ours(pane, SLOT_LABEL) && !ours(pane, SIDEBAR_LABEL));
    const extra = panel || work.length === 0 ? slots : slots.slice(1);
    for (const slot of extra) {
      await herdrApi.closePane(slot.pane_id).catch(() => {});
      done.push({ closed: slot.pane_id });
    }
    if (panel || slots.length || work.length === 0 || loadState().snoozedTabs[tabId]) continue;
    const result = await dockLeft({ focused: work[0] }, 'slot').catch((error) => ({ error: error.message }));
    done.push({ tab: tabId, ...result });
  }
  // herdr focuses a swapped pane even in a background tab; put the user back where they were.
  const before = panes.find((pane) => pane.focused);
  if (before && done.some((entry) => entry.opened)) {
    const now = (await herdrApi.listPanes()).find((pane) => pane.focused);
    if (now?.pane_id !== before.pane_id) {
      await herdrApi.herdr(['workspace', 'focus', before.workspace_id]).catch(() => {});
      await herdrApi.herdr(['tab', 'focus', before.tab_id]).catch(() => {});
    }
  }
  return done;
}

// One panel for every tab, like herdr's own sidebar: move the running panel into the focused
// tab instead of starting another. Its state, scroll and selection come along.
async function moveLeft(sidebar, { focused }) {
  const layout = (await herdrApi.herdr(['pane', 'layout', '--pane', focused.pane_id])).layout;
  if (layout.zoomed) return { skipped: 'tab is zoomed' };
  const leftmost = leftmostPane(layout);
  const moved = await herdrApi.herdr([
    'pane', 'move', sidebar.pane_id, '--tab', focused.tab_id, '--split', 'right', '--target-pane', leftmost.pane_id, '--no-focus',
  ]);
  const paneId = moved.move_result.pane.pane_id;
  await settleLeft(paneId, leftmost);
  return { moved: paneId, from: sidebar.pane_id, tab: focused.tab_id };
}

// Event hook: with replace mode on, bring the one panel to the focused tab.
async function ensureDock() {
  // Wake the panel: it polls slowly while its tab is hidden.
  updateState((state) => {
    state.focusSeq = Date.now();
  });
  if (!loadState().replace) return { skipped: 'replace mode is off' };
  return withLock(async () => {
    const ctx = await focusedTab();
    if (!ctx.focused) return { skipped: 'no focused pane' };
    if (loadState().snoozedTabs[ctx.tabId]) return { skipped: 'closed by the user in this tab' };
    const sidebars = await sidebarPanes(ctx.panes);
    const here = sidebars.find((pane) => pane.tab_id === ctx.tabId);
    // Older versions ran one panel per tab: keep one and close the rest.
    const keep = here || sidebars[0];
    await Promise.allSettled(sidebars.filter((pane) => pane !== keep).map((pane) => herdrApi.closePane(pane.pane_id)));
    if (here) return { skipped: 'already here', prepared: await prepareSlots() };
    const slot = slotPanes(ctx.panes).find((pane) => pane.tab_id === ctx.tabId);
    let result;
    if (keep && slot) result = await moveIntoSlot(keep, slot);
    else if (keep) result = await moveLeft(keep, ctx);
    else result = await dockLeft(ctx);
    return { ...result, prepared: await prepareSlots() };
  });
}

async function openSidebar() {
  const ctx = await focusedTab();
  updateState((state) => {
    delete state.snoozedTabs[ctx.tabId];
  });
  const sidebars = await sidebarPanes(ctx.panes);
  const here = sidebars.find((pane) => pane.tab_id === ctx.tabId);
  if (here) return { action: 'already-open', pane: here.pane_id };
  return { action: sidebars.length ? 'moved' : 'opened', ...(sidebars.length ? await moveLeft(sidebars[0], ctx) : await dockLeft(ctx)) };
}

async function closeSidebar({ all = false } = {}) {
  const ctx = await focusedTab();
  const panes = [...(await findSidebars()), ...(all ? slotPanes(ctx.panes) : [])].filter((pane) => all || pane.tab_id === ctx.tabId);
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

module.exports = { prepareSlots, findSidebars, ensureDock, openSidebar, closeSidebar, toggleSidebar, replaceOn, replaceOff };
