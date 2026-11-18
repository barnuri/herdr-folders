'use strict';

// Generates the ESM copies of core/ that the folders mod imports.
// Run: node app-mod/scripts/sync-core.js. Never edit the generated files by hand.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const CORE = path.join(ROOT, 'core');
const OUT = path.join(ROOT, 'app-mod', 'mods', 'folders');
const FILES = ['model.js', 'orch.js', 'git.js', 'difflogic.js', 'fuzzy.js', 'env.js'];
const HEADER = '// GENERATED from core/ by app-mod/scripts/sync-core.js. Do not edit.\n';
const BASENAME = "const basename = (p) => p.split('/').filter(Boolean).pop() || '';\n";

function toEsm(file, src) {
  let out = src.replace(/^'use strict';\n\n?/, '');
  out = out.replace(/^const path = require\('node:path'\);\n\n?/m, '');
  out = out.replace(/path\.basename\(/g, 'basename(');
  if (out.includes('basename(')) {
    out = out.replace(/^\n*/, '\n').replace(/^/, BASENAME);
  }
  out = out.replace(/^const \{ (\w+) \} = require\('\.\/(\w+)'\);$/m, "import { $1 } from './$2.js';");
  out = out.replace(/^module\.exports = (\{[\s\S]*?\});$/m, 'export $1;');
  const leftover = out.match(/require\(|module\.exports/);
  if (leftover) throw new Error(`${file}: CJS construct left after conversion: ${leftover[0]}`);
  return HEADER + out;
}

// Map of generated file name to its content, built from core/ only.
function generate() {
  const result = new Map();
  for (const file of FILES) {
    result.set(file, toEsm(file, fs.readFileSync(path.join(CORE, file), 'utf8')));
  }
  return result;
}

function write() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [file, content] of generate()) {
    fs.writeFileSync(path.join(OUT, file), content);
  }
  // The sidebar mods keep their own copy of the env classification.
  for (const mod of ['spaces-folders', 'agents-folders']) {
    const dir = path.join(OUT, '..', mod);
    if (fs.existsSync(dir)) fs.writeFileSync(path.join(dir, 'env.js'), generate().get('env.js'));
  }
}

module.exports = { generate, OUT, toEsm };

if (require.main === module) {
  write();
  console.log(`synced ${FILES.join(', ')} to ${path.relative(ROOT, OUT)}`);
}
