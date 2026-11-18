'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const env = require('../core/env');

const spaces = [
  { id: 's1', name: 'work', tabs: [{ id: 't1' }] },
  { id: 's2', name: 'orch', tabs: [{ id: 't2' }, { id: 't3' }] },
];

test('space and tab env', () => {
  assert.equal(env.spaceEnv(spaces[0]), 'default');
  assert.equal(env.spaceEnv(spaces[1]), 'orch');
  assert.equal(env.spaceEnv(spaces[1], 'jobs'), 'default');
  assert.equal(env.spaceEnv(spaces[1], null), 'default');
  assert.deepEqual(env.spacesForEnv(spaces, 'orch').map((s) => s.id), ['s2']);
  assert.deepEqual(env.spacesForEnv(spaces, 'default').map((s) => s.id), ['s1']);
});

test('pane env: orch space or job address', () => {
  const panes = [{ pane: 'a', tab: 't1', terminal: 'x' }, { pane: 'b', tab: 't2', terminal: 'y' }, { pane: 'c', tab: 't1', terminal: 'job1' }];
  const jobs = new Set(['job1']);
  assert.deepEqual(env.panesForEnv(panes, spaces, 'orch', jobs).map((p) => p.pane), ['b', 'c']);
  assert.deepEqual(env.panesForEnv(panes, spaces, 'default', jobs).map((p) => p.pane), ['a']);
});

test('tabs for env hide the other env, unless forced', () => {
  assert.deepEqual(env.tabsForEnv(spaces[1], 'default'), []);
  assert.deepEqual(env.tabsForEnv(spaces[1], 'orch').map((t) => t.id), ['t2', 't3']);
  assert.deepEqual(env.tabsForEnv(spaces[0], 'orch'), []);
  assert.deepEqual(env.tabsForEnv(spaces[1], 'default', 'orch', true).map((t) => t.id), ['t2', 't3']);
  assert.deepEqual(env.tabsForEnv(null, 'default'), []);
});

test('normalize and orch space name', () => {
  assert.equal(env.normalizeEnv('orch'), 'orch');
  assert.equal(env.normalizeEnv('x'), 'default');
  assert.equal(env.orchSpaceName(undefined), 'orch');
  assert.equal(env.orchSpaceName('off'), null);
  assert.equal(env.orchSpaceName(' x '), 'x');
});

test('agentsForEnv keeps the agents of the env spaces only', () => {
  const { agentsForEnv } = require('../core/env');
  const spaces = [{ name: 'work', tabs: [{ id: 't1' }] }, { name: 'orch', tabs: [{ id: 't2' }] }];
  const agents = [{ address: 'a', tab: 't1' }, { address: 'b', tab: 't2' }, { address: 'c', tab: 'x' }];
  assert.deepEqual(agentsForEnv(agents, spaces, 'default').map((a) => a.address), ['a']);
  assert.deepEqual(agentsForEnv(agents, spaces, 'orch').map((a) => a.address), ['b']);
  assert.deepEqual(agentsForEnv(agents, spaces, 'default', null).map((a) => a.address), ['a', 'b']);
});

test('spacesForEnv hides the orch space in default and shows only it in orch', () => {
  const { spacesForEnv } = require('../core/env');
  const spaces = [{ name: 'work' }, { name: 'orch' }];
  assert.deepEqual(spacesForEnv(spaces, 'default').map((s) => s.name), ['work']);
  assert.deepEqual(spacesForEnv(spaces, 'orch').map((s) => s.name), ['orch']);
});

test('sidebar mods wire the env filter and copy env.js', () => {
  const fs = require('node:fs'), path = require('node:path');
  const root = path.join(__dirname, '..', 'app-mod', 'mods');
  const gen = fs.readFileSync(path.join(root, 'folders', 'env.js'), 'utf8');
  for (const m of ['spaces-folders', 'agents-folders']) {
    assert.equal(fs.readFileSync(path.join(root, m, 'env.js'), 'utf8'), gen);
    assert.match(fs.readFileSync(path.join(root, m, 'main.js'), 'utf8'), /shared\("folders\.env"\)/);
  }
});
