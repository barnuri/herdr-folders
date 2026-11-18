'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseStatus, formatGitLine, emptySummary } = require('../core/git');

test('formatGitLine shows "=" for a clean repo', () => {
  const summary = { ...emptySummary(), branch: 'main' };
  assert.equal(formatGitLine(summary), 'main =');
});

test('formatGitLine lists each non-zero count in prompt order', () => {
  const summary = { ...emptySummary(), branch: 'feat/x', behind: 1, ahead: 2, added: 3, untracked: 4, modified: 5, deleted: 6, conflicts: 7 };
  assert.equal(formatGitLine(summary), 'feat/x ↓1 ↑2 +3 ?4 ±5 -6 !7');
});

test('formatGitLine names a detached HEAD', () => {
  assert.equal(formatGitLine({ ...emptySummary(), branch: null, untracked: 2 }), 'detached ?2');
});

test('parseStatus counts porcelain v2 lines into the git line', () => {
  const porcelain = [
    '# branch.head main',
    '# branch.ab +1 -2',
    '1 .M N... 100644 100644 100644 a b src/a.js',
    '? new.txt',
  ].join('\n');
  const { summary } = parseStatus(porcelain);
  assert.equal(formatGitLine(summary), 'main ↓2 ↑1 ?1 ±1');
});
