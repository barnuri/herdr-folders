'use strict';

// Pure logic of the Changes view: diff text to numbered rows, rows to side-by-side pairs.

// Text draws a tab as nothing: pad each to the next 4-column stop.
function untab(text) {
  return text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd(s.length - 1 - ((s.length - 1) % 4) + 4));
}

// Unified diff lines (from the first "@@") to rows: { kind: '@' | '-' | '+' | ' ' | '', number?, old?, next?, text }.
function diffRows(lines) {
  let old = 0;
  let next = 0;
  return lines.map((line) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      return { kind: '@', text: line };
    }
    const kind = line[0];
    const text = untab(line.slice(1)) || ' ';
    if (kind === '-') return { kind, old: old++, text };
    if (kind === '+') return { kind, next: next++, text };
    if (kind === ' ') return { kind, old: old++, next: next++, text };
    return { kind: '', text: line };
  });
}

// Side-by-side rows: a run of "-" lines followed by "+" lines is paired line by line.
// Result: { kind: '@' | '', text } or { left: row | null, right: row | null }.
function sideBySide(rows) {
  const out = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.kind === '@' || row.kind === '') {
      out.push(row);
      i += 1;
    } else if (row.kind === ' ') {
      out.push({ left: row, right: row });
      i += 1;
    } else {
      const removed = [];
      const added = [];
      while (i < rows.length && rows[i].kind === '-') removed.push(rows[i++]);
      while (i < rows.length && rows[i].kind === '+') added.push(rows[i++]);
      const length = Math.max(removed.length, added.length);
      for (let n = 0; n < length; n += 1) out.push({ left: removed[n] || null, right: added[n] || null });
    }
  }
  return out;
}

// Diff text to the lines from the first hunk, or a one-line message when there is none.
function diffLines(text, { binary = false } = {}) {
  const all = text.replace(/\n$/, '').split('\n');
  const first = all.findIndex((line) => line.startsWith('@@'));
  if (first < 0) return [binary || /^Binary files /m.test(text) ? 'Binary file · no text diff' : 'No text diff available'];
  return all.slice(first);
}

module.exports = { untab, diffRows, sideBySide, diffLines };
