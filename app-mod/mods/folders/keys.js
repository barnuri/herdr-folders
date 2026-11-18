// Keyboard table of the folders panel. Same keys as the TUI sidebar (README "Sidebar keys").
// Pure and dependency-free, so node tests it (tests/folders-keys.test.js).

const BASE = {
  j: "down", k: "up", down: "down", up: "up", pagedown: "page-down", pageup: "page-up",
  enter: "activate", " ": "toggle", space: "toggle", right: "toggle", left: "toggle",
  g: "git", e: "expand-all", c: "collapse-all", a: "agents", v: "grouping", o: "sort", s: "spacing",
  n: "new-tab", "?": "actions", m: "actions", x: "close-menu", "[": "narrow", "]": "widen",
  R: "restore", h: "hide", r: "refresh", tab: "switch-view", escape: "cancel",
};

// Rows of the keyboard table, for the actions list and the docs: [key label, action, what it does].
export const KEY_ROWS = [
  ["j/k, arrows", "down", "move"],
  ["enter", "activate", "focus the pane, or toggle the folder"],
  ["space, left/right", "toggle", "toggle the folder or the agent details"],
  ["g", "git", "git changes for the folder"],
  ["e / c / a", "expand-all", "expand all / collapse all / toggle all agents"],
  ["x, then 1-4", "close-menu", "bulk close menu"],
  ["[ / ]", "narrow", "narrow / widen"],
  ["h", "hide", "hide to a strip / show"],
  ["tab", "switch-view", "switch between the Folders and Projects tabs"],
  ["? / gear", "actions", "all actions"],
  ["v", "grouping", "flat or tree grouping"],
  ["s", "spacing", "two-row or one-row items"],
  ["o", "sort", "next folder order"],
  ["n", "new-tab", "new tab in the selected folder"],
  ["R", "restore", "restore the app's own sidebar"],
];

// One key press to one action name, or null. `ch` is the typed character (or the key name),
// `ctrl` true with ctrl held. ctx: { confirm, closeMenu, projects }.
export function actionForKey(ch, ctrl, ctx = {}) {
  if (ctx.confirm) {
    if (ch === "y" || ch === "enter") return "confirm";
    if (ch === "n" || ch === "escape" || ch === "q") return "cancel";
    return null;
  }
  if (ctx.projects) {
    if (ctrl && ch === "t") return "project-tab";
    if (ctrl && ch === "r") return "project-rescan";
    if (ch === "enter") return "project-open";
    if (ch === "down" || ch === "up") return ch;
    if (ch === "tab") return "switch-view";
    if (ch === "escape") return "filter-clear";
    if (ch === "backspace") return "filter-back";
    if (!ctrl && ch.length === 1) return `filter:${ch}`;
    return null;
  }
  if (ctrl) return null;
  if (ctx.closeMenu && /^[1-4]$/.test(ch)) return `close-${ch}`;
  return BASE[ch] || null;
}

// What the keys, the gear list and the commands share: next value of a cycling setting.
export const SORTS = ["opened", "status", "name"];
export function nextSort(current) {
  return SORTS[(SORTS.indexOf(current) + 1) % SORTS.length];
}
