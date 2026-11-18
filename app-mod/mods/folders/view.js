// Pure view helpers for the folders mod: the TUI's status styles and git segments, mapped to app theme tokens.
// Same order, symbols and meaning as lib/tui.js STATUS_STYLE and lib/prompt.js promptSegments.
import { isClean } from "./git.js";

// Theme token per TUI colour (Catppuccin names to app tokens).
export const TOKEN = {
  working: "working", // amber
  orch: "accent", // magenta
  blocked: "blocked", // red
  done: "done", // blue
  idle: "idle", // green
  unknown: "dim",
  running: "ansi14", // cyan
  shell: "dim", // faint
};

export const STATE_LABEL = { working: "working", orch: "orch", blocked: "blocked", done: "done", idle: "idle", unknown: "unknown", running: "running", shell: "ready" };

// Summary order in the header ("2 idle 1 running").
export const SUMMARY_ORDER = ["blocked", "working", "orch", "running", "done", "idle"];

// Status of a pane for display: agents use their status, shells are "running" when busy, else "shell".
export function paneStatus(pane) {
  if (pane.kind === "agent") return pane.status || "unknown";
  return pane.busy ? "running" : "shell";
}

// Counts per display status over every pane of every folder.
export function summarize(folders) {
  const counts = {};
  for (const folder of folders) for (const pane of folder.panes) {
    const status = paneStatus(pane);
    if (status !== "shell") counts[status] = (counts[status] || 0) + 1;
  }
  return SUMMARY_ORDER.filter((status) => counts[status]).map((status) => ({ status, count: counts[status] }));
}

// Git prompt segments: branch, then ↓behind ↑ahead +new ?untracked ±mod -del !conflict, or "=" when clean.
export function gitSegments(summary) {
  if (!summary) return [];
  const segments = [{ text: summary.branch || "no branch", token: summary.branch ? "ansi14" : "blocked", key: "branch" }];
  if (isClean(summary)) return [...segments, { text: "=", token: "ansi14", key: "clean" }];
  const counters = [
    ["behind", "\u2193", "blocked"],
    ["ahead", "\u2191", "ansi14"],
    ["added", "+", "idle"],
    ["untracked", "?", "ansi11"],
    ["modified", "\u00b1", "ansi14"],
    ["deleted", "-", "blocked"],
    ["conflicts", "!", "accent"],
  ];
  for (const [key, symbol, token] of counters) if (summary[key]) segments.push({ text: `${symbol}${summary[key]}`, token, key });
  return segments;
}
