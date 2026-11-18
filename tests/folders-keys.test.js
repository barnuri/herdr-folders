'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const load = (file) => import(`data:text/javascript,${encodeURIComponent(fs.readFileSync(path.join(__dirname, '..', 'app-mod', 'mods', 'folders', file), 'utf8'))}`);

test('key table maps the TUI sidebar keys', async () => {
  const { actionForKey } = await load('keys.js');
  const table = { j: 'down', k: 'up', g: 'git', e: 'expand-all', c: 'collapse-all', a: 'agents', v: 'grouping', o: 'sort', s: 'spacing', n: 'new-tab', '?': 'actions', x: 'close-menu', '[': 'narrow', ']': 'widen', R: 'restore', h: 'hide', tab: 'switch-view', enter: 'activate', ' ': 'toggle' };
  for (const [key, action] of Object.entries(table)) assert.equal(actionForKey(key, false, {}), action, key);
  assert.equal(actionForKey('1', false, { closeMenu: true }), 'close-1');
  assert.equal(actionForKey('1', false, {}), null);
});

test('confirm and projects contexts', async () => {
  const { actionForKey } = await load('keys.js');
  assert.equal(actionForKey('y', false, { confirm: true }), 'confirm');
  assert.equal(actionForKey('n', false, { confirm: true }), 'cancel');
  assert.equal(actionForKey('j', false, { confirm: true }), null);
  assert.equal(actionForKey('j', false, { projects: true }), 'filter:j');
  assert.equal(actionForKey('t', true, { projects: true }), 'project-tab');
  assert.equal(actionForKey('r', true, { projects: true }), 'project-rescan');
  assert.equal(actionForKey('enter', false, { projects: true }), 'project-open');
});

test('sort cycles opened, status, name', async () => {
  const { nextSort } = await load('keys.js');
  assert.deepEqual(['opened', 'status', 'name'].map(nextSort), ['status', 'name', 'opened']);
});

test('fuzzy project filter ranks contiguous hits first', () => {
  const { filterProjects } = require('../core/fuzzy');
  const list = [{ name: 'herdr-web' }, { name: 'web-shop' }, { name: 'xyz' }];
  assert.deepEqual(filterProjects(list, 'web').map((p) => p.name), ['web-shop', 'herdr-web']);
  assert.equal(filterProjects(list, '').length, 3);
});
