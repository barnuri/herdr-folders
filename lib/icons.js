'use strict';

const fs = require('node:fs');

// Nerd Font glyphs (herdr users run a Nerd Font). First matching marker wins.
const FOLDER_TYPES = [
  { markers: ['Cargo.toml'], icon: '\ue7a8', color: 208, label: 'rust' },
  { markers: ['go.mod'], icon: '\ue627', color: 81, label: 'go' },
  { markers: ['pyproject.toml', 'requirements.txt', 'setup.py', 'uv.lock'], icon: '\ue73c', color: 220, label: 'python' },
  { markers: ['bun.lock', 'bun.lockb'], icon: '\ue76f', color: 223, label: 'bun' },
  { markers: ['tsconfig.json'], icon: '\ue628', color: 33, label: 'typescript' },
  { markers: ['package.json'], icon: '\ue718', color: 71, label: 'node' },
  { markers: ['pom.xml', 'build.gradle', 'build.gradle.kts'], icon: '\ue738', color: 167, label: 'java' },
  { markers: ['Chart.yaml'], icon: '\u2388', color: 75, label: 'helm' },
  { markers: ['Dockerfile', 'docker-compose.yml', 'compose.yaml'], icon: '\uf308', color: 39, label: 'docker' },
  { markers: ['SKILL.md', 'CLAUDE.md', 'AGENTS.md'], icon: '\uf544', color: 141, label: 'agent' },
];

const GIT_FOLDER = { icon: '\ue5fb', color: 202, label: 'git' };
const PLAIN_FOLDER = { icon: '\uf07b', color: 179, label: 'folder' };
const OPEN_FOLDER_ICON = '\uf07c';

const cache = new Map();

function folderType(dir, isRepo) {
  const key = `${dir}:${isRepo}`;
  if (cache.has(key)) return cache.get(key);
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // unreadable folder: fall through to the plain icon
  }
  const names = new Set(entries);
  const match = FOLDER_TYPES.find((type) => type.markers.some((marker) => names.has(marker)));
  const result = match || (isRepo ? GIT_FOLDER : PLAIN_FOLDER);
  cache.set(key, result);
  return result;
}

const AGENT_ICON = '\udb81\udea9';
const TERMINAL_ICON = '\uf120';
const BRANCH_ICON = '\ue0a0';

module.exports = { FOLDER_TYPES, GIT_FOLDER, PLAIN_FOLDER, OPEN_FOLDER_ICON, AGENT_ICON, TERMINAL_ICON, BRANCH_ICON, folderType };
