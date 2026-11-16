'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const orch = require('../lib/orch');
const { buildFolders, planClose, sortFolders, rollupStatus, STATUS_RANK } = require('../lib/model');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-orch-'));
process.env.HARNESS_ORCH_HOME = home;
const dir = path.join(home, 'activity');
fs.mkdirSync(dir, { recursive: true });
test.after(() => {
  delete process.env.HARNESS_ORCH_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const now = Date.now();
const nowSecs = Math.floor(now / 1000);
const write = (id, body) => fs.writeFileSync(path.join(dir, `${id}.json`), typeof body === 'string' ? body : JSON.stringify(body));
const active = (extra = {}) => ({ active: true, updated_at: nowSecs, running: 2, done: 1, total: 3, summary: 'orch: 2 running, 1/3 done', ...extra });

const pane = (id, cwd) => ({ pane_id: id, tab_id: 't1', workspace_id: 'w1', cwd, foreground_cwd: cwd });
const agent = (id, status, session, extra = {}) => ({ pane_id: id, agent: 'opencode', agent_status: status, agent_session: session ? { value: session } : undefined, ...extra });

function build(agents, lookup) {
  orch.clearCache();
  const panes = agents.map((a, i) => pane(a.pane_id, `/r/${i}`));
  return buildFolders({ panes, agents, orchLookup: lookup || ((id) => orch.orchSummary(id, now)) });
}
const only = (a) => build([a])[0].panes[0];

test('idle agent with a fresh active file becomes orch and keeps its raw status', () => {
  write('ses_a', active());
  const p = only(agent('p1', 'idle', 'ses_a'));
  assert.equal(p.status, 'orch');
  assert.equal(p.rawStatus, 'idle');
  assert.equal(p.orchSummary, 'orch: 2 running, 1/3 done');
  assert.equal(only(agent('p1', 'done', 'ses_a')).status, 'orch');
});

test('stale, inactive, missing, corrupt, oversized and wrong-type files stay idle', () => {
  write('ses_stale', active({ updated_at: nowSecs - 121 }));
  write('ses_off', active({ active: false }));
  write('ses_bad', '{not json');
  write('ses_big', JSON.stringify(active({ summary: 'x'.repeat(9000) })));
  write('ses_type1', active({ active: 'true' }));
  write('ses_type2', active({ updated_at: 'now' }));
  write('ses_null', 'null');
  for (const id of ['ses_stale', 'ses_off', 'ses_bad', 'ses_big', 'ses_type1', 'ses_type2', 'ses_null', 'ses_missing', '../x', '']) {
    assert.equal(only(agent('p1', 'idle', id)).status, 'idle', id);
  }
  assert.equal(only(agent('p1', 'idle', undefined)).status, 'idle');
});

test('a non-string summary falls back to a plain label', () => {
  write('ses_s', active({ summary: 42 }));
  assert.equal(only(agent('p1', 'idle', 'ses_s')).orchSummary, 'orch running');
});

test('working, blocked and unknown are never overridden', () => {
  write('ses_a', active());
  for (const status of ['working', 'blocked', 'unknown']) {
    const p = only(agent('p1', status, 'ses_a', { tokens: { orch: 'orch: 1 running' } }));
    assert.equal(p.status, status);
    assert.equal(p.orchSummary, undefined);
  }
});

test('the orch token is a fallback when there is no activity file', () => {
  const p = only(agent('p1', 'idle', 'ses_nofile', { tokens: { orch: 'orch: 3 running' } }));
  assert.equal(p.status, 'orch');
  assert.equal(p.orchSummary, 'orch: 3 running');
  assert.equal(only(agent('p1', 'idle', 'ses_nofile', { tokens: { orch: '' } })).status, 'idle');
  assert.equal(only(agent('p1', 'idle', 'ses_nofile', { tokens: { orch: 5 } })).status, 'idle');
});

test('orch ranks between working and done; folders roll up and sort as busy', () => {
  assert.ok(STATUS_RANK.working > STATUS_RANK.orch && STATUS_RANK.orch > STATUS_RANK.done);
  assert.equal(rollupStatus(['idle', 'orch', 'done']), 'orch');
  assert.equal(rollupStatus(['orch', 'working']), 'working');
  write('ses_a', active());
  const folders = build([agent('p1', 'idle', 'ses_none'), agent('p2', 'done', 'ses_none'), agent('p3', 'idle', 'ses_a')]);
  assert.equal(folders[2].status, 'orch');
  assert.deepEqual(sortFolders(folders, 'status').map((f) => f.panes[0].paneId), ['p3', 'p2', 'p1']);
});

test('bulk close never selects an orch pane', () => {
  write('ses_a', active());
  const folders = build([agent('p1', 'idle', 'ses_a'), agent('p2', 'idle', 'ses_none')]);
  for (const mode of ['idle-agents-and-empty-folders', 'empty-folders']) {
    const ids = planClose(folders, mode).map((p) => p.paneId);
    assert.ok(!ids.includes('p1'), mode);
  }
  assert.deepEqual(planClose(folders, 'idle-agents-and-empty-folders').map((p) => p.paneId), ['p2']);
  const mixed = buildFolders({
    panes: [pane('p1', '/r/x'), pane('p2', '/r/x')],
    agents: [agent('p1', 'idle', 'ses_a'), agent('p2', 'idle', 'ses_none')],
    orchLookup: (id) => orch.orchSummary(id, now),
  });
  assert.deepEqual(planClose(mixed, 'idle-agents-and-empty-folders').map((p) => p.paneId), ['p2']);
});

test('reads are cached for 2 s', () => {
  orch.clearCache();
  write('ses_c', active());
  assert.equal(orch.orchSummary('ses_c', now), 'orch: 2 running, 1/3 done');
  write('ses_c', active({ active: false }));
  assert.equal(orch.orchSummary('ses_c', now + 1500), 'orch: 2 running, 1/3 done');
  assert.equal(orch.orchSummary('ses_c', now + 2100), null);
});
