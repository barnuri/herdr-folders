// Settings of the folders mod. Same names and defaults as the TUI plugin's state.json
// (lib/state.js). Values come from the layout block props: { "mod": "folders", "props": { "settings": {...} } }.
// A key that is missing or has the wrong type falls back to its default. Hand-written, dependency-free.

export const DEFAULTS = {
  width: 40, // columns in the TUI. The app block is sized in px by the layout (see COLUMN_PX).
  grouping: "folder", // "folder" | "tree"
  spacing: "comfortable", // "comfortable" | "compact"
  sort: "opened", // "opened" | "status" | "name"
  cardBackgrounds: true,
  confirmKill: false,
  collapsible: false, // off: no chevrons, every folder stays open, a folder click focuses its first pane
  collapsed: {}, // folder path -> true
  expandedAgents: {}, // pane id -> true
  allAgentsExpanded: false,
  showAppSidebar: true, // the app's own spaces and agents sidebar (layout block "sidebar")
  showOrch: false, // orch job terminals in the folder groups (off: one collapsed Orch row)
};

// Width of one TUI column in px at the app's 14 px font. The layout block px is width * COLUMN_PX.
export const COLUMN_PX = 8.4;

const ENUMS = { grouping: ["folder", "tree"], spacing: ["comfortable", "compact"], sort: ["opened", "status", "name"] };

export function readSettings(props) {
  const given = props && typeof props === "object" && props.settings && typeof props.settings === "object" ? props.settings : {};
  const out = { ...DEFAULTS };
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = given[key];
    if (value === undefined) continue;
    if (ENUMS[key]) out[key] = ENUMS[key].includes(value) ? value : fallback;
    else if (typeof value === typeof fallback && (typeof value !== "object" || value !== null)) out[key] = value;
  }
  return out;
}
