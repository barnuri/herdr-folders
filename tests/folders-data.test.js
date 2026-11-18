'use strict';

// data.js of the folders mod: git reads through herdr's exec. data.js imports "herdr", which only exists inside
// the app, so the test copies data.js and git.js to a temp folder with a stub "herdr" module.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MOD = path.join(__dirname, '..', 'app-mod', 'mods', 'folders');

// exec stub: records each call and answers with the next scripted result.
function setup(results) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folders-data-'));
  fs.copyFileSync(path.join(MOD, 'git.js'), path.join(dir, 'git.js'));
  const data = fs.readFileSync(path.join(MOD, 'data.js'), 'utf8').replace('from "herdr"', 'from "./herdr.js"');
  fs.writeFileSync(path.join(dir, 'data.js'), data);
  fs.writeFileSync(
    path.join(dir, 'herdr.js'),
    `export const calls = [];
     const results = ${JSON.stringify(results)};
     export async function exec(command, args, options) {
       calls.push({ command, args, options });
       return results.shift();
     }`,
  );
  return import(pathToFileURL(path.join(dir, 'data.js')).href).then(async (mod) => ({
    ...mod,
    calls: (await import(pathToFileURL(path.join(dir, 'herdr.js')).href)).calls,
    dir,
  }));
}

test('exec calls in data.js carry the 5 second timeout', async () => {
  const { repoRoot, repoStatus, EXEC_TIMEOUT_MS, calls } = await setup([
    { code: 0, stdout: '/r/a\n' },
    { code: 0, stdout: '# branch.head main\n' },
  ]);
  assert.equal(EXEC_TIMEOUT_MS, 5000);
  await repoRoot('/r/a');
  await repoStatus('/r/a');
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.options.timeout, 5000);
  assert.deepEqual(calls[0].options, { cwd: '/r/a', timeout: 5000 });
});

test('repoRoot returns the trimmed root, and null outside git or for an empty cwd', async () => {
  const { repoRoot, calls } = await setup([{ code: 0, stdout: '/r/a\n' }, { code: 128, stdout: '' }]);
  assert.equal(await repoRoot(''), null);
  assert.equal(calls.length, 0);
  assert.equal(await repoRoot('/r/a'), '/r/a');
  assert.equal(await repoRoot('/tmp/none'), null);
});

test('repoStatus returns null when git fails, so the folder shows no git line', async () => {
  const { repoStatus } = await setup([{ code: 124, stdout: '' }]);
  assert.equal(await repoStatus('/r/a'), null);
});

test('repoStatus passes the read-only git flags', async () => {
  const { repoStatus, calls } = await setup([{ code: 0, stdout: '# branch.head main\n' }]);
  await repoStatus('/r/a');
  assert.ok(calls[0].args.includes('--no-optional-locks'));
  assert.ok(calls[0].args.includes('status'));
});
