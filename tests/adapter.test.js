'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// adapter.js is an ES module under app-mod/, but the package is CommonJS, so Node
// will not load it by path. It has no imports, so its source loads as a data: module.
const fs = require('node:fs');
const path = require('node:path');

const loadAdapter = () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app-mod', 'mods', 'folders', 'adapter.js'), 'utf8');
  return import(`data:text/javascript,${encodeURIComponent(src)}`);
};

const shell = { shell: true, name: 'zsh' };
const program = (name) => ({ shell: false, name });

function input() {
  return {
    spaces: [
      { id: 's1', tabs: [{ id: 't1', name: 'api' }, { id: 't2', name: 'web' }] },
      { id: 's2', tabs: [{ id: 't3', name: 'docs' }] },
    ],
    panes: [
      { pane: 'p1', tab: 't1', terminal: {}, cwd: '/r/api', title: 'zsh', name: 'shell', focused: true, program: shell },
      { pane: 'p2', tab: 't2', terminal: {}, cwd: '/r/web', title: 'npm', name: null, focused: false, program: program('npm') },
      { pane: 'p3', tab: 't3', terminal: {}, cwd: '/r/docs', title: 'claude', name: 'docs-agent', focused: false, program: program('claude') },
      { pane: 'm1', tab: 't1', terminal: null, cwd: '', title: 'mod', name: 'folders', focused: false, program: program('mod') },
    ],
    agents: [{ pane: 'p3', app: 'claude', status: 'working', pane_name: 'docs-agent', program: program('claude') }],
  };
}

test('herdrInput excludes mod panes from panes, agents and processInfo', async () => {
  const { herdrInput } = await loadAdapter();
  const out = herdrInput(input());

  assert.deepEqual(
    out.panes.map((pane) => pane.pane_id),
    ['p1', 'p2', 'p3'],
  );
  assert.equal(out.excludePaneIds.has('m1'), true);
  assert.equal(out.processInfo.m1, undefined);
});

test('herdrInput maps each pane to its tab and workspace', async () => {
  const { herdrInput } = await loadAdapter();
  const out = herdrInput(input());

  assert.deepEqual(out.panes[0], {
    pane_id: 'p1',
    tab_id: 't1',
    workspace_id: 's1',
    cwd: '/r/api',
    foreground_cwd: '/r/api',
    terminal_title: 'zsh',
    label: 'shell',
    focused: true,
  });
  assert.deepEqual(out.tabs, [
    { tab_id: 't1', label: 'api' },
    { tab_id: 't2', label: 'web' },
    { tab_id: 't3', label: 'docs' },
  ]);
});

test('herdrInput gives a running non-agent program a synthetic processInfo', async () => {
  const { herdrInput } = await loadAdapter();
  const out = herdrInput(input());

  assert.deepEqual(out.processInfo.p2, {
    shell_pid: 1,
    foreground_process_group_id: 2,
    foreground_processes: [{ pid: 2, name: 'npm', cmdline: 'npm' }],
  });
});

test('herdrInput leaves shells and agent panes out of processInfo and maps the agent', async () => {
  const { herdrInput } = await loadAdapter();
  const out = herdrInput(input());

  assert.equal(out.processInfo.p1, undefined);
  assert.equal(out.processInfo.p3, undefined);
  assert.deepEqual(out.agents, [
    { pane_id: 'p3', agent: 'claude', agent_status: 'working', name: 'docs-agent' },
  ]);
});

test('herdrInput uses an empty label when the pane has no name', async () => {
  const { herdrInput } = await loadAdapter();
  const out = herdrInput(input());

  assert.equal(out.panes.find((pane) => pane.pane_id === 'p2').label, '');
});
