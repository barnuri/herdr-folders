'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('orch rows', async () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app-mod', 'mods', 'folders', 'orchjobs.js'), 'utf8');
  const m = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  const jobs = m.parseJobs({ terminals: [
    { address: 'a', name: 'x-1', where: 'orch / -r1', state: 'live' },
    { address: 'b', name: 'x-2', where: 'orch / -r1', state: 'finished', exit_code: 1 },
    { address: 'c', name: 'x-3', where: 'orch / -r2', state: 'finished', exit_code: 0 },
    { address: 'd', name: 'x-4', where: 'orch / -r2', state: 'live' },
  ] });
  const panes = [{ pane: 'pa', terminal: 'a', tab: 't1' }, { pane: 'pb', terminal: 'b', tab: 't1' }, { pane: 'pc', terminal: 'c', tab: 't2' }, { pane: 'pz', terminal: 'z', tab: 't9' }];
  const rows = m.orchRows(jobs, panes);
  assert.equal(rows.running, 1);
  assert.equal(rows.failed, 1);
  assert.equal(rows.groups.length, 1);
  const ids = m.orchPaneIds(panes, [{ name: 'orch', tabs: [{ id: 't2' }] }], jobs);
  assert.deepEqual([...ids].sort(), ['pa', 'pb', 'pc']);
  assert.deepEqual(m.parseJobs('bad'), []);
});
