// GENERATED from core/ by app-mod/scripts/sync-core.js. Do not edit.
// Pure git logic: parsing of `git status --porcelain=v2` and the file lists derived from it.
// Process execution lives in lib/git.js.

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

function stagedFiles(files) {
  return files.filter((file) => !file.untracked && !file.conflict && file.index !== '.');
}

function unstagedFiles(files) {
  return files.filter((file) => file.untracked || file.conflict || file.worktree !== '.');
}

// Branch page on a web host (GitHub layout), or null when the remote is not a web URL.
// git@github.com:o/r.git + feat/x -> https://github.com/o/r/tree/feat/x
function webBranchUrl(remoteUrl, branch) {
  let base = null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remoteUrl)) {
    const { hostname, pathname } = new URL(remoteUrl);
    if (hostname) base = `https://${hostname}${pathname}`;
  } else {
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(remoteUrl);
    if (scp) base = `https://${scp[1]}/${scp[2]}`;
  }
  if (!base) return null;
  base = base.replace(/\/+$/, '').replace(/\.git$/, '');
  return `${base}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`;
}

// One line per folder, like the minimal-git prompt: "main ↓1 ↑2 +3 ?4 ±5 -6 !7", or "main =" when clean.
function formatGitLine(summary) {
  const branch = summary.branch ?? 'detached';
  if (isClean(summary)) return `${branch} =`;
  const parts = [branch];
  if (summary.behind) parts.push(`↓${summary.behind}`);
  if (summary.ahead) parts.push(`↑${summary.ahead}`);
  if (summary.added) parts.push(`+${summary.added}`);
  if (summary.untracked) parts.push(`?${summary.untracked}`);
  if (summary.modified) parts.push(`±${summary.modified}`);
  if (summary.deleted) parts.push(`-${summary.deleted}`);
  if (summary.conflicts) parts.push(`!${summary.conflicts}`);
  return parts.join(' ');
}

export { emptySummary, parseStatus, isClean, stagedFiles, unstagedFiles, webBranchUrl, formatGitLine };
