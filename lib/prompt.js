'use strict';

const { THEME } = require('./tui');
const { isClean } = require('./git');

// Segments of the minimal-git prompt block: (branch ↓behind ↑ahead +new ?untracked ±mod -del !conflict)
function promptSegments(summary) {
  if (!summary) return [];
  if (summary.error) return [{ text: '(…)', color: THEME.red }];
  const segments = [{ text: summary.branch || 'no branch', color: summary.branch ? THEME.cyan : THEME.red, key: 'branch' }];
  if (isClean(summary)) {
    segments.push({ text: '=', color: THEME.cyan, key: 'clean' });
    return segments;
  }
  const counters = [
    ['behind', '\u2193', THEME.red],
    ['ahead', '\u2191', THEME.cyan],
    ['added', '+', THEME.green],
    ['untracked', '?', THEME.yellow],
    ['modified', '\u00b1', THEME.cyan],
    ['deleted', '-', THEME.red],
    ['conflicts', '!', THEME.magenta],
  ];
  for (const [key, symbol, color] of counters) {
    if (summary[key]) segments.push({ text: `${symbol}${summary[key]}`, color, key });
  }
  return segments;
}

function promptText(summary) {
  return promptSegments(summary)
    .map((segment) => segment.text)
    .join(' ');
}

module.exports = { promptSegments, promptText };
