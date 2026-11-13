#!/usr/bin/env node
'use strict';

const os = require('node:os');

const herdrApi = require('../lib/herdr');
const { collect } = require('../lib/snapshot');
const { planClose } = require('../lib/model');
const { CLOSE_MENU } = require('./sidebar');
const { ANSI, THEME, STATUS_STYLE, fg, bg, statusGlyph, truncate, parseInput, keyName } = require('../lib/tui');

// Popup used by the bulk-close actions: list what would close, then close on "y".
async function main() {
  const mode = process.env.HERDR_FOLDERS_CLOSE_MODE || process.argv[2];
  const entry = CLOSE_MENU.find((candidate) => candidate.mode === mode);
  if (!entry) {
    process.stdout.write(`unknown close mode: ${mode}\n`);
    setTimeout(() => process.exit(1), 2000);
    return;
  }
  const { folders } = await collect({ withGit: false });
  const targets = planClose(folders, mode);
  const cols = process.stdout.columns || 60;
  const out = [`${ANSI.clear}${ANSI.home}${ANSI.hideCursor}`, `\n ${ANSI.bold}${fg(THEME.text)}${entry.label}${ANSI.reset}\n\n`];
  if (!targets.length) {
    out.push(` ${fg(THEME.muted)}Nothing to close.${ANSI.reset}\n`);
    process.stdout.write(out.join(''));
    setTimeout(() => process.exit(0), 1500);
    return;
  }
  for (const pane of targets) {
    const style = STATUS_STYLE[pane.status] || STATUS_STYLE.unknown;
    const name = pane.kind === 'agent' ? pane.agent : pane.command || 'shell';
    out.push(`  ${fg(style.color)}${statusGlyph(pane.status)}${ANSI.reset} ${truncate(`${name}  ${pane.cwd.replace(os.homedir(), '~')}`, cols - 6)}\n`);
  }
  out.push(`\n ${bg(THEME.red)}${fg(16)} Close ${targets.length} (y) ${ANSI.reset}  ${bg(THEME.hover)}${fg(THEME.text)} Cancel (n) ${ANSI.reset}\n`);
  process.stdout.write(out.join(''));
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    for (const event of parseInput(chunk)) {
      if (event.type !== 'key') continue;
      const key = keyName(event.key);
      if (key === 'y' || key === 'enter') {
        await Promise.allSettled(targets.map((pane) => herdrApi.closePane(pane.paneId)));
        process.exit(0);
      }
      if (key === 'n' || key === 'escape' || key === 'q' || key === 'ctrlC') process.exit(0);
    }
  });
}

main().catch((error) => {
  process.stdout.write(`${error.message}\n`);
  setTimeout(() => process.exit(1), 3000);
});
