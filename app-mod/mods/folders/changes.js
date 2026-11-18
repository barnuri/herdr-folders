// Git reads and writes for the Changes view. Hand-written (not generated).
// Reads take no locks and refresh nothing under .git; writes are the ones a person asks for.

import { exec, readTextFile } from "herdr";
import { parseStatus, stagedFiles, unstagedFiles } from "./git.js";
import { diffLines } from "./difflogic.js";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const SLOW_MS = 120000;

async function run(cwd, args, timeout = 10000) {
  const result = await exec("git", args, { cwd, timeout });
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  return result.stdout;
}

export async function repoOf(cwd) {
  const result = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 });
  return result.code === 0 ? result.stdout.trim() || null : null;
}

// { summary, staged, unstaged } of the repo at root.
export async function readChanges(root) {
  const out = await run(root, [...READ, "status", "--porcelain=v2", "--branch", "--untracked-files=all"]);
  const { summary, files } = parseStatus(out);
  return { summary, staged: stagedFiles(files), unstaged: unstagedFiles(files) };
}

// Diff lines (from the first hunk) of one file, in the staged or the unstaged group.
export async function readDiff(root, file, staged) {
  if (file.untracked) {
    const text = await readTextFile(`${root}/${file.path}`).catch(() => null);
    if (text === null) return ["Cannot preview this file (binary, too large, or unreadable)"];
    if (text.includes("\0")) return ["Binary file · no text diff"];
    const lines = text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500);
    return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)];
  }
  const args = [...READ, "diff", "--no-ext-diff", "--no-textconv", "--no-color"];
  if (staged) args.push("--cached");
  const out = await run(root, [...args, "--", file.path]);
  return diffLines(out).slice(0, 1500).map((line) => (line.length > 4000 ? `${line.slice(0, 4000)}…` : line));
}

export const stage = (root, paths) => run(root, ["add", "--", ...paths]);
export const unstage = (root, paths) => run(root, ["restore", "--staged", "--", ...paths]);
export const stageAll = (root) => run(root, ["add", "-A"]);
export const unstageAll = (root) => run(root, ["reset", "-q"]);
export const commit = (root, message) => run(root, ["commit", "-m", message], SLOW_MS);
export const fetch = (root) => run(root, ["fetch", "--quiet"], SLOW_MS);
export const pull = (root) => run(root, ["pull", "--ff-only"], SLOW_MS);
export const push = (root) => run(root, ["push"], SLOW_MS);

// Throws away the change of one file. An untracked file is deleted with `git clean` (that one path only).
export function discard(root, file) {
  if (file.untracked) return run(root, ["clean", "-f", "-q", "--", file.path]);
  return run(root, ["restore", "--", file.path]);
}
