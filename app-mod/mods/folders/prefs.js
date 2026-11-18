// Shares ~/.local/state/herdr-folders/state.json with the TUI plugin and its CLI, so
// `node bin/folders.js grouping tree` changes the app and a setting changed in the app changes the TUI.
// Only keys that exist in the file override the layout settings.

import { home, readTextFile, writeTextFile } from "herdr";

export const PREF_KEYS = {
  grouping: "string", spacing: "string", sort: "string", collapsible: "boolean", cardBackgrounds: "boolean",
  confirmKill: "boolean", allAgentsExpanded: "boolean", view: "string", projectsTab: "boolean", env: "string", lastDefaultSpace: "string", showAppSidebar: "boolean",
};

export function stateDir() {
  return `${home()}/.local/state/herdr-folders`;
}

export function pickPrefs(parsed) {
  const out = {};
  if (!parsed || typeof parsed !== "object") return out;
  for (const [key, type] of Object.entries(PREF_KEYS)) if (typeof parsed[key] === type) out[key] = parsed[key];
  return out;
}

export async function loadPrefs() {
  try {
    const text = await readTextFile(`${stateDir()}/state.json`);
    return text ? pickPrefs(JSON.parse(text)) : {};
  } catch {
    return {};
  }
}

// Writes `patch` into state.json, keeping every other key (collapsed, width, ...). The write is refused
// when the file changed since it was read; the next call then reads again.
export async function savePrefs(patch) {
  const file = `${stateDir()}/state.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const text = await readTextFile(file);
      const next = { ...(text ? JSON.parse(text) : {}), ...patch };
      await writeTextFile(file, `${JSON.stringify(next, null, 2)}\n`, text);
      return true;
    } catch (error) {
      console.log(`folders: saving state.json failed: ${error}`);
    }
  }
  return false;
}

export async function readCache() {
  try {
    const text = await readTextFile(`${stateDir()}/projects-cache.json`);
    const list = text ? JSON.parse(text) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
