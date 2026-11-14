'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Settings that hide herdr's own sidebar. `sidebar_collapsed_mode` applies on config reload;
// `sidebar_start_collapsed` applies when a client attaches.
const MANAGED = [
  ['sidebar_start_collapsed', 'true'],
  ['sidebar_collapsed_mode', '"hidden"'],
];
const OWN_MARK = '# herdr-folders';
const DISABLED_PREFIX = '# herdr-folders-disabled: ';

function configPath() {
  return process.env.HERDR_CONFIG_PATH || path.join(os.homedir(), '.config', 'herdr', 'config.toml');
}

const isHeader = (line) => /^\s*\[/.test(line);
const isUiHeader = (line) => /^\s*\[ui\]\s*(#.*)?$/.test(line);

function isReplaced(text) {
  return text.split('\n').some((line) => line.trimEnd().endsWith(OWN_MARK));
}

function revert(text) {
  return text
    .split('\n')
    .filter((line) => !line.trimEnd().endsWith(OWN_MARK))
    .map((line) => (line.startsWith(DISABLED_PREFIX) ? line.slice(DISABLED_PREFIX.length) : line))
    .join('\n');
}

// Put our keys at the top of [ui]. A user line for the same key is commented out, not deleted,
// so `revert` gives the file back exactly.
function apply(text) {
  const lines = revert(text).split('\n');
  const ours = MANAGED.map(([key, value]) => `${key} = ${value} ${OWN_MARK}`);
  let header = lines.findIndex(isUiHeader);
  if (header < 0) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push('[ui]');
    header = lines.length - 1;
  }
  for (let i = header + 1; i < lines.length && !isHeader(lines[i]); i += 1) {
    if (MANAGED.some(([key]) => new RegExp(`^\\s*${key}\\s*=`).test(lines[i]))) {
      lines[i] = `${DISABLED_PREFIX}${lines[i]}`;
    }
  }
  lines.splice(header + 1, 0, ...ours);
  return lines.join('\n');
}

function read() {
  try {
    return fs.readFileSync(fs.realpathSync(configPath()), 'utf8');
  } catch {
    return '';
  }
}

// Write through the real path in place, so a symlinked config stays a symlink.
function write(text) {
  let target = configPath();
  try {
    target = fs.realpathSync(target);
  } catch {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  fs.writeFileSync(target, text, 'utf8');
}

// The key the user presses to toggle herdr's sidebar, for the "press X once" hint.
function toggleSidebarKey(text) {
  const prefix = /^\s*prefix\s*=\s*"([^"]+)"/m.exec(text)?.[1] || 'ctrl+b';
  const toggle = /^\s*toggle_sidebar\s*=\s*"([^"]+)"/m.exec(text)?.[1] || 'prefix+b';
  return toggle.startsWith('prefix+') ? `${prefix}, then ${toggle.slice('prefix+'.length)}` : toggle;
}

module.exports = { MANAGED, OWN_MARK, configPath, isReplaced, apply, revert, read, write, toggleSidebarKey };
