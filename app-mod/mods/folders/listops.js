// Pure list helpers for the folders panel: live filter, manual order, avatar colour, menu sizing.

// Folders (with their panes) that match the query in name, path, pane name, command or tab. Empty query: all.
export function filterFolders(folders, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return folders;
  const hit = (s) => String(s || "").toLowerCase().includes(q);
  return folders.filter((f) => hit(f.name) || hit(f.path) || f.panes.some((p) => hit(p.name) || hit(p.command) || hit(p.tabLabel) || hit(p.shell)));
}

// Manual order wins over the sort setting: listed paths first in list order, the rest keep their order.
export function applyOrder(folders, order) {
  if (!order || !order.length) return folders;
  const rank = new Map(order.map((p, i) => [p, i]));
  return folders
    .map((f, i) => [f, i])
    .sort(([a, i], [b, j]) => (rank.has(a.path) ? rank.get(a.path) : 1e6 + i) - (rank.has(b.path) ? rank.get(b.path) : 1e6 + j))
    .map(([f]) => f);
}

// New order after moving `path` to the place of `target` (paths of the whole current list).
export function moveInOrder(paths, path, target) {
  const from = paths.indexOf(path);
  const to = paths.indexOf(target);
  if (from < 0 || to < 0 || from === to) return paths;
  const out = paths.slice();
  out.splice(from, 1);
  out.splice(to, 0, path);
  return out;
}

// Stable avatar colour token from a name.
export const AVATARS = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
export function avatarColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATARS[h % AVATARS.length];
}

// Popup height for a menu: header + rows + separators.
export function menuHeight(items) {
  return 46 + items.reduce((sum, item) => sum + (item.sep ? 9 : 26), 0);
}
