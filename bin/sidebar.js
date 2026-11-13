#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');

const herdrApi = require('../lib/herdr');
const { collect } = require('../lib/snapshot');
const { planClose, displayTitle } = require('../lib/model');
const { loadState, updateState, statePath } = require('../lib/state');
const { folderType, OPEN_FOLDER_ICON, AGENT_ICON, TERMINAL_ICON, BRANCH_ICON } = require('../lib/icons');
const { promptSegments } = require('../lib/prompt');
const { ANSI, THEME, STATUS_STYLE, fg, bg, statusGlyph, truncate, truncateLeft, width, Line, parseInput, keyName } = require('../lib/tui');
const { logError } = require('../lib/log');

const REFRESH_MS = 2500;
const SPIN_MS = 120;
const HIDDEN_COLS = 4;
const MIN_COLS = 24;
const MAX_COLS = 120;
const RESIZE_STEP_COLS = 6;
const HEADER_ROWS = 3;
const FOOTER_ROWS = 1;

const CLOSE_MENU = [
  { mode: 'empty-folders', label: 'Close empty folders' },
  { mode: 'idle-agents-and-empty-folders', label: 'Close idle agents + empty folders' },
  { mode: 'terminals', label: 'Close all terminals (keep agents)' },
  { mode: 'all', label: 'Close everything' },
];

const s = (color, extra = '') => `${extra}${fg(color)}`;

class Sidebar {
  constructor() {
    this.paneId = process.env.HERDR_PANE_ID || null;
    this.folders = [];
    this.state = loadState();
    this.lastCommandSeq = this.state.command?.seq || 0;
    this.selected = 0;
    this.scroll = 0;
    this.frame = 0;
    this.menu = null; // null | 'close' | { confirm: mode, targets }
    this.message = null;
    this.hits = [];
    this.selectable = [];
    this.drag = null;
    this.resizing = false;
    this.loading = true;
  }

  get cols() {
    return process.stdout.columns || 40;
  }

  get rows() {
    return process.stdout.rows || 24;
  }

