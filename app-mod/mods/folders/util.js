// Pure helpers for the folders mod: plural labels, the refresh guard, the repo-root cycle and chip contrast.
// Hand-written and dependency-free, so node can test it (tests/folders-util.test.js).

export const MIN_CONTRAST = 4.5;
export const ROOT_RESET_CYCLES = 20;

// "1 agent", "2 agents", "0 terminals".
export function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// Wraps `load` so a call while a run is in flight does nothing. The wrapper resolves to true when it ran `load`.
export function createRefresh(load) {
  let busy = false;
  return async function refresh() {
    if (busy) return false;
    busy = true;
    try {
      await load();
      return true;
    } finally {
      busy = false;
    }
  };
}

// True on refresh cycle 0 and every ROOT_RESET_CYCLES cycles after it: the cached repo roots are resolved again.
export function rootsDue(cycle) {
  return cycle % ROOT_RESET_CYCLES === 0;
}

// WCAG relative luminance of a #rrggbb color.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// WCAG contrast ratio of two #rrggbb colors, from 1 to 21.
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The candidate text color with the highest contrast on `bg`.
export function bestText(bg, candidates) {
  let best = { text: candidates[0], ratio: contrastRatio(bg, candidates[0]) };
  for (const text of candidates.slice(1)) {
    const ratio = contrastRatio(bg, text);
    if (ratio > best.ratio) best = { text, ratio };
  }
  return best;
}

// Chip colors from the theme: the named theme color as background, and the text color with the best contrast.
// Black or white always reaches MIN_CONTRAST on any background (at least 4.58:1), so the chip always passes.
export function chipColors(t, colorName) {
  const bg = t[colorName];
  const best = bestText(bg, [t.surface, t.foreground, "#000000", "#ffffff"]);
  return { bg, text: best.text, ratio: best.ratio };
}

// Spawn budget: git status of a repo and `hc ls` are read at most once per TTL, not on every refresh tick.
export const GIT_TTL_MS = 20000;
export const JOBS_TTL_MS = 15000;

// True when `last` (ms timestamp, or undefined for never) is older than `ttl` at `now`, or `force` is set.
export function ttlDue(last, now, ttl, force = false) {
  return force || last === undefined || now - last >= ttl;
}
