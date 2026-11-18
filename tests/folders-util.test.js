'use strict';

// util.js of the folders mod: plural labels, the refresh guard, the repo-root cycle and chip contrast.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const loadUtil = () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app-mod', 'mods', 'folders', 'util.js'), 'utf8');
  return import(`data:text/javascript,${encodeURIComponent(src)}`);
};

test('plural uses the singular only for 1', async () => {
  const { plural } = await loadUtil();
  assert.equal(plural(1, 'agent'), '1 agent');
  assert.equal(plural(2, 'agent'), '2 agents');
  assert.equal(plural(0, 'terminal'), '0 terminals');
  assert.equal(plural(1, 'terminal'), '1 terminal');
});

test('createRefresh skips a call that starts while a run is in flight', async () => {
  const { createRefresh } = await loadUtil();
  let runs = 0;
  let release;
  const refresh = createRefresh(() => {
    runs += 1;
    return new Promise((resolve) => (release = resolve));
  });

  const first = refresh();
  const second = refresh();
  assert.equal(await second, false);
  assert.equal(runs, 1);

  release();
  assert.equal(await first, true);
  const third = refresh();
  release();
  assert.equal(await third, true);
  assert.equal(runs, 2);
});

test('createRefresh clears the busy flag when load throws', async () => {
  const { createRefresh } = await loadUtil();
  let calls = 0;
  const refresh = createRefresh(async () => {
    calls += 1;
    if (calls === 1) throw new Error('git hung');
  });

  await assert.rejects(refresh(), /git hung/);
  assert.equal(await refresh(), true);
  assert.equal(calls, 2);
});

test('rootsDue is true on cycle 0 and every 20 cycles after it', async () => {
  const { rootsDue, ROOT_RESET_CYCLES } = await loadUtil();
  assert.equal(ROOT_RESET_CYCLES, 20);
  const due = [];
  for (let cycle = 0; cycle <= 40; cycle += 1) if (rootsDue(cycle)) due.push(cycle);
  assert.deepEqual(due, [0, 20, 40]);
});

test('contrastRatio matches the WCAG values for black on white and equal colors', async () => {
  const { contrastRatio } = await loadUtil();
  assert.equal(Math.round(contrastRatio('#000000', '#ffffff') * 100) / 100, 21);
  assert.equal(contrastRatio('#777777', '#777777'), 1);
});

test('chipColors keeps the ready chip at or above 4.5:1 on a mid grey background', async () => {
  const { chipColors, contrastRatio } = await loadUtil();
  // Grey text on a grey background was the finding (F5). Any theme color must pass.
  const t = { dim: '#7a7a7a', surface: '#8a8a8a', foreground: '#f0f0f0' };
  const chip = chipColors(t, 'dim');
  assert.ok(chip.ratio >= 4.5, `ratio ${chip.ratio}`);
  assert.ok(Math.abs(contrastRatio(chip.bg, chip.text) - chip.ratio) < 1e-9);
});

test('chipColors keeps the theme color as background and picks the text with the best contrast', async () => {
  const { chipColors } = await loadUtil();
  const t = { working: '#1d4ed8', blocked: '#808080', surface: '#ffffff', foreground: '#111111' };
  const working = chipColors(t, 'working');
  assert.equal(working.bg, '#1d4ed8');
  assert.ok(working.ratio >= 4.5);
  // #808080 is mid grey: black reaches about 5.3:1, white about 3.9:1, so black wins.
  assert.equal(chipColors(t, 'blocked').text, '#000000');
  assert.ok(chipColors(t, 'blocked').ratio >= 4.5);
});

test('ttlDue is true for never, expired or forced reads only', async () => {
  const { ttlDue } = await loadUtil();
  assert.equal(ttlDue(undefined, 1000, 500), true);
  assert.equal(ttlDue(900, 1000, 500), false);
  assert.equal(ttlDue(500, 1000, 500), true);
  assert.equal(ttlDue(900, 1000, 500, true), true);
});
