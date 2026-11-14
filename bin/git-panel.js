#!/usr/bin/env node
'use strict';

const path = require('node:path');
const os = require('node:os');

const gitApi = require('../lib/git');
const { promptSegments } = require('../lib/prompt');
const { BRANCH_ICON, PLAIN_FOLDER } = require('../lib/icons');
const { ANSI, THEME, fg, bg, truncate, truncateLeft, width, Line, parseInput, keyName } = require('../lib/tui');
const { logError } = require('../lib/log');

const REFRESH_MS = 3000;
const FILE_STATUS_COLOR = { M: THEME.yellow, A: THEME.green, D: THEME.red, R: THEME.blue, C: THEME.blue, T: THEME.yellow, U: THEME.magenta, '?': THEME.green };
const DIFF_BG = { add: [32, 52, 42], del: [62, 36, 48] };

const s = (color, extra = '') => `${extra}${fg(color)}`;

// Parse a unified diff into display rows with old/new line numbers.
function parseDiff(text) {
  const rows = [];
  let oldLine = 0;
  let newLine = 0;
  let hunkSeen = false;
  for (const raw of text.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      hunkSeen = true;
      rows.push({ type: 'hunk', text: raw });
    } else if (/^(diff --git|index |--- |\+\+\+ )/.test(raw) && !hunkSeen) {
      // file headers are shown in the diff title bar instead
    } else if (/^(new file|deleted file|similarity|rename |old mode|new mode|Binary)/.test(raw)) {
      rows.push({ type: 'meta', text: raw });
    } else if (raw.startsWith('+')) {
      rows.push({ type: 'add', text: raw.slice(1), newNo: newLine++ });
    } else if (raw.startsWith('-')) {
      rows.push({ type: 'del', text: raw.slice(1), oldNo: oldLine++ });
    } else if (raw.startsWith('\\')) {
      rows.push({ type: 'meta', text: raw });
    } else if (raw.length || rows.length) {
      rows.push({ type: 'ctx', text: raw.slice(1), oldNo: oldLine++, newNo: newLine++ });
    }
  }
  while (rows.length && rows[rows.length - 1].type === 'ctx' && rows[rows.length - 1].text === '') rows.pop();
  return rows;
}

class GitPanel {
  constructor(repo) {
    this.repo = repo;
    this.name = path.basename(repo);
    this.files = [];
    this.summary = null;
    this.entries = []; // flattened rows of the file list
    this.selected = 0;
    this.listScroll = 0;
    this.diffRows = [];
    this.diffScroll = 0;
    this.diffKey = null;
    this.focus = 'list'; // list | diff | commit
    this.commitMessage = '';
    this.confirm = null;
    this.busy = null;
    this.message = null;
    this.hits = [];
    this.collapsedGroups = {};
  }

  get cols() {
    return process.stdout.columns || 100;
  }

  get rows() {
    return process.stdout.rows || 30;
  }

  get listWidth() {
    return Math.max(28, Math.min(56, Math.floor(this.cols * 0.36)));
  }

