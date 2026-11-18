'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');
const load = () => import(`data:text/javascript,${encodeURIComponent(fs.readFileSync(path.join(__dirname, '..', 'app-mod', 'mods', 'folders', 'listops.js'), 'utf8'))}`);
const F = (name, ...panes) => ({ name, path: `/p/${name}`, panes: panes.map((n) => ({ name: n })) });

test('filterFolders matches folder name, path and pane name; empty keeps all', async () => {
  const { filterFolders } = await load();
  const list = [F('alpha', 'claude'), F('beta', 'shell')];
  assert.equal(filterFolders(list, '').length, 2);
  assert.deepEqual(filterFolders(list, 'ALP').map((f) => f.name), ['alpha']);
  assert.deepEqual(filterFolders(list, 'shell').map((f) => f.name), ['beta']);
  assert.equal(filterFolders(list, 'zzz').length, 0);
});

test('applyOrder puts listed paths first, rest keep order', async () => {
  const { applyOrder } = await load();
  const list = [F('a'), F('b'), F('c')];
  assert.deepEqual(applyOrder(list, ['/p/c']).map((f) => f.name), ['c', 'a', 'b']);
  assert.deepEqual(applyOrder(list, []).map((f) => f.name), ['a', 'b', 'c']);
});

test('moveInOrder, avatarColor, menuHeight', async () => {
  const { moveInOrder, avatarColor, menuHeight, AVATARS } = await load();
  assert.deepEqual(moveInOrder(['a', 'b', 'c'], 'a', 'c'), ['b', 'c', 'a']);
  assert.deepEqual(moveInOrder(['a', 'b'], 'x', 'b'), ['a', 'b']);
  assert.equal(avatarColor('keystone'), avatarColor('keystone'));
  assert.ok(AVATARS.includes(avatarColor('x')));
  assert.equal(menuHeight([{}, { sep: true }]), 46 + 26 + 9);
});
