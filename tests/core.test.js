'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFolders, planClose, isShellBusy, displayTitle } = require('../lib/model');
const { parseStatus, isClean, stagedFiles, unstagedFiles } = require('../lib/git');
const { promptText } = require('../lib/prompt');
const { parseInput, Line, width, stripAnsi } = require('../lib/tui');
const { parseDiff } = require('../bin/git-panel');

const pane = (id, cwd, extra = {}) => ({ pane_id: id, tab_id: 't1', workspace_id: 'w1', cwd, foreground_cwd: cwd, ...extra });
const idleShell = { shell_pid: 10, foreground_process_group_id: 10 };
const busyShell = { shell_pid: 10, foreground_process_group_id: 20, foreground_processes: [{ pid: 20, cmdline: '/usr/local/bin/npm run dev' }] };

function fixture() {
  return buildFolders({
    panes: [pane('p1', '/r/a'), pane('p2', '/r/a/src'), pane('p3', '/r/b'), pane('p4', '/r/c'), pane('p5', '/r/c'), pane('p6', '/r/d')],
    agents: [
      { pane_id: 'p1', agent: 'claude', agent_status: 'working' },
      { pane_id: 'p4', agent: 'opencode', agent_status: 'idle' },
    ],
    processInfo: { p2: busyShell, p3: idleShell, p5: idleShell, p6: idleShell },
    roots: { '/r/a': '/r/a', '/r/a/src': '/r/a', '/r/c': '/r/c' },
  });
}

test('groups panes by repo root and shows an agent pane only once', () => {
  const folders = fixture();
  const a = folders.find((folder) => folder.path === '/r/a');
  assert.equal(a.panes.length, 2);
  assert.deepEqual(a.panes.map((p) => p.kind), ['agent', 'terminal']);
  assert.equal(a.status, 'working');
  assert.equal(a.panes[1].command, 'npm run dev');
  assert.equal(folders.flatMap((folder) => folder.panes).filter((p) => p.paneId === 'p1').length, 1);
});

test('folders keep their opened order by default; status and name sorts are optional', () => {
  const { sortFolders } = require('../lib/model');
  assert.deepEqual(fixture().map((f) => f.path), ['/r/a', '/r/b', '/r/c', '/r/d']);
  const reversed = buildFolders({
    panes: [pane('p1', '/r/z'), pane('p2', '/r/m')],
    agents: [{ pane_id: 'p2', agent: 'claude', agent_status: 'working' }],
    processInfo: { p1: idleShell },
  });
  assert.deepEqual(sortFolders(reversed).map((f) => f.name), ['z', 'm']);
  assert.deepEqual(sortFolders(reversed, 'status').map((f) => f.name), ['m', 'z']);
  assert.deepEqual(sortFolders(reversed, 'name').map((f) => f.name), ['m', 'z']);
});

test('excluded panes are dropped', () => {
  const folders = buildFolders({ panes: [pane('p1', '/x'), pane('me', '/x')], agents: [], excludePaneIds: new Set(['me']) });
  assert.deepEqual(folders[0].panes.map((p) => p.paneId), ['p1']);
});

