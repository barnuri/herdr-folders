// Git reads for the folders mod: the repo root of a folder and its status. Hand-written (not generated).
// Parsing and the git line format come from the generated git.js (core/git.js).

import { exec } from "herdr";
import { parseStatus } from "./git.js";

// Read-only git: never refresh the index or take locks (same flags as the changes mod).
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
// A git call that runs longer than this counts as failed, so one slow repo cannot stall the refresh.
export const EXEC_TIMEOUT_MS = 5000;

// Repo root of `cwd`, or null when `cwd` is not inside a git repo.
export async function repoRoot(cwd) {
  if (!cwd) return null;
  const result = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: EXEC_TIMEOUT_MS });
  return result.code === 0 ? result.stdout.trim() || null : null;
}

// Status of the repo at `root`, or null when git fails (the folder then shows no git line).
export async function repoStatus(root) {
  const result = await exec("git", [...READ, "status", "--porcelain=v2", "--branch", "--untracked-files=all"], { cwd: root, timeout: EXEC_TIMEOUT_MS });
  if (result.code !== 0) return null;
  return parseStatus(result.stdout).summary;
}