  start() {
    if (!process.stdin.isTTY) {
      process.stdout.write('herdr-folders sidebar needs a TTY (run it inside a herdr pane)\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${ANSI.altScreenOn}${ANSI.hideCursor}${ANSI.mouseOn}\x1b]2;Folders\x07`);
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => this.guard(() => this.onInput(chunk)));
    process.stdout.on('resize', () => this.render());
    process.on('exit', () => process.stdout.write(`${ANSI.mouseOff}${ANSI.showCursor}${ANSI.altScreenOff}`));
    for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(signal, () => process.exit(0));

    fs.watchFile(statePath(), { interval: 400 }, () => this.guard(() => this.onStateFile()));
    this.refreshTimer = setInterval(() => this.refresh(), REFRESH_MS);
    this.spinTimer = setInterval(() => {
      this.frame += 1;
      if (this.folders.some((folder) => folder.panes.some((pane) => pane.status === 'working'))) this.render();
    }, SPIN_MS);
    this.render();
    this.refresh();
    this.applyWidth(this.state.hidden ? HIDDEN_COLS : this.state.width);
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
    logError('sidebar', error);
    this.flash(error.message, THEME.red);
  }

  flash(text, color = THEME.muted) {
    this.message = { text, color };
    clearTimeout(this.messageTimer);
    this.messageTimer = setTimeout(() => {
      this.message = null;
      this.render();
    }, 4000);
    this.render();
  }

  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const { folders } = await collect({ excludePaneIds: this.paneId ? [this.paneId] : [] });
      this.folders = folders;
      this.loading = false;
      this.render();
    } catch (error) {
      this.fail(error);
    } finally {
      this.refreshing = false;
    }
  }

  onStateFile() {
    const previousHidden = this.state.hidden;
    this.state = loadState();
    const command = this.state.command;
    if (command && command.seq !== this.lastCommandSeq) {
      this.lastCommandSeq = command.seq;
      if (command.name === 'resize') this.resizeBy(command.args.delta);
      if (command.name === 'width') this.setWidth(command.args.cols);
    }
    if (previousHidden !== this.state.hidden) this.applyWidth(this.state.hidden ? HIDDEN_COLS : this.state.width);
    this.render();
  }

  save(mutate) {
    this.state = updateState(mutate);
    this.lastCommandSeq = this.state.command?.seq || this.lastCommandSeq;
  }

  // ----- sizing -------------------------------------------------------------

  async applyWidth(target) {
    if (!this.paneId || this.resizing) return;
    this.resizing = true;
    try {
      // The sidebar sits on the right edge, so its movable border is on the left.
      // `pane resize --amount` is a fraction of the split, so convert columns with the tab width.
      const layout = (await herdrApi.herdr(['pane', 'layout', '--pane', this.paneId]).catch(() => null))?.layout;
      const total = layout?.area?.width || this.cols * 3;
      for (let step = 0; step < 8; step += 1) {
        const diff = target - this.cols;
        if (Math.abs(diff) < 1) break;
        const before = this.cols;
        const amount = Math.min(0.9, Math.max(0.005, Math.abs(diff) / total));
        await herdrApi.resizePane(this.paneId, diff > 0 ? 'left' : 'right', amount.toFixed(4)).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 80));
        if (this.cols === before) break;
      }
    } finally {
      this.resizing = false;
      this.render();
    }
  }

  setWidth(cols) {
    const clamped = Math.max(MIN_COLS, Math.min(MAX_COLS, Math.round(cols)));
    this.save((state) => {
      state.width = clamped;
      state.hidden = false;
    });
    return this.applyWidth(clamped);
  }

  resizeBy(delta) {
    return this.setWidth((this.state.hidden ? this.state.width : this.cols) + delta);
  }

  toggleHidden() {
    const hidden = !this.state.hidden;
    this.save((state) => {
      if (hidden) state.width = this.cols;
      state.hidden = hidden;
    });
    return this.applyWidth(hidden ? HIDDEN_COLS : this.state.width);
  }

  // ----- actions ------------------------------------------------------------

  toggleFolder(folderPath) {
    this.save((state) => {
      if (state.collapsed[folderPath]) delete state.collapsed[folderPath];
      else state.collapsed[folderPath] = true;
    });
    this.render();
  }

  setAllCollapsed(collapsed) {
    this.save((state) => {
      state.collapsed = {};
      if (collapsed) for (const folder of this.folders) state.collapsed[folder.path] = true;
    });
    this.render();
  }

  agentExpanded(paneId) {
    return this.state.allAgentsExpanded ? !this.state.expandedAgents[paneId] : Boolean(this.state.expandedAgents[paneId]);
  }

  toggleAgent(paneId) {
    this.save((state) => {
      if (state.expandedAgents[paneId]) delete state.expandedAgents[paneId];
      else state.expandedAgents[paneId] = true;
    });
    this.render();
  }

  toggleAllAgents() {
    this.save((state) => {
      state.allAgentsExpanded = !state.allAgentsExpanded;
      state.expandedAgents = {};
    });
    // Expanding agents also opens their folders, or the details stay out of sight.
    if (this.state.allAgentsExpanded) {
      this.save((state) => {
        for (const folder of this.folders) if (folder.agentCount) delete state.collapsed[folder.path];
      });
    }
    this.render();
  }

  async focus(pane) {
    await herdrApi.focusPane(pane);
    this.flash(`focused ${pane.kind === 'agent' ? pane.agent : 'terminal'} ${pane.paneId}`);
  }

  async openGit(folder) {
    if (!folder.isRepo) {
      this.flash(`${folder.name} is not a git repo`, THEME.yellow);
      return;
    }
    await herdrApi.openPluginPane('git', { placement: 'popup', width: '90%', height: '85%', env: { HERDR_FOLDERS_REPO: folder.path } });
  }

  openCloseMenu() {
    this.menu = this.menu === 'close' ? null : 'close';
    this.render();
  }

  askClose(mode) {
    const targets = planClose(this.folders, mode);
    if (!targets.length) {
      this.menu = null;
      this.flash('nothing to close', THEME.muted);
      return;
    }
    this.menu = { confirm: mode, targets };
    this.render();
  }

  async confirmClose() {
    const { targets } = this.menu;
    this.menu = null;
    const results = await Promise.allSettled(targets.map((pane) => herdrApi.closePane(pane.paneId)));
    const failed = results.filter((result) => result.status === 'rejected').length;
    this.flash(`closed ${targets.length - failed} pane(s)${failed ? `, ${failed} failed` : ''}`, failed ? THEME.red : THEME.green);
    this.refresh();
  }

  // ----- input --------------------------------------------------------------

  onInput(chunk) {
    for (const event of parseInput(chunk)) {
      if (event.type === 'mouse') this.onMouse(event);
      else this.onKey(keyName(event.key));
    }
  }

  onMouse(event) {
    if (event.wheel) {
      this.scrollBy(event.button === 0 ? -3 : 3);
      return;
    }
    if (this.drag) {
      if (event.press && event.motion) {
        // Each step moves the border, so the grip stays under the pointer: apply the delta once.
        const delta = this.drag.x - event.x;
        if (delta !== 0 && !this.resizing) {
          this.drag.x = event.x;
          this.resizeBy(delta);
        }
        return;
      }
      if (!event.press) {
        this.drag = null;
        this.render();
        return;
      }
    }
    if (!event.press || event.motion) return;
    if (event.x === 0 && event.button === 0 && !this.state.hidden) {
      this.drag = { x: event.x };
      this.render();
      return;
    }
    const hit = this.hits.find((candidate) => candidate.y === event.y && event.x >= candidate.x0 && event.x < candidate.x1);
    if (!hit) return;
    if (event.button === 2) {
      if (hit.action.context) this.guard(hit.action.context);
      return;
    }
    if (event.button === 0) {
      if (hit.action.select !== undefined) this.selected = hit.action.select;
      this.guard(hit.action.run);
    }
  }

  onKey(key) {
    if (this.menu && typeof this.menu === 'object') {
      if (key === 'y' || key === 'enter') this.guard(() => this.confirmClose());
      else if (key === 'n' || key === 'escape' || key === 'q') {
        this.menu = null;
        this.render();
      }
      return;
    }
    const item = this.selectable[this.selected];
    switch (key) {
      case 'ctrlC':
        process.exit(0);
        break;
      case 'up':
      case 'k':
        this.move(-1);
        break;
      case 'down':
      case 'j':
        this.move(1);
        break;
      case 'pageUp':
        this.move(-10);
        break;
      case 'pageDown':
        this.move(10);
        break;
      case 'enter':
        if (item) this.guard(item.run);
        break;
      case ' ':
      case 'right':
      case 'left':
        if (item?.toggle) this.guard(item.toggle);
        break;
      case 'g':
        if (item?.folder) this.guard(() => this.openGit(item.folder));
        break;
      case 'e':
        this.setAllCollapsed(false);
        break;
      case 'c':
        this.setAllCollapsed(true);
        break;
      case 'a':
        this.toggleAllAgents();
        break;
      case 'x':
        this.openCloseMenu();
        break;
      case '1':
      case '2':
      case '3':
      case '4':
        if (this.menu === 'close') this.askClose(CLOSE_MENU[Number(key) - 1].mode);
        break;
      case '[':
        this.guard(() => this.resizeBy(-RESIZE_STEP_COLS));
        break;
      case ']':
        this.guard(() => this.resizeBy(RESIZE_STEP_COLS));
        break;
      case 'h':
        this.guard(() => this.toggleHidden());
        break;
      case 'r':
        this.refresh();
        break;
      case 'escape':
        this.menu = null;
        this.render();
        break;
      default:
        break;
    }
  }

  move(delta) {
    if (!this.selectable.length) return;
    this.selected = Math.max(0, Math.min(this.selectable.length - 1, this.selected + delta));
    const row = this.selectable[this.selected].line;
    const viewport = this.rows - HEADER_ROWS - FOOTER_ROWS;
    if (row < this.scroll) this.scroll = row;
    if (row >= this.scroll + viewport) this.scroll = row - viewport + 1;
    this.render();
  }

  scrollBy(delta) {
    this.scroll = Math.max(0, this.scroll + delta);
    this.render();
  }

  // ----- render -------------------------------------------------------------

  counts() {
    const counts = { working: 0, blocked: 0, done: 0, idle: 0, running: 0 };
    for (const folder of this.folders) for (const pane of folder.panes) if (counts[pane.status] !== undefined) counts[pane.status] += 1;
    return counts;
  }

  button(line, label, run, color = THEME.muted) {
    line.add(label, s(color), { run });
    line.add(' ');
  }

  headerLines() {
    const cols = this.cols;
    const title = new Line();
    title.background = THEME.surface;
    title.add(' ');
    title.add('\uf07c FOLDERS', s(THEME.text, ANSI.bold));
    const tools = [
      ['\uf102', () => this.setAllCollapsed(true), THEME.muted],
      ['\uf103', () => this.setAllCollapsed(false), THEME.muted],
      [AGENT_ICON, () => this.toggleAllAgents(), this.state.allAgentsExpanded ? THEME.accent : THEME.muted],
      ['\uf068', () => this.resizeBy(-RESIZE_STEP_COLS), THEME.muted],
      ['\uf067', () => this.resizeBy(RESIZE_STEP_COLS), THEME.muted],
      ['\uf101', () => this.toggleHidden(), THEME.muted],
      ['\uf1f8', () => this.openCloseMenu(), this.menu ? THEME.red : THEME.muted],
    ];
    const toolsWidth = tools.length * 2;
    title.pad(Math.max(title.cols + 1, cols - toolsWidth));
    for (const [glyph, run, color] of tools) this.button(title, glyph, run, color);

    const summary = new Line();
    summary.add(' ');
    const counts = this.counts();
    const chips = [
      ['working', counts.working],
      ['blocked', counts.blocked],
      ['done', counts.done],
      ['idle', counts.idle],
      ['running', counts.running],
    ].filter(([, n]) => n > 0);
    if (this.loading) summary.add('loading…', s(THEME.faint));
    else if (!chips.length) summary.add(`${this.folders.length} folders · nothing running`, s(THEME.faint));
    for (const [status, n] of chips) {
      summary.add(`${statusGlyph(status, this.frame)} ${n} ${STATUS_STYLE[status].label}`, s(STATUS_STYLE[status].color));
      summary.add('  ');
    }
    const rule = new Line();
    rule.add('\u2500'.repeat(cols), s(THEME.border));
    return [title, summary, rule];
  }

  bodyLines() {
    const lines = [];
    this.selectable = [];
    const cols = this.cols;
    const addSelectable = (line, item) => {
      item.line = lines.length;
      line.selectIndex = this.selectable.length;
      this.selectable.push(item);
      lines.push(line);
    };

    if (this.menu) return this.menuLines();

    for (const folder of this.folders) {
      const collapsed = Boolean(this.state.collapsed[folder.path]);
      const type = folderType(folder.path, folder.isRepo);
      const toggle = () => this.toggleFolder(folder.path);
      const context = () => this.openGit(folder);
      const run = toggle;

      const head = new Line();
      head.add(' ');
      head.add(collapsed ? '\uf105' : '\uf107', s(THEME.faint), { run: toggle, context });
      head.add(' ');
      head.add(collapsed ? type.icon : type.icon === '\uf07b' ? OPEN_FOLDER_ICON : type.icon, s(type.color), { run, context });
      head.add(' ');
      const badge = [];
      if (folder.status) badge.push([`${statusGlyph(folder.status, this.frame)}`, STATUS_STYLE[folder.status].color]);
      if (folder.agentCount) badge.push([`${AGENT_ICON}${folder.agentCount}`, THEME.muted]);
      if (folder.terminalCount) badge.push([`${TERMINAL_ICON} ${folder.terminalCount}`, THEME.faint]);
      const badgeText = badge.map(([text]) => text).join(' ');
      const nameMax = cols - head.cols - width(badgeText) - 2;
      head.add(truncate(folder.name, nameMax), s(THEME.text, ANSI.bold), { run, context });
      head.pad(cols - width(badgeText) - 1);
      badge.forEach(([text, color], i) => {
        if (i) head.add(' ');
        head.add(text, s(color));
      });
      addSelectable(head, { run, toggle, folder, context });

      if (folder.isRepo && folder.git) {
        const gitLine = new Line();
        gitLine.add('    ');
        gitLine.add(`${BRANCH_ICON} `, s(THEME.faint), { run: context });
        let first = true;
        for (const segment of promptSegments(folder.git)) {
          if (!first) gitLine.add(' ');
          first = false;
          const room = cols - gitLine.cols - 1;
          if (room <= 1) break;
          gitLine.add(truncate(segment.text, room), s(segment.color), { run: context });
        }
        lines.push(gitLine);
      } else if (!folder.isRepo) {
        const pathLine = new Line();
        pathLine.add('    ');
        pathLine.add(truncateLeft(folder.path.replace(os.homedir(), '~'), cols - 5), s(THEME.faint));
        lines.push(pathLine);
      }

      if (collapsed) continue;
      folder.panes.forEach((pane, index) => {
        const last = index === folder.panes.length - 1;
        const branch = last ? '\u2570' : '\u251c';
        const row = new Line();
        row.add(`  ${branch}\u2500`, s(THEME.border));
        const focusRun = () => this.focus(pane);
        if (pane.kind === 'agent') {
          const expanded = this.agentExpanded(pane.paneId);
          const style = STATUS_STYLE[pane.status] || STATUS_STYLE.unknown;
          row.add(statusGlyph(pane.status, this.frame), s(style.color), { run: focusRun, context });
          row.add(' ');
          row.add(AGENT_ICON, s(THEME.accent), { run: focusRun, context });
          row.add(' ');
          const label = pane.name ? `${pane.name} · ${pane.agent}` : pane.agent;
          const right = style.label;
          const room = cols - row.cols - width(right) - 4;
          row.add(truncate(label, room), s(THEME.text), { run: focusRun, context });
          const title = displayTitle(pane);
          if (title && room - width(label) > 4) row.add(` ${truncate(title, room - width(label) - 1)}`, s(THEME.faint), { run: focusRun, context });
          row.pad(cols - width(right) - 3);
          row.add(right, s(style.color));
          row.add(' ');
          row.add(expanded ? '\uf106' : '\uf107', s(THEME.faint), { run: () => this.toggleAgent(pane.paneId) });
          addSelectable(row, { run: focusRun, toggle: () => this.toggleAgent(pane.paneId), folder, pane, context });
          if (expanded) {
            const rail = last ? '   ' : '  \u2502';
            const details = [
              [displayTitle(pane), THEME.muted],
              [`${pane.tabLabel || pane.tabId} · ${pane.paneId}`, THEME.faint],
            ];
            if (pane.cwd !== folder.path) details.push([pane.cwd.replace(folder.path, '.'), THEME.faint]);
            for (const [text, color] of details) {
              if (!text) continue;
              const detail = new Line();
              detail.add(`${rail}   `, s(THEME.border));
              detail.add(truncate(text, cols - detail.cols - 1), s(color), { run: focusRun });
              lines.push(detail);
            }
          }
        } else {
          const style = STATUS_STYLE[pane.status];
          row.add(style.glyph, s(style.color), { run: focusRun, context });
          row.add(' ');
          row.add(TERMINAL_ICON, s(THEME.muted), { run: focusRun, context });
          row.add(' ');
          const subdir = pane.cwd !== folder.path ? ` ${pane.cwd.replace(`${folder.path}/`, '')}` : '';
          const label = `${pane.command || 'shell'}${subdir}`;
          row.add(truncate(label, cols - row.cols - 1), s(pane.busy ? THEME.text : THEME.muted), { run: focusRun, context });
          addSelectable(row, { run: focusRun, folder, pane, context });
        }
      });
    }
    if (!this.loading && !this.folders.length) {
      const empty = new Line();
      empty.add('  no terminals open', s(THEME.faint));
      lines.push(empty);
    }
    return lines;
  }

  menuLines() {
    const lines = [];
    const cols = this.cols;
    const add = (fn) => {
      const line = new Line();
      fn(line);
      lines.push(line);
    };
    if (typeof this.menu === 'object') {
      const { confirm, targets } = this.menu;
      const label = CLOSE_MENU.find((entry) => entry.mode === confirm).label;
      add((line) => line.add(` ${label}?`, s(THEME.text, ANSI.bold)));
      add((line) => line.add(` ${targets.length} pane(s) will close:`, s(THEME.muted)));
      for (const pane of targets.slice(0, Math.max(1, this.rows - 10))) {
        add((line) => {
          const style = STATUS_STYLE[pane.status] || STATUS_STYLE.unknown;
          line.add('   ');
          line.add(statusGlyph(pane.status, this.frame), s(style.color));
          line.add(' ');
          const name = pane.kind === 'agent' ? pane.agent : pane.command || 'shell';
          line.add(truncate(`${name}  ${pane.cwd.replace(os.homedir(), '~')}`, cols - 6), s(THEME.muted));
        });
      }
      if (targets.length > this.rows - 10) add((line) => line.add(`   … ${targets.length - (this.rows - 10)} more`, s(THEME.faint)));
      add(() => {});
      add((line) => {
        line.add('  ');
        line.add(' Close (y) ', `${bg(THEME.red)}${fg(16)}${ANSI.bold}`, { run: () => this.confirmClose() });
        line.add('  ');
        line.add(' Cancel (n) ', `${bg(THEME.hover)}${fg(THEME.text)}`, {
          run: () => {
            this.menu = null;
            this.render();
          },
        });
      });
      return lines;
    }
    add((line) => line.add(' Bulk close', s(THEME.text, ANSI.bold)));
    add(() => {});
    CLOSE_MENU.forEach((entry, i) => {
      const count = planClose(this.folders, entry.mode).length;
      add((line) => {
        line.add('  ');
        line.add(`${i + 1}`, s(THEME.accent, ANSI.bold), { run: () => this.askClose(entry.mode) });
        line.add('  ');
        line.add(truncate(entry.label, cols - 12), s(entry.mode === 'all' ? THEME.red : THEME.text), { run: () => this.askClose(entry.mode) });
        line.pad(cols - 5);
        line.add(String(count).padStart(3), s(count ? THEME.muted : THEME.faint), { run: () => this.askClose(entry.mode) });
      });
    });
    add(() => {});
    add((line) => line.add('  esc to go back', s(THEME.faint), { run: () => this.openCloseMenu() }));
    return lines;
  }

  footerLine() {
    const line = new Line();
    line.background = THEME.surface;
    if (this.message) {
      line.add(` ${truncate(this.message.text, this.cols - 2)}`, s(this.message.color));
    } else if (this.drag) {
      line.add(' drag to resize', s(THEME.accent));
    } else {
      line.add(truncate(' click focus · right-click git · x close · h hide', this.cols - 1), s(THEME.faint));
    }
    return line;
  }

  hiddenLines() {
    const lines = [];
    const show = new Line();
    show.add(this.cols > 10 ? ' \uf100 Folders' : ' \uf100', s(THEME.accent), { run: () => this.toggleHidden() });
    lines.push(show);
    lines.push(new Line());
    for (const folder of this.folders) {
      const line = new Line();
      const type = folderType(folder.path, folder.isRepo);
      const color = folder.status ? STATUS_STYLE[folder.status].color : type.color;
      line.add(' ');
      line.add(folder.status ? statusGlyph(folder.status, this.frame) : type.icon, s(color), { run: () => this.toggleHidden() });
      // herdr keeps panes at a minimum width, so the strip has room for short names
      if (this.cols > 6) line.add(` ${truncate(folder.name, this.cols - 4)}`, s(THEME.muted), { run: () => this.toggleHidden() });
      lines.push(line);
    }
    return lines;
  }

  render() {
    const cols = this.cols;
    const rows = this.rows;
    this.hits = [];
    let screen;
    if (this.state.hidden || cols <= HIDDEN_COLS + 2) {
      screen = this.hiddenLines().slice(0, rows);
    } else {
      const header = this.headerLines();
      const body = this.bodyLines();
      const viewport = rows - HEADER_ROWS - FOOTER_ROWS;
      this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, body.length - viewport)));
      this.selected = Math.max(0, Math.min(this.selected, this.selectable.length - 1));
      const selectedItem = this.selectable[this.selected];
      const visible = body.slice(this.scroll, this.scroll + viewport);
      for (const line of visible) {
        if (!this.menu && selectedItem && line.selectIndex === this.selected) line.background = THEME.hover;
      }
      while (visible.length < viewport) visible.push(new Line());
      screen = [...header, ...visible, this.footerLine()];
    }

    // Column 0 is the drag grip for the left border.
    let output = ANSI.home;
    screen.forEach((line, y) => {
      for (const hit of line.hits) this.hits.push({ ...hit, y });
      output += `\x1b[${y + 1};1H${line.render(cols)}`;
    });
    for (let y = screen.length; y < rows; y += 1) output += `\x1b[${y + 1};1H${ANSI.clearLine}`;
    if (!this.state.hidden) {
      const gripColor = this.drag ? THEME.accent : THEME.border;
      for (let y = HEADER_ROWS; y < rows - FOOTER_ROWS; y += 1) output += `\x1b[${y + 1};1H${fg(gripColor)}\u2595${ANSI.reset}`;
    }
    process.stdout.write(output);
  }
}

if (require.main === module) {
  new Sidebar().start();
}

module.exports = { Sidebar, CLOSE_MENU };