test('planClose modes select the right panes', () => {
  const folders = fixture();
  const ids = (mode, opts) => planClose(folders, mode, opts).map((p) => p.paneId).sort();
  assert.deepEqual(ids('empty-folders'), ['p3', 'p6']);
  assert.deepEqual(ids('idle-agents-and-empty-folders'), ['p3', 'p4', 'p5', 'p6']);
  assert.deepEqual(ids('terminals'), ['p2', 'p3', 'p5', 'p6']);
  assert.deepEqual(ids('all'), ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  assert.deepEqual(ids('all', { keepPaneIds: new Set(['p1']) }), ['p2', 'p3', 'p4', 'p5', 'p6']);
  assert.throws(() => planClose(folders, 'nope'), /unknown close mode/);
});

test('isShellBusy and displayTitle', () => {
  assert.equal(isShellBusy(idleShell), false);
  assert.equal(isShellBusy(busyShell), true);
  assert.equal(isShellBusy(null), false);
  assert.equal(displayTitle({ title: 'OC | Fix login' }), 'Fix login');
  assert.equal(displayTitle({ title: 'Current Folder: ~/x' }), '');
  assert.equal(displayTitle({ title: 'OpenCode', agent: 'opencode' }), '');
});

const PORCELAIN = [
  '# branch.oid abc',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -1',
  '1 A. N... 100644 100644 100644 a b new.js',
  '1 .M N... 100644 100644 100644 a b src/mod file.js',
  '1 D. N... 100644 000000 000000 a b gone.js',
  '2 R. N... 100644 100644 100644 a b R100 renamed.js\told.js',
  'u UU N... 100644 100644 100644 100644 a b c clash.js',
  '? untracked.txt',
].join('\n');

test('parseStatus counts like the minimal-git prompt', () => {
  const { summary, files } = parseStatus(PORCELAIN);
  assert.deepEqual(
    { branch: summary.branch, ahead: summary.ahead, behind: summary.behind, added: summary.added, untracked: summary.untracked, modified: summary.modified, deleted: summary.deleted, conflicts: summary.conflicts },
    { branch: 'main', ahead: 2, behind: 1, added: 1, untracked: 1, modified: 2, deleted: 1, conflicts: 1 }
  );
  assert.equal(files.find((f) => f.origPath === 'old.js').path, 'renamed.js');
  assert.equal(files.find((f) => f.worktree === 'M').path, 'src/mod file.js');
  assert.equal(promptText(summary), 'main ↓1 ↑2 +1 ?1 ±2 -1 !1');
  assert.deepEqual(stagedFiles(files).map((f) => f.path).sort(), ['gone.js', 'new.js', 'renamed.js']);
  assert.deepEqual(unstagedFiles(files).map((f) => f.path).sort(), ['clash.js', 'src/mod file.js', 'untracked.txt']);
});

test('clean repo renders "="', () => {
  const { summary } = parseStatus('# branch.head master\n# branch.ab +0 -0\n');
  assert.equal(isClean(summary), true);
  assert.equal(promptText(summary), 'master =');
});

test('parseInput splits keys and SGR mouse events', () => {
  const events = parseInput('j\x1b[<0;5;3M\x1b[<32;6;3M\x1b[<2;1;1m\x1b[A\x1b[<64;1;1M');
  assert.equal(events[0].key, 'j');
  assert.deepEqual({ x: events[1].x, y: events[1].y, press: events[1].press, button: events[1].button }, { x: 4, y: 2, press: true, button: 0 });
  assert.equal(events[2].motion, true);
  assert.deepEqual({ button: events[3].button, press: events[3].press }, { button: 2, press: false });
  assert.equal(events[4].key, '\x1b[A');
  assert.equal(events[5].wheel, true);
});

test('Line tracks hit regions and clips to the given width', () => {
  const line = new Line();
  const run = () => {};
  line.add('ab').add('cdef', '\x1b[1m', { run });
  assert.deepEqual(line.hits[0], { x0: 2, x1: 6, action: { run } });
  assert.equal(width(stripAnsi(line.render(4))), 4);
  assert.equal(width(stripAnsi(line.render(10))), 10);
});

test('parseDiff numbers lines and hides file headers', () => {
  const rows = parseDiff('diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -3,2 +3,3 @@ fn\n ctx\n-old\n+new\n+more\n');
  assert.deepEqual(rows.map((r) => r.type), ['hunk', 'ctx', 'del', 'add', 'add']);
  assert.deepEqual([rows[1].oldNo, rows[1].newNo, rows[2].oldNo, rows[3].newNo, rows[4].newNo], [3, 3, 4, 4, 5]);
});

test('splitDiff pairs deletions beside the additions that follow them', () => {
  const { splitDiff } = require('../bin/git-panel');
  const pairs = splitDiff(parseDiff('@@ -3,3 +3,3 @@\n ctx\n-old\n+new\n+more\n-gone\n'));
  assert.deepEqual(pairs.map((p) => p.type), ['hunk', 'pair', 'pair', 'pair', 'pair']);
  assert.deepEqual(pairs.slice(1).map((p) => [p.left?.text ?? null, p.right?.text ?? null]), [
    ['ctx', 'ctx'],
    ['old', 'new'],
    [null, 'more'],
    ['gone', null],
  ]);
});

test('project filter ranks contiguous and early matches first', () => {
  const { filterProjects, fuzzyScore } = require('../lib/projects');
  const projects = [{ name: 'herdr-web-plugin' }, { name: 'herdr-folders' }, { name: 'web-terminal' }];
  assert.deepEqual(filterProjects(projects, 'hfold').map((p) => p.name), ['herdr-folders']);
  assert.equal(filterProjects(projects, 'web')[0].name, 'web-terminal');
  assert.equal(fuzzyScore('abc', 'x'), null);
  assert.equal(filterProjects(projects, '').length, 3);
});

test('buildTree nests folders by path and merges single-child directories', () => {
  const { buildTree, dirKeys } = require('../lib/model');
  const f = (p) => ({ path: p, name: p.split('/').pop() });
  const tree = buildTree([f('/u/s/private'), f('/u/s/private/web'), f('/u/s/private/a/b/api'), f('/u/s/CP/keystone')]);
  const show = (n) => `${n.type}:${n.name}${n.children.length ? `(${n.children.map(show).join(',')})` : ''}`;
  assert.equal(tree.map(show).join(','), 'dir:s(dir:CP(folder:keystone),folder:private(dir:a/b(folder:api),folder:web))');
  assert.deepEqual(dirKeys(tree).sort(), ['dir:/u/s', 'dir:/u/s/CP', 'dir:/u/s/private/a/b']);
  assert.equal(buildTree([f('/x/one'), f('/x/two')]).map(show).join(','), 'dir:x(folder:one,folder:two)');
});

test('panes of other plugins are left out; a shell in a plugin repo stays', () => {
  const folders = buildFolders({
    panes: [
      pane('a1', '/r/orch-skill', { tab_id: 'tx' }),
      pane('m1', '/plugins/herdr-mods', { tab_id: 'tx', label: 'summarize mod' }),
      pane('s1', '/plugins/herdr-mods', { tab_id: 'ty' }),
    ],
    agents: [{ pane_id: 'a1', agent: 'opencode', agent_status: 'working' }],
    processInfo: { s1: idleShell },
    roots: { '/r/orch-skill': '/r/orch-skill', '/plugins/herdr-mods': '/plugins/herdr-mods' },
    pluginRoots: ['/plugins/herdr-mods'],
  });
  const orch = folders.find((f) => f.path === '/r/orch-skill');
  assert.deepEqual(orch.panes.map((p) => [p.paneId, p.kind]), [['a1', 'agent']]);
  // a plain shell inside the plugin's repo (someone developing it) stays in that folder
  assert.deepEqual(folders.find((f) => f.path === '/plugins/herdr-mods').panes.map((p) => p.paneId), ['s1']);
});

test('webBranchUrl turns a git remote into the branch page on its web host', () => {
  const { webBranchUrl } = require('../lib/git');
  assert.equal(webBranchUrl('git@github.com:barnuri/herdr-folders.git', 'feat/tree'), 'https://github.com/barnuri/herdr-folders/tree/feat/tree');
  assert.equal(webBranchUrl('https://user@github.com/o/r.git', 'main'), 'https://github.com/o/r/tree/main');
  assert.equal(webBranchUrl('ssh://git@github.com:22/o/r.git', 'main'), 'https://github.com/o/r/tree/main');
  assert.equal(webBranchUrl('/srv/git/repo.git', 'main'), null);
  assert.equal(webBranchUrl('', 'main'), null);
});

test('buildFileTree nests changed files by directory', () => {
  const { buildFileTree } = require('../bin/git-panel');
  const tree = buildFileTree([{ path: 'a/b/x.js' }, { path: 'a/y.js' }, { path: 'top.md' }]);
  assert.deepEqual([...tree.dirs.keys()], ['a']);
  assert.deepEqual([...tree.dirs.get('a').dirs.keys()], ['b']);
  assert.deepEqual(tree.dirs.get('a').files.map((f) => f.path), ['a/y.js']);
  assert.deepEqual(tree.dirs.get('a').dirs.get('b').files.map((f) => f.path), ['a/b/x.js']);
  assert.deepEqual(tree.files.map((f) => f.path), ['top.md']);
});

test('difflogic: rows are numbered and side-by-side pairs -/+ runs', () => {
  const { diffRows, sideBySide, diffLines } = require('../core/difflogic');
  const rows = diffRows(['@@ -1,2 +1,3 @@', ' a', '-b', '+B', '+c']);
  assert.deepEqual(rows.slice(1).map((r) => [r.kind, r.old, r.next]), [[' ', 1, 1], ['-', 2, undefined], ['+', undefined, 2], ['+', undefined, 3]]);
  const pairs = sideBySide(rows);
  assert.equal(pairs.length, 4);
  assert.equal(pairs[2].left.text, 'b');
  assert.equal(pairs[2].right.text, 'B');
  assert.equal(pairs[3].left, null);
  assert.deepEqual(diffLines('Binary files a and b differ\n'), ['Binary file · no text diff']);
});