  start() {
    process.stdout.write(`${ANSI.altScreenOn}${ANSI.hideCursor}${ANSI.mouseOn}\x1b]2;Git · ${this.name}\x07`);
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => this.guard(() => this.onInput(chunk)));
    process.stdout.on('resize', () => this.render());
    process.on('exit', () => process.stdout.write(`${ANSI.mouseOff}${ANSI.showCursor}${ANSI.altScreenOff}`));
    for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0));
    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
    this.refresh();
  }

  guard(fn) {
    try {
      const result = fn();
      if (result && typeof result.catch === 'function') result.catch((error) => this.fail(error));
    } catch (error) {
      this.fail(error);
    }
  }

  fail(error) {
    logError('git-panel', error);
    this.busy = null;
    this.flash(error.message.split('\n')[0], THEME.red);
  }

  flash(text, color = THEME.muted) {
    this.message = { text, color };
    clearTimeout(this.messageTimer);
    this.messageTimer = setTimeout(() => {
      this.message = null;
      this.render();
    }, 5000);
    this.render();
  }

  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const { summary, files } = await gitApi.status(this.repo);
      this.summary = summary;
      this.files = files;
      this.buildEntries();
      await this.loadDiff();
      this.render();
    } catch (error) {
      this.fail(error);
    } finally {
      this.refreshing = false;
    }
  }

  buildEntries() {
    const previous = this.entries[this.selected];
    const groups = [
      { id: 'conflicts', title: 'Merge Changes', files: this.files.filter((file) => file.conflict), staged: false },
      { id: 'staged', title: 'Staged Changes', files: gitApi.stagedFiles(this.files), staged: true },
      { id: 'changes', title: 'Changes', files: gitApi.unstagedFiles(this.files).filter((file) => !file.conflict), staged: false },
    ];
    this.entries = [];
    for (const group of groups) {
      if (!group.files.length) continue;
      this.entries.push({ type: 'group', group });
      if (this.collapsedGroups[group.id]) continue;
      for (const file of group.files) this.entries.push({ type: 'file', file, staged: group.staged, group });
    }
    if (previous) {
      const same = this.entries.findIndex((entry) => entry.type === previous.type && entry.file?.path === previous.file?.path && entry.staged === previous.staged);
      if (same >= 0) this.selected = same;
    }
    if (this.entries[this.selected]?.type !== 'file') {
      this.selected = Math.max(0, this.entries.findIndex((entry) => entry.type === 'file'));
    }
  }

  async loadDiff(force = false) {
    const entry = this.entries[this.selected];
    if (!entry || entry.type !== 'file') {
      this.diffRows = [];
      this.diffKey = null;
      return;
    }
    const key = `${entry.staged}:${entry.file.path}`;
    const text = await gitApi.diff(this.repo, entry.file, { staged: entry.staged });
    if (key !== this.diffKey || force) this.diffScroll = 0;
    this.diffKey = key;
    this.diffRows = parseDiff(text);
  }

  select(index) {
    this.selected = Math.max(0, Math.min(this.entries.length - 1, index));
    const viewport = this.rows - 4;
    if (this.selected < this.listScroll) this.listScroll = this.selected;
    if (this.selected >= this.listScroll + viewport) this.listScroll = this.selected - viewport + 1;
    this.guard(async () => {
      await this.loadDiff();
      this.render();
    });
    this.render();
  }

  // ----- git actions -------------------------------------------------------

  async run(label, fn, { refresh = true } = {}) {
    if (this.busy) return;
    this.busy = label;
    this.render();
    try {
      const output = await fn();
      this.busy = null;
      const lastLine = String(output || '').trim().split('\n').pop();
      this.flash(lastLine ? `${label}: ${lastLine}` : `${label} done`, THEME.green);
    } catch (error) {
      this.busy = null;
      this.fail(error);
    }
    if (refresh) await this.refresh();
  }

  stageEntry(entry) {
    if (entry.type === 'group') return this.run('stage', () => (entry.group.staged ? gitApi.unstage(this.repo, entry.group.files.map((f) => f.path)) : gitApi.stage(this.repo, entry.group.files.map((f) => f.path))));
    if (entry.staged) return this.run('unstage', () => gitApi.unstage(this.repo, [entry.file.path]));
    return this.run('stage', () => gitApi.stage(this.repo, [entry.file.path]));
  }

  askDiscard(entry) {
    if (entry.type !== 'file' || entry.staged) return;
    this.confirm = {
      text: entry.file.untracked ? `Delete untracked ${entry.file.path}?` : `Discard changes in ${entry.file.path}?`,
      run: () => this.run('discard', () => gitApi.discard(this.repo, entry.file)),
    };
    this.render();
  }

  commit() {
    const message = this.commitMessage.trim();
    if (!message) {
      this.focus = 'commit';
      this.flash('type a commit message first', THEME.yellow);
      return undefined;
    }
    if (!gitApi.stagedFiles(this.files).length) {
      this.flash('nothing staged — stage files first (s / A)', THEME.yellow);
      return undefined;
    }
    return this.run('commit', async () => {
      const output = await gitApi.commit(this.repo, message);
      this.commitMessage = '';
      this.focus = 'list';
      return output;
    });
  }

  // ----- input --------------------------------------------------------------

  onInput(chunk) {
    for (const event of parseInput(chunk)) {
      if (event.type === 'mouse') this.onMouse(event);
      else this.onKey(event.key);
    }
  }

  onMouse(event) {
    if (event.wheel) {
      const delta = event.button === 0 ? -3 : 3;
      if (event.x < this.listWidth) {
        this.listScroll = Math.max(0, Math.min(Math.max(0, this.entries.length - (this.rows - 4)), this.listScroll + delta));
      } else {
        this.diffScroll = Math.max(0, Math.min(Math.max(0, this.diffRows.length - 1), this.diffScroll + delta));
      }
      this.render();
      return;
    }
    if (!event.press || event.motion) return;
    const hit = this.hits.find((candidate) => candidate.y === event.y && event.x >= candidate.x0 && event.x < candidate.x1);
    if (!hit) {
      if (event.x >= this.listWidth) this.focus = 'diff';
      this.render();
      return;
    }
    if (event.button === 2 && hit.action.context) this.guard(hit.action.context);
    else if (event.button === 0) this.guard(hit.action.run);
  }

  onKey(raw) {
    const key = keyName(raw);
    if (this.confirm) {
      if (key === 'y' || key === 'enter') {
        const { run } = this.confirm;
        this.confirm = null;
        this.guard(run);
      } else if (key === 'n' || key === 'escape') {
        this.confirm = null;
        this.render();
      }
      return;
    }
    if (this.focus === 'commit') {
      if (key === 'enter') this.guard(() => this.commit());
      else if (key === 'escape' || key === 'tab') this.focus = 'list';
      else if (key === 'backspace') this.commitMessage = this.commitMessage.slice(0, -1);
      else if (key === 'ctrlC') process.exit(0);
      else if (raw.length === 1 && raw >= ' ') this.commitMessage += raw;
      else if (raw.length > 1 && !raw.startsWith('\x1b')) this.commitMessage += raw.replace(/[\r\n]+/g, ' ');
      this.render();
      return;
    }
    const entry = this.entries[this.selected];
    const viewport = this.rows - 5;
    switch (key) {
      case 'q':
      case 'escape':
      case 'ctrlC':
        process.exit(0);
        break;
      case 'tab':
        this.focus = this.focus === 'list' ? 'diff' : 'list';
        this.render();
        break;
      case 'up':
      case 'k':
        if (this.focus === 'diff') this.scrollDiff(-1);
        else this.select(this.selected - 1);
        break;
      case 'down':
      case 'j':
        if (this.focus === 'diff') this.scrollDiff(1);
        else this.select(this.selected + 1);
        break;
      case 'pageUp':
        this.scrollDiff(-viewport);
        break;
      case 'pageDown':
      case ' ':
        this.scrollDiff(viewport);
        break;
      case 'enter':
        if (entry?.type === 'group') this.toggleGroup(entry.group.id);
        else this.focus = 'diff';
        this.render();
        break;
      case 's':
      case 'u':
        if (entry) this.guard(() => this.stageEntry(entry));
        break;
      case 'd':
        if (entry) this.askDiscard(entry);
        break;
      case 'A':
        this.guard(() => this.run('stage all', () => gitApi.stageAll(this.repo)));
        break;
      case 'U':
        this.guard(() => this.run('unstage all', () => gitApi.unstageAll(this.repo)));
        break;
      case 'c':
        this.focus = 'commit';
        this.render();
        break;
      case 'p':
        this.guard(() => this.run('pull', () => gitApi.pull(this.repo)));
        break;
      case 'P':
        this.guard(() => this.run('push', () => gitApi.push(this.repo)));
        break;
      case 'f':
        this.guard(() => this.run('fetch', () => gitApi.fetch(this.repo)));
        break;
      case 'r':
        this.refresh();
        break;
      default:
        break;
    }
  }

  scrollDiff(delta) {
    this.diffScroll = Math.max(0, Math.min(Math.max(0, this.diffRows.length - 1), this.diffScroll + delta));
    this.render();
  }

  toggleGroup(id) {
    this.collapsedGroups[id] = !this.collapsedGroups[id];
    this.buildEntries();
    this.render();
  }

  // ----- render -------------------------------------------------------------

  toolbar() {
    const line = new Line();
    line.background = THEME.surface;
    line.add(' ');
    line.add(PLAIN_FOLDER.icon, s(PLAIN_FOLDER.color));
    line.add(` ${this.name} `, s(THEME.text, ANSI.bold));
    line.add(`${BRANCH_ICON} `, s(THEME.faint));
    promptSegments(this.summary).forEach((segment, i) => {
      if (i) line.add(' ');
      line.add(segment.text, s(segment.color));
    });
    const behind = this.summary?.behind || 0;
    const ahead = this.summary?.ahead || 0;
    const buttons = [
      [` \uf021 Fetch `, () => this.run('fetch', () => gitApi.fetch(this.repo))],
      [` \uf063 Pull${behind ? ` ${behind}` : ''} `, () => this.run('pull', () => gitApi.pull(this.repo))],
      [` \uf062 Push${ahead ? ` ${ahead}` : ''} `, () => this.run('push', () => gitApi.push(this.repo))],
      [' \uf00d ', () => process.exit(0)],
    ];
    const buttonsWidth = buttons.reduce((sum, [label]) => sum + width(label) + 1, 0);
    line.pad(Math.max(line.cols + 1, this.cols - buttonsWidth));
    for (const [label, run] of buttons) {
      const highlight = (label.includes('Pull') && behind) || (label.includes('Push') && ahead);
      line.add(label, `${bg(highlight ? THEME.accent : THEME.hover)}${fg(highlight ? 16 : THEME.text)}`, { run });
      line.add(' ');
    }
    return line;
  }

  commitLine(widthCols) {
    const line = new Line();
    const active = this.focus === 'commit';
    const placeholder = 'Commit message (c)';
    const text = this.commitMessage || placeholder;
    const fitted = this.commitMessage ? truncateLeft(text, widthCols - 15) : truncate(text, widthCols - 15);
    const box = ` ${fitted}${active ? '\u2588' : ''}`;
    line.add(' ');
    line.add(box.padEnd(widthCols - 13), `${bg(active ? THEME.hover : THEME.surface)}${fg(this.commitMessage ? THEME.text : THEME.faint)}`, {
      run: () => {
        this.focus = 'commit';
        this.render();
      },
    });
    line.add(' ');
    line.add(' \uf00c Commit ', `${bg(THEME.accent)}${fg(THEME.base)}${ANSI.bold}`, { run: () => this.commit() });
    return line;
  }

  listLines(height) {
    const lw = this.listWidth;
    const lines = [];
    const visible = this.entries.slice(this.listScroll, this.listScroll + height);
    visible.forEach((entry, offset) => {
      const index = this.listScroll + offset;
      const line = new Line();
      const selected = index === this.selected;
      if (selected) line.background = this.focus === 'list' ? THEME.selected : THEME.hover;
      const pick = () => this.select(index);
      if (entry.type === 'group') {
        const collapsed = this.collapsedGroups[entry.group.id];
        line.add(` ${collapsed ? '\uf105' : '\uf107'} `, s(THEME.muted), { run: () => this.toggleGroup(entry.group.id) });
        line.add(entry.group.title.toUpperCase(), s(THEME.muted, ANSI.bold), { run: () => this.toggleGroup(entry.group.id) });
        line.add(` ${entry.group.files.length}`, s(THEME.faint));
        const action = entry.group.staged ? ' \uf068 ' : ' \uf067 ';
        line.pad(lw - 4);
        line.add(action, s(entry.group.staged ? THEME.yellow : THEME.green), { run: () => this.stageEntry(entry) });
      } else {
        const file = entry.file;
        const code = entry.staged ? file.index : file.untracked ? 'U' : file.conflict ? '!' : file.worktree;
        const colorKey = file.untracked ? '?' : entry.staged ? file.index : file.worktree;
        const base = path.basename(file.path);
        const dir = path.dirname(file.path) === '.' ? '' : path.dirname(file.path);
        line.add('   ');
        line.add(base, s(file.index === 'D' || file.worktree === 'D' ? THEME.red : THEME.text, file.index === 'D' || file.worktree === 'D' ? ANSI.dim : ''), { run: pick, context: () => this.stageEntry(entry) });
        const actions = entry.staged ? [[' \uf068', () => this.stageEntry(entry), THEME.yellow]] : [[' \uf0e2', () => this.askDiscard(entry), THEME.red], [' \uf067', () => this.stageEntry(entry), THEME.green]];
        const tail = 2 + actions.length * 2 + 1;
        const room = lw - line.cols - tail - 1;
        if (dir && room > 4) line.add(` ${truncateLeft(dir, room)}`, s(THEME.faint), { run: pick });
        line.pad(lw - tail);
        for (const [glyph, run, color] of actions) line.add(glyph, s(color), { run });
        line.add(` ${code}`, s(FILE_STATUS_COLOR[colorKey] || THEME.muted, ANSI.bold), { run: pick });
      }
      lines.push(line);
    });
    if (!this.entries.length) {
      const line = new Line();
      line.add(this.summary ? '  \uf00c working tree clean' : '  loading…', s(THEME.green));
      lines.push(line);
    }
    return lines;
  }

  diffLines(height, dw) {
    const lines = [];
    const entry = this.entries[this.selected];
    const header = new Line();
    header.background = THEME.surface;
    if (entry?.type === 'file') {
      header.add(` ${truncateLeft(entry.file.path, dw - 16)}`, s(THEME.text, ANSI.bold));
      header.add(entry.staged ? '  staged' : entry.file.untracked ? '  untracked' : '  working tree', s(THEME.faint));
    } else {
      header.add(' select a file to see its diff', s(THEME.faint));
    }
    lines.push(header);
    const numberWidth = Math.max(3, String(this.diffRows.reduce((max, row) => Math.max(max, row.oldNo || 0, row.newNo || 0), 0)).length);
    for (const row of this.diffRows.slice(this.diffScroll, this.diffScroll + height - 1)) {
      const line = new Line();
      const text = row.text.replace(/\t/g, '    ');
      if (row.type === 'meta') {
        line.add(` ${truncate(text, dw - 2)}`, s(THEME.faint, ANSI.italic));
      } else if (row.type === 'hunk') {
        line.background = THEME.hover;
        line.add(` ${truncate(text, dw - 2)}`, s(THEME.cyan));
      } else {
        const oldNo = row.oldNo ? String(row.oldNo).padStart(numberWidth) : ' '.repeat(numberWidth);
        const newNo = row.newNo ? String(row.newNo).padStart(numberWidth) : ' '.repeat(numberWidth);
        const sign = row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ';
        if (row.type !== 'ctx') line.background = DIFF_BG[row.type];
        line.add(` ${oldNo} ${newNo} `, s(row.type === 'ctx' ? THEME.faint : THEME.muted));
        line.add(`${sign} `, s(row.type === 'add' ? THEME.green : row.type === 'del' ? THEME.red : THEME.faint));
        line.add(truncate(text, dw - line.cols - 1), s(row.type === 'ctx' ? THEME.muted : THEME.text));
      }
      lines.push(line);
    }
    if (entry?.type === 'file' && !this.diffRows.length) {
      const line = new Line();
      line.add(' no textual diff (binary or empty file)', s(THEME.faint));
      lines.push(line);
    }
    return lines;
  }

  statusLine() {
    const line = new Line();
    line.background = THEME.surface;
    if (this.confirm) {
      line.add(` ${this.confirm.text} `, s(THEME.yellow, ANSI.bold));
      line.add(' Yes (y) ', `${bg(THEME.red)}${fg(THEME.base)}`, { run: () => this.onKey('y') });
      line.add(' ');
      line.add(' No (n) ', `${bg(THEME.hover)}${fg(THEME.text)}`, { run: () => this.onKey('n') });
    } else if (this.busy) {
      line.add(` \uf110 ${this.busy}…`, s(THEME.accent));
    } else if (this.message) {
      line.add(` ${truncate(this.message.text, this.cols - 2)}`, s(this.message.color));
    } else {
      line.add(truncate(' s stage/unstage · d discard · A/U all · c commit · p pull · P push · f fetch · tab diff · q close', this.cols - 1), s(THEME.faint));
    }
    return line;
  }

  render() {
    const cols = this.cols;
    const rows = this.rows;
    const lw = this.listWidth;
    const dw = cols - lw - 1;
    const bodyRows = rows - 2;

    const toolbar = this.toolbar();
    const commit = this.commitLine(lw);
    const rule = new Line();
    rule.add('\u2500'.repeat(lw), s(THEME.border));
    const list = this.listLines(bodyRows - 2);
    const diff = this.diffLines(bodyRows, dw);

    this.hits = [];
    let output = '';
    const put = (line, y, x, w) => {
      for (const hit of line.hits) this.hits.push({ x0: hit.x0 + x, x1: hit.x1 + x, y, action: hit.action });
      output += `\x1b[${y + 1};${x + 1}H${line.render(w)}`;
    };
    put(toolbar, 0, 0, cols);
    const left = [commit, rule, ...list];
    for (let y = 0; y < bodyRows; y += 1) {
      put(left[y] || new Line(), y + 1, 0, lw);
      output += `\x1b[${y + 2};${lw + 1}H${fg(this.focus === 'diff' ? THEME.accent : THEME.border)}\u2502${ANSI.reset}`;
      put(diff[y] || new Line(), y + 1, lw + 1, dw);
    }
    put(this.statusLine(), rows - 1, 0, cols);
    process.stdout.write(output);
  }
}

if (require.main === module) {
  const repo = process.env.HERDR_FOLDERS_REPO || process.argv[2] || process.cwd();
  if (!process.stdin.isTTY) {
    process.stdout.write('git panel needs a TTY\n');
    process.exitCode = 1;
  } else {
    gitApi
      .repoRoot(repo)
      .then((root) => {
        if (!root) {
          process.stdout.write(`${repo.replace(os.homedir(), '~')} is not a git repository\n`);
          setTimeout(() => process.exit(1), 2000);
          return;
        }
        new GitPanel(root).start();
      })
      .catch((error) => {
        logError('git-panel', error);
        process.exit(1);
      });
  }
}

module.exports = { GitPanel, parseDiff };
