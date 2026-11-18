'use strict';

const { execFile } = require('node:child_process');

const core = require('../core/git');

const GIT_TIMEOUT_MS = 3000;

function git(cwd, args, { timeout = GIT_TIMEOUT_MS, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()));
        return;
      }
      resolve(stdout);
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

async function repoRoot(cwd) {
  try {
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim() || null;
  } catch {
    return null;
  }
}

async function status(cwd) {
  return core.parseStatus(await git(cwd, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']));
}

async function diff(cwd, file, { staged = false } = {}) {
  if (file.untracked) {
    return untrackedDiff(cwd, file.path);
  }
  const args = ['diff', '--no-color', '--no-ext-diff'];
  if (staged) args.push('--cached');
  args.push('--', file.path);
  return git(cwd, args);
}

// `diff --no-index` exits 1 whenever the files differ, so its exit code is not an error here
function untrackedDiff(cwd, filePath) {
  return new Promise((resolve) => {
    execFile('git', ['diff', '--no-color', '--no-index', '--', '/dev/null', filePath], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (_error, stdout) => {
      resolve(stdout || '');
    });
  });
}

const stage = (cwd, paths) => git(cwd, ['add', '--', ...paths]);
const unstage = (cwd, paths) => git(cwd, ['restore', '--staged', '--', ...paths]);
const stageAll = (cwd) => git(cwd, ['add', '-A']);
const unstageAll = (cwd) => git(cwd, ['reset', '-q']);
const commit = (cwd, message) => git(cwd, ['commit', '-m', message], { timeout: 60000 });
const pull = (cwd) => git(cwd, ['pull', '--ff-only'], { timeout: 120000 });
const push = (cwd) => git(cwd, ['push'], { timeout: 120000 });
const fetch = (cwd) => git(cwd, ['fetch', '--quiet'], { timeout: 60000 });

async function discard(cwd, file) {
  if (file.untracked) {
    // `git clean` only touches the one named path
    return git(cwd, ['clean', '-f', '-q', '--', file.path]);
  }
  return git(cwd, ['restore', '--', file.path]);
}

// Web page of a local branch on the remote it tracks (origin when none is set).
async function branchWebUrl(cwd, branch) {
  const remote = (await git(cwd, ['config', '--get', `branch.${branch}.remote`]).catch(() => '')).trim() || 'origin';
  const remoteUrl = (await git(cwd, ['remote', 'get-url', remote]).catch(() => '')).trim();
  return core.webBranchUrl(remoteUrl, branch);
}

module.exports = {
  webBranchUrl: core.webBranchUrl,
  branchWebUrl,
  git,
  repoRoot,
  parseStatus: core.parseStatus,
  isClean: core.isClean,
  status,
  stagedFiles: core.stagedFiles,
  unstagedFiles: core.unstagedFiles,
  diff,
  untrackedDiff,
  stage,
  unstage,
  stageAll,
  unstageAll,
  commit,
  pull,
  push,
  fetch,
  discard,
};
