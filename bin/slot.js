#!/usr/bin/env node
'use strict';

// A placeholder for the folders panel in a tab the user is not looking at. It shows the panel's
// last frame, so the tab already looks right, and it holds the panel's place and width: on a tab
// switch the real panel moves in beside it and this pane closes.

const fs = require('node:fs');
const path = require('node:path');

const { fitWidth } = require('../lib/fit');
const { stateDir, loadState } = require('../lib/state');
const { ANSI } = require('../lib/tui');

const FRAME_FILE = path.join(stateDir(), 'frame.ansi');
const paneId = process.env.HERDR_PANE_ID || null;

function draw() {
  let frame = '';
  try {
    frame = fs.readFileSync(FRAME_FILE, 'utf8');
  } catch {
    frame = `${ANSI.home}${ANSI.clear}\x1b[2m Folders\x1b[0m`;
  }
  process.stdout.write(`${ANSI.clear}${frame}`);
}

if (require.main === module) {
  process.stdout.write(`${ANSI.altScreenOn}${ANSI.hideCursor}\x1b]2;Folders slot\x07`);
  process.on('exit', () => process.stdout.write(`${ANSI.showCursor}${ANSI.altScreenOff}`));
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(signal, () => process.exit(0));
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }
  draw();
  fs.watchFile(FRAME_FILE, { interval: 2000 }, draw);
  process.stdout.on('resize', draw);
  if (paneId) {
    const state = loadState();
    fitWidth(paneId, state.hidden ? 4 : state.width, () => process.stdout.columns || 0).catch(() => {});
  }
}
