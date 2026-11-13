'use strict';

const { execFile } = require('node:child_process');

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

function emptySummary() {
  return { branch: null, ahead: 0, behind: 0, added: 0, untracked: 0, modified: 0, deleted: 0, conflicts: 0, upstream: null };
}

// Same counting rules as the minimal-git zsh theme, so the panel matches the prompt.
function parseStatus(porcelain) {
  const summary = emptySummary();
  const files = [];
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length);
      summary.branch = head === '(detached)' ? null : head;
    } else if (line.startsWith('# branch.upstream ')) {
      summary.upstream = line.slice('# branch.upstream '.length);
    } else if (line.startsWith('# branch.ab ')) {
      const [ahead, behind] = line.slice('# branch.ab '.length).split(' ');
      summary.ahead = Number(ahead.replace('+', '')) || 0;
      summary.behind = Number(behind.replace('-', '')) || 0;
    } else if (line.startsWith('? ')) {
      summary.untracked += 1;
      files.push({ path: line.slice(2), index: '?', worktree: '?', untracked: true, conflict: false });
    } else if (line.startsWith('u ')) {
      summary.conflicts += 1;
      const parts = line.split(' ');
      files.push({ path: parts.slice(10).join(' '), index: 'U', worktree: 'U', untracked: false, conflict: true });
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const index = line[2];
      const worktree = line[3];
      if (index === 'A') summary.added += 1;
      if ('MTRC'.includes(index) || 'MTRC'.includes(worktree)) summary.modified += 1;
      if (index === 'D' || worktree === 'D') summary.deleted += 1;
      const parts = line.split(' ');
      let path;
      let origPath;
      if (line[0] === '1') {
        path = parts.slice(8).join(' ');
      } else {
        const [target, source] = parts.slice(9).join(' ').split('\t');
        path = target;
        origPath = source;
      }
      files.push({ path, origPath, index, worktree, untracked: false, conflict: false });
    }
  }
  return { summary, files };
}

function isClean(summary) {
  return !summary.ahead && !summary.behind && !summary.added && !summary.untracked && !summary.modified && !summary.deleted && !summary.conflicts;
}

async function status(cwd) {
  return parseStatus(await git(cwd, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']));
}

function stagedFiles(files) {
  return files.filter((file) => !file.untracked && !file.conflict && file.index !== '.');
}

function unstagedFiles(files) {
  return files.filter((file) => file.untracked || file.conflict || file.worktree !== '.');
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

module.exports = {
  git,
  repoRoot,
  parseStatus,
  isClean,
  status,
  stagedFiles,
  unstagedFiles,
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
