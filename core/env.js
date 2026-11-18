'use strict';

// Environment of a space, tab or pane: "default" (everything that is not orch) or "orch" (the orch space,
// and the terminals orch starts). One classification for the folders panel and the tabs-folders tab bar.
// orchSpace is settings.herdr_space of orch (default "orch"); "off" or empty means there is no orch space.

const ENVS = ['default', 'orch'];
const DEFAULT_ENV = 'default';
const ORCH_SPACE = 'orch';

function normalizeEnv(value) {
  return value === 'orch' ? 'orch' : 'default';
}

// Name of the orch space from the orch profiles settings, or null when orch has no space.
function orchSpaceName(setting) {
  if (setting === undefined || setting === null) return ORCH_SPACE;
  const name = String(setting).trim();
  return !name || name.toLowerCase() === 'off' ? null : name;
}

function spaceEnv(space, orchSpace = ORCH_SPACE) {
  return orchSpace && space && space.name === orchSpace ? 'orch' : 'default';
}

// A tab lives in its space, so it has the env of its space.
function tabEnv(space, orchSpace = ORCH_SPACE) {
  return spaceEnv(space, orchSpace);
}

// A pane is orch when its tab is in the orch space or its terminal address belongs to an orch job.
function paneEnv(pane, spaces, jobAddresses = new Set(), orchSpace = ORCH_SPACE) {
  if (jobAddresses.has(pane.terminal)) return 'orch';
  for (const space of spaces) {
    if (spaceEnv(space, orchSpace) !== 'orch') continue;
    if ((space.tabs || []).some((tab) => tab.id === pane.tab)) return 'orch';
  }
  return 'default';
}

function spacesForEnv(spaces, env, orchSpace = ORCH_SPACE) {
  return spaces.filter((space) => spaceEnv(space, orchSpace) === env);
}

// Tabs the tab bar shows for the active space. A space of the other env shows nothing, so orch tabs stay
// out of the default env. `all` is the way out when the person is in such a space anyway: show its tabs then.
function tabsForEnv(space, env, orchSpace = ORCH_SPACE, all = false) {
  if (!space) return [];
  return all || tabEnv(space, orchSpace) === env ? space.tabs || [] : [];
}

// Agents of the env: an agent belongs to the env of the space that holds its tab.
function agentsForEnv(agents, spaces, env, orchSpace = ORCH_SPACE) {
  const tabs = new Set(spacesForEnv(spaces, env, orchSpace).flatMap((space) => (space.tabs || []).map((tab) => tab.id)));
  return agents.filter((agent) => tabs.has(agent.tab));
}

function panesForEnv(panes, spaces, env, jobAddresses = new Set(), orchSpace = ORCH_SPACE) {
  return panes.filter((pane) => paneEnv(pane, spaces, jobAddresses, orchSpace) === env);
}

module.exports = { ENVS, DEFAULT_ENV, ORCH_SPACE, normalizeEnv, orchSpaceName, spaceEnv, tabEnv, paneEnv, spacesForEnv, tabsForEnv, panesForEnv, agentsForEnv };
