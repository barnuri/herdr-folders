'use strict';

// Fails when the ESM copies in app-mod/mods/folders/ drift from core/, or when the deployed mod under
// ~/.config/herdr-app/mods/folders differs from the repo. Fix: node app-mod/scripts/sync-core.js, then copy the mod folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { generate, OUT } = require('../app-mod/scripts/sync-core');

// Files of the mod that the deployed copy must match: the generated ones and the hand-written ones.
const MOD_FILES = ['main.js', 'data.js', 'adapter.js', 'util.js', 'model.js', 'orch.js', 'git.js', 'mod.json', 'difflogic.js', 'changes.js', 'diff.js', 'changes-view.js', 'extras.js', 'keys.js', 'prefs.js', 'fuzzy.js', 'perf.js', 'env.js'];
const HERDR_APP_HOME = process.env.HERDR_APP_HOME || path.join(os.homedir(), '.config', 'herdr-app');
const DEPLOYED = path.join(HERDR_APP_HOME, 'mods', 'folders');

test('generated folders mod copies match core/ (run node app-mod/scripts/sync-core.js)', () => {
  for (const [file, content] of generate()) {
    const onDisk = fs.readFileSync(path.join(OUT, file), 'utf8');
    assert.equal(onDisk, content, `${file} drifted from core/: run node app-mod/scripts/sync-core.js`);
  }
});

test('deployed folders mod equals the repo files (copy app-mod/mods/folders to ~/.config/herdr-app/mods/folders)', { skip: !fs.existsSync(DEPLOYED) && 'no deployed folders mod' }, () => {
  for (const file of MOD_FILES) {
    const repo = fs.readFileSync(path.join(OUT, file), 'utf8');
    const deployed = fs.readFileSync(path.join(DEPLOYED, file), 'utf8');
    assert.equal(deployed, repo, `${file} differs between the repo and ${DEPLOYED}: copy the mod folder again`);
  }
});

test('deployed tabs-folders env.js equals the generated env.js', { skip: !fs.existsSync(path.join(HERDR_APP_HOME, 'mods', 'tabs-folders')) && 'no tabs-folders mod' }, () => {
  const deployed = fs.readFileSync(path.join(HERDR_APP_HOME, 'mods', 'tabs-folders', 'env.js'), 'utf8');
  assert.equal(deployed, generate().get('env.js'), 'copy app-mod/mods/folders/env.js to mods/tabs-folders/env.js');
});
