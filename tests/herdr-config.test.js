'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { apply, revert, isReplaced, toggleSidebarKey } = require('../lib/herdr-config');

const USER = ['onboarding = false', '[ui]', 'sidebar_collapsed_mode = "compact"', 'status_indicators = "symbols"', '[keys]', 'prefix = "ctrl+a"', ''].join('\n');

test('apply hides the sidebar and comments out a conflicting user key', () => {
  const out = apply(USER);
  assert.equal(isReplaced(out), true);
  const lines = out.split('\n');
  assert.equal(lines[2], 'sidebar_start_collapsed = true # herdr-folders');
  assert.equal(lines[3], 'sidebar_collapsed_mode = "hidden" # herdr-folders');
  assert.ok(lines.includes('# herdr-folders-disabled: sidebar_collapsed_mode = "compact"'));
  assert.equal(lines.filter((line) => /^sidebar_collapsed_mode/.test(line)).length, 1);
});

test('revert restores the file byte for byte, and apply is idempotent', () => {
  assert.equal(revert(apply(USER)), USER);
  assert.equal(apply(apply(USER)), apply(USER));
  assert.equal(isReplaced(USER), false);
});

test('apply adds a [ui] table when the config has none', () => {
  const out = apply('onboarding = false\n');
  assert.match(out, /\n\[ui\]\nsidebar_start_collapsed = true # herdr-folders/);
  assert.equal(revert(out), 'onboarding = false\n\n[ui]');
});

test('toggleSidebarKey reads the prefix and binding', () => {
  assert.equal(toggleSidebarKey(USER), 'ctrl+a, then b');
  assert.equal(toggleSidebarKey(''), 'ctrl+b, then b');
  assert.equal(toggleSidebarKey('toggle_sidebar = "alt+s"'), 'alt+s');
});
