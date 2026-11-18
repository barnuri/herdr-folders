#!/usr/bin/env node
'use strict';

// The TUI CLI (bin/folders.js) for the herdr desktop app. Same command names, JSON on stdout.
// Settings go through state.json (shared with the app mod, which picks them up at once through
// folders.pull-prefs); pane actions go through `herdr-app do`; git commands reuse folders.js.
// Not available in the app (no such concept): panel toggle|open|close, dock, confirm-close popup.

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FOLDERS_CLI = path.join(__dirname, 'folders.js');
const APP = process.env.HERDR_APP_BIN || 'herdr-app';

function app(args) {
  const out = execFileSync(APP, args, { encoding: 'utf8', timeout: 20000 });
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

const mod = (name) => app(['do', `folders.${name}`]);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const delegate = (args) => {
  const r = spawnSync('node', [FOLDERS_CLI, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(JSON.parse(r.stderr || '{"error":"failed"}').error);
  return r.stdout ? JSON.parse(r.stdout) : undefined;
};

function snapshot() {
  mod('snapshot');
  const file = path.join(process.env.HERDR_APP_HOME || path.join(os.homedir(), '.config', 'herdr-app'), 'shared.json');
  const before = Date.now() - 5000;
  for (let i = 0; i < 20; i++) {
    sleep(300);
    const shared = JSON.parse(fs.readFileSync(file, 'utf8'));
    const snap = shared['folders.snapshot'];
    if (snap && snap.at >= before) return snap.folders;
  }
  throw new Error('the folders mod did not answer: is the mod loaded?');
}

function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const [command, ...rest] = args;
  const set = (name, value) => {
    delegate([name, value]);
    mod('pull-prefs');
    return { [name]: value };
  };
  switch (command) {
    case 'snapshot':
      return snapshot();
    case 'expand-all':
    case 'collapse-all':
      return mod(command);
    case 'expand-agents':
    case 'collapse-agents':
      delegate([command]);
      mod('pull-prefs');
      return { agentsExpanded: command === 'expand-agents' };
    case 'grouping':
    case 'sort':
    case 'spacing':
    case 'collapsible':
    case 'card-backgrounds':
    case 'projects-tab':
    case 'view':
      return set(command, rest[0]);
    case 'focus':
      return app(['do', 'pane.focus', '--pane', rest[0]]);
    case 'new-tab': {
      const folder = path.resolve(rest[0] || process.cwd());
      const space = snapshot().find((f) => f.path === folder);
      return space ? app(['do', 'tab.new', '--folder', folder, '--name', path.basename(folder)]) : app(['do', 'space.new', '--folder', folder, '--name', path.basename(folder)]);
    }
    case 'close': {
      const mode = rest[0];
      if (!['empty-folders', 'idle-agents-and-empty-folders', 'terminals', 'all'].includes(mode)) throw new Error('unknown close mode');
      mod(`close-${mode}`); // the panel shows its confirmation
      if (!flags.has('--yes')) return { mode, pending: true, hint: 'the panel asks to confirm; pass --yes to confirm now' };
      return { mode, confirmed: mod('confirm') };
    }
    case 'replace':
      if (rest[0] === 'on' || rest[0] === 'off') return mod(`replace-${rest[0]}`);
      throw new Error('replace needs on or off');
    case 'panel':
      if (rest[0] === 'hide') return app(['do', 'layout.hide', '--id', 'folders']);
      if (rest[0] === 'show') return app(['do', 'layout.show', '--id', 'folders']);
      if (rest[0] === 'grow' || rest[0] === 'shrink') return mod(rest[0] === 'grow' ? 'key-]' : 'key-[');
      if (rest[0] === 'width') return mod(`width-${Math.round(Number(rest[1]) * 8.4)}`);
      throw new Error('in the app, panel supports hide|show|grow|shrink|width (no toggle/open/close)');
    case 'projects':
    case 'git-status':
    case 'git-diff':
    case 'git-action':
      return delegate(argv);
    case 'open-project': {
      mod(`filter-${rest[0] || ''}`);
      const result = mod(`open-project-1${flags.has('--tab') ? '-tab' : ''}`);
      mod('filter-');
      return { opened: rest[0], result };
    }
    case 'git': {
      const folder = path.resolve(rest[0] || process.cwd());
      return mod(`changes-path-${folder}`);
    }
    default:
      process.stdout.write('herdr-folders-app: snapshot | expand-all | collapse-all | expand-agents | collapse-agents | grouping | sort | spacing | collapsible | card-backgrounds | projects-tab | view | focus | new-tab | close <mode> [--yes] | replace on|off | panel hide|show|grow|shrink|width | projects | open-project | git <folder> | git-status | git-diff | git-action\n');
      return undefined;
  }
}

try {
  const result = main(process.argv.slice(2));
  if (result !== undefined) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exitCode = 1;
}
