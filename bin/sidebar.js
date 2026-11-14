#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');

const herdrApi = require('../lib/herdr');
const { collect } = require('../lib/snapshot');
const { planClose, displayTitle, buildTree, dirKeys } = require('../lib/model');
const { loadState, updateState, statePath } = require('../lib/state');
const { folderType, OPEN_FOLDER_ICON, AGENT_ICON, TERMINAL_ICON, BRANCH_ICON } = require('../lib/icons');
const { promptSegments } = require('../lib/prompt');
const { ANSI, THEME, STATUS_STYLE, fg, bg, statusGlyph, truncate, truncateLeft, width, Line, parseInput, keyName } = require('../lib/tui');
const { logError } = require('../lib/log');
const projectsApi = require('../lib/projects');

const REFRESH_MS = 2500;
const IDLE_REFRESH_MS = 15000;
const DISCOVER_MS = 10 * 60 * 1000;
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
    this.side = 'right';
    this.pm = projectsApi.locateProjectManager();
    this.projects = projectsApi.loadCachedProjects();
    this.query = '';
    this.discovering = false;
  }

  // ----- projects (from herdr-project-manager) -------------------------------

  projectsEnabled() {
    return Boolean(this.pm) && this.state.projectsTab !== false;
  }

  get view() {
    return this.state.view === 'projects' && this.projectsEnabled() ? 'projects' : 'folders';
  }

  setView(view) {
    this.save((state) => {
      state.view = view;
    });
    this.selected = 0;
    this.scroll = 0;
    this.menu = null;
    if (view === 'projects' && !this.projects.length) this.discover();
    this.render();
  }

  async discover() {
    if (!this.projectsEnabled() || this.discovering) return;
    this.discovering = true;
    this.render();
    try {
      this.projects = await projectsApi.discoverProjects(this.pm);
    } catch (error) {
      this.fail(error);
    } finally {
      this.discovering = false;
      this.render();
    }
  }

  async openProject(project, mode) {
    // An open folder is focused instead of opening a second workspace for it.
    const folder = this.folders.find((candidate) => candidate.path === project.path);
    if (folder && mode !== 'tab' && folder.panes.length) {
      await this.focus(folder.panes[0]);
      return;
    }
    await projectsApi.openProject(project, mode);
    this.flash(`opened ${project.name} as a ${mode === 'tab' ? 'tab' : 'workspace'}`, THEME.green);
    this.refresh();
  }

  onProjectKey(key, raw) {
    if (key === 'backspace') this.query = this.query.slice(0, -1);
    else if (key === 'escape') {
      if (this.query) this.query = '';
      else return this.setView('folders');
    } else if (raw === '\x14') {
      const item = this.selectable[this.selected];
      if (item?.project) this.guard(() => this.openProject(item.project, 'tab'));
      return undefined;
    } else if (raw === '\x12') {
      this.discover();
      return undefined;
    } else if (raw.length === 1 && raw >= ' ' && raw !== '\x7f') this.query += raw;
    else return false;
    this.selected = 0;
    this.scroll = 0;
    this.render();
    return undefined;
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
    if (this.projectsEnabled()) {
      this.discover();
      setInterval(() => this.discover(), DISCOVER_MS);
    }
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

  updateSide(layout) {
    const me = layout?.panes?.find((pane) => pane.pane_id === this.paneId);
    if (!me) return;
    // A panel whose right edge is short of the tab's edge has its movable border on the right.
    this.side = me.rect.x + me.rect.width < layout.area.x + layout.area.width ? 'left' : 'right';
  }

  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const panes = await herdrApi.listPanes();
      const mine = panes.find((pane) => pane.pane_id === this.paneId);
      if (mine) {
        // Alone in its tab: the user closed every other pane, so the panel goes too.
        if (!panes.some((pane) => pane.tab_id === mine.tab_id && pane.pane_id !== this.paneId)) process.exit(0);
        // Every tab may hold a panel; only the visible one polls at full speed.
        const visible = panes.some((pane) => pane.focused && pane.tab_id === mine.tab_id);
        if (!visible && this.folders.length && Date.now() - (this.lastRefresh || 0) < IDLE_REFRESH_MS) return;
      }
      const { folders } = await collect({ excludePaneIds: this.paneId ? [this.paneId] : [] });
      this.folders = folders;
      // Remember the user's pane: while the panel itself has focus, no listed pane is focused.
      const focused = folders.flatMap((folder) => folder.panes).find((pane) => pane.focused);
      if (focused) this.focusedPaneId = focused.paneId;
      this.loading = false;
      this.lastRefresh = Date.now();
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
      // `pane resize --amount` is a fraction of the split, so convert columns with the tab width.
      const layout = (await herdrApi.herdr(['pane', 'layout', '--pane', this.paneId]).catch(() => null))?.layout;
      const total = layout?.area?.width || this.cols * 3;
      this.updateSide(layout);
      // Growing moves the border away from the panel: left for a right-edge panel, right for a left-edge one.
      const grow = this.side === 'left' ? 'right' : 'left';
      const shrink = this.side === 'left' ? 'left' : 'right';
      for (let step = 0; step < 8; step += 1) {
        const diff = target - this.cols;
        if (Math.abs(diff) < 1) break;
        const before = this.cols;
        const amount = Math.min(0.9, Math.max(0.005, Math.abs(diff) / total));
        await herdrApi.resizePane(this.paneId, diff > 0 ? grow : shrink, amount.toFixed(4)).catch(() => {});
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
      if (!collapsed) return;
      for (const folder of this.folders) state.collapsed[folder.path] = true;
      if (state.grouping === 'tree') for (const key of dirKeys(buildTree(this.folders))) state.collapsed[key] = true;
    });
    this.render();
  }

  collapsible() {
    return this.state.collapsible !== false;
  }

  isCollapsed(key) {
    return this.collapsible() && Boolean(this.state.collapsed[key]);
  }

  toggleCollapsible() {
    this.save((state) => {
      state.collapsible = state.collapsible === false;
    });
    this.render();
  }

  toggleSpacing() {
    this.save((state) => {
      state.spacing = state.spacing === 'compact' ? 'comfortable' : 'compact';
    });
    this.render();
  }

  toggleGrouping() {
    this.save((state) => {
      state.grouping = state.grouping === 'tree' ? 'folder' : 'tree';
    });
    this.flash(this.state.grouping === 'tree' ? 'tree: folders nested by path' : 'flat: one group per folder', THEME.accent);
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
    this.focusedPaneId = pane.paneId;
    this.flash(`focused ${pane.kind === 'agent' ? pane.agent : 'terminal'} ${pane.paneId}`);
  }

  // New shell tab in the folder's workspace (or a new workspace when it has none), focused.
  async newTab(folder) {
    const workspaceId = folder.panes.find((pane) => pane.paneId === this.focusedPaneId)?.workspaceId || folder.panes[0]?.workspaceId;
    const args = workspaceId
      ? ['tab', 'create', '--workspace', workspaceId, '--cwd', folder.path, '--label', folder.name, '--focus']
      : ['workspace', 'create', '--cwd', folder.path, '--label', folder.name, '--focus'];
    await herdrApi.herdr(args);
    this.flash(`new tab in ${folder.name}`, THEME.green);
    this.refresh();
  }

  async openGit(folder) {
    if (!folder.isRepo) {
      this.flash(`${folder.name} is not a git repo`, THEME.yellow);
      return;
    }
    await herdrApi.openPluginPane('git', { placement: 'popup', width: '90%', height: '85%', env: { HERDR_FOLDERS_REPO: folder.path } });
  }

  openActions() {
    const item = this.selectable[this.selected];
    this.menuFolder = item?.folder || this.folders.find((folder) => folder.panes.some((pane) => pane.paneId === this.focusedPaneId)) || null;
    this.menu = this.menu === 'actions' ? null : 'actions';
    this.selected = 0;
    this.scroll = 0;
    this.render();
  }

  // Every panel action in one list: the same things the toolbar, keys and CLI do.
  actionList() {
    const close = () => {
      this.menu = null;
    };
    const then = (fn) => () => {
      close();
      const result = fn();
      this.render();
      return result;
    };
    const tree = this.state.grouping === 'tree';
    const folder = this.menuFolder;
    const sections = [
      ['View', [
        ...(this.collapsible()
          ? [
              ['\uf103', 'Expand all folders', 'e', then(() => this.setAllCollapsed(false))],
              ['\uf102', 'Collapse all folders', 'c', then(() => this.setAllCollapsed(true))],
            ]
          : []),
        ['\uf0dc', this.collapsible() ? 'Always expanded (no collapsing)' : 'Allow collapsing folders', '', then(() => this.toggleCollapsible())],
        [AGENT_ICON, this.state.allAgentsExpanded ? 'Collapse agent details' : 'Expand agent details', 'a', then(() => this.toggleAllAgents())],
        ['\uf0e8', tree ? 'Group flat, one per folder' : 'Group as a tree by path', 'v', then(() => this.toggleGrouping())],
        ...(this.pm ? [['\uf503', this.view === 'projects' ? 'Show Folders tab' : 'Show Projects tab', 'tab', then(() => this.setView(this.view === 'projects' ? 'folders' : 'projects'))]] : []),
        ['\uf07e', this.state.spacing === 'compact' ? 'Rows: two-line (roomy)' : 'Rows: one-line (compact)', 's', then(() => this.toggleSpacing())],
        ['\uf021', 'Refresh now', 'r', then(() => this.refresh())],
      ]],
      ['Panel', [
        ['\uf067', 'Widen panel', ']', then(() => this.resizeBy(RESIZE_STEP_COLS))],
        ['\uf068', 'Narrow panel', '[', then(() => this.resizeBy(-RESIZE_STEP_COLS))],
        ['\uf101', 'Hide panel to a strip', 'h', then(() => this.toggleHidden())],
        this.state.replace
          ? ['\uf0e2', "Restore herdr's sidebar", 'R', then(() => this.restoreHerdrSidebar())]
          : ['\uf0c9', "Replace herdr's sidebar", '', then(() => require('../lib/panel').replaceOn())],
      ]],
      ['Folder', [
        ['\uf067', folder ? `New tab in ${folder.name}` : 'New tab (select a folder)', 'n', then(() => (folder ? this.newTab(folder) : this.flash('select a folder first', THEME.yellow)))],
      ['\ue702', folder ? `Git changes: ${folder.name}` : 'Git changes (select a folder)', 'g', then(() => (folder ? this.openGit(folder) : this.flash('select a folder first', THEME.yellow)))],
      ]],
      ['Close', CLOSE_MENU.map((entry, i) => ['\uf1f8', `${entry.label} (${planClose(this.folders, entry.mode).length})`, `x ${i + 1}`, () => this.askClose(entry.mode)])],
    ];
    if (this.pm) sections[0][1].push(['\uf002', 'Rescan projects', '^R', then(() => this.discover())]);
    return sections;
  }

  actionLines() {
    const lines = [];
    this.selectable = [];
    const cols = this.cols;
    const header = new Line();
    header.add(' \uf013 Actions', s(THEME.text, ANSI.bold));
    header.pad(cols - 4);
    header.add(' \uf00d ', s(THEME.muted), { run: () => this.openActions() });
    lines.push(header);
    for (const [title, actions] of this.actionList()) {
      const section = new Line();
      section.add(` ${title.toUpperCase()}`, s(THEME.faint, ANSI.bold));
      lines.push(section);
      for (const [icon, label, key, run] of actions) {
        const line = new Line();
        const color = title === 'Close' && label.startsWith('Close everything') ? THEME.red : THEME.text;
        line.add('   ');
        line.add(icon, s(THEME.accent), { run });
        line.add(' ');
        line.add(truncate(label, cols - line.cols - width(key) - 3), s(color), { run });
        if (key) {
          line.pad(cols - width(key) - 2);
          line.add(key, s(THEME.faint), { run });
        }
        line.selectIndex = this.selectable.length;
        line.rowAction = { run, select: this.selectable.length };
        this.selectable.push({ run, line: lines.length });
        lines.push(line);
      }
    }
    return lines;
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
      else this.onKey(keyName(event.key), event.key);
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
        const delta = this.side === 'left' ? event.x - this.drag.x : this.drag.x - event.x;
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
    if (event.motion && event.button === 3) {
      // Hover: no button held. Highlight the row under the pointer so targets are easy to see.
      if (this.hoverY !== event.y) {
        this.hoverY = event.y;
        this.render();
      }
      return;
    }
    if (!event.press || event.motion) return;
    if (event.x === this.gripColumn() && event.button === 0 && !this.state.hidden) {
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

  onKey(key, raw = key) {
    if (key === 'tab' && this.projectsEnabled() && !this.menu) {
      this.setView(this.view === 'projects' ? 'folders' : 'projects');
      return;
    }
    if (this.view === 'projects' && !this.menu && this.onProjectKey(key, raw) !== false) return;
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
      case 'v':
        this.toggleGrouping();
        break;
      case 's':
        this.toggleSpacing();
        break;
      case 'n':
        if (item?.folder) this.guard(() => this.newTab(item.folder));
        break;
      case '?':
      case 'm':
        this.openActions();
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
      case 'R':
        if (this.state.replace) this.guard(() => this.restoreHerdrSidebar());
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

  gripColumn() {
    return this.side === 'left' ? this.cols - 1 : 0;
  }

  async restoreHerdrSidebar() {
    const { replaceOff } = require('../lib/panel');
    const result = await replaceOff();
    await herdrApi.herdr(['notification', 'show', 'Folders', '--body', result.hint]).catch(() => {});
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
      ...(this.collapsible()
        ? [
            ['\uf102', () => this.setAllCollapsed(true), THEME.muted],
            ['\uf103', () => this.setAllCollapsed(false), THEME.muted],
          ]
        : []),
      [AGENT_ICON, () => this.toggleAllAgents(), this.state.allAgentsExpanded ? THEME.accent : THEME.muted],
      ['\uf0e8', () => this.toggleGrouping(), this.state.grouping === 'tree' ? THEME.accent : THEME.muted],
      ['\uf068', () => this.resizeBy(-RESIZE_STEP_COLS), THEME.muted],
      ['\uf067', () => this.resizeBy(RESIZE_STEP_COLS), THEME.muted],
      ['\uf101', () => this.toggleHidden(), THEME.muted],
      ['\uf1f8', () => this.openCloseMenu(), this.menu === 'close' ? THEME.red : THEME.muted],
      ['\uf013', () => this.openActions(), this.menu === 'actions' ? THEME.accent : THEME.muted],
    ];
    if (this.state.replace) tools.push(['\uf0e2', () => this.restoreHerdrSidebar(), THEME.yellow]);
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
    if (this.projectsEnabled()) {
      const tab = (label, view) => {
        const active = this.view === view;
        rule.add(` ${label} `, active ? `${bg(THEME.hover)}${fg(THEME.accent)}${ANSI.bold}` : s(THEME.muted), { run: () => this.setView(view) });
      };
      rule.add('\u2500', s(THEME.border));
      tab(`\uf07b Folders ${this.folders.length}`, 'folders');
      rule.add('\u2500', s(THEME.border));
      tab(`\uf503 Projects ${this.projects.length || (this.discovering ? '…' : 0)}`, 'projects');
    }
    rule.add('\u2500'.repeat(Math.max(0, cols - rule.cols)), s(THEME.border));
    return [title, summary, rule];
  }

  bodyLines() {
    this.cardIndex = 0;
    if (this.menu === 'actions') return this.actionLines();
    if (this.menu) return this.menuLines();
    if (this.view === 'projects') return this.projectLines();
    const lines = [];
    this.selectable = [];
    const cols = this.cols;
    const addSelectable = (line, item) => {
      item.line = lines.length;
      line.selectIndex = this.selectable.length;
      line.rowAction = { ...item, select: this.selectable.length };
      this.selectable.push(item);
      lines.push(line);
    };

    if (this.menu) return this.menuLines();

    if (this.state.grouping === 'tree') {
      const walk = (node, depth) => {
        if (node.type === 'folder') {
          this.folderLines(node.folder, depth, lines, addSelectable);
          if (this.isCollapsed(node.folder.path)) return;
        } else {
          this.dirLine(node, depth, lines, addSelectable);
          if (this.isCollapsed(`dir:${node.path}`)) return;
        }
        for (const child of node.children) walk(child, depth + 1);
      };
      for (const node of buildTree(this.folders)) walk(node, 0);
    } else {
      for (const folder of this.folders) this.folderLines(folder, 0, lines, addSelectable);
    }
    if (!this.loading && !this.folders.length) {
      const empty = new Line();
      empty.add('  no terminals open', s(THEME.faint));
      lines.push(empty);
    }
    return lines;
  }

  folderLines(folder, depth, lines, addSelectable) {
    const first = lines.length;
    this.folderBody(folder, depth, lines, addSelectable);
    // Tint the whole group, head and panes, so each folder reads as one card.
    const even = this.cardIndex++ % 2 === 0;
    lines.slice(first).forEach((line, i) => {
      line.tint = i === 0 ? (even ? THEME.cardAHead : THEME.cardBHead) : even ? THEME.cardA : THEME.cardB;
    });
  }

  folderBody(folder, depth, lines, addSelectable) {
    const cols = this.cols;
    const pad = '  '.repeat(depth);
    const collapsed = this.isCollapsed(folder.path);
    const type = folderType(folder.path, folder.isRepo);
    // With collapsing off, a folder click focuses its first pane instead.
    const toggle = () => (this.collapsible() ? this.toggleFolder(folder.path) : folder.panes[0] && this.focus(folder.panes[0]));
    const context = () => this.openGit(folder);
    const run = toggle;

    const head = new Line();
    head.add(pad);
    head.add(' ');
    head.add(this.collapsible() ? (collapsed ? '\uf105' : '\uf107') : ' ', s(THEME.faint), { run: toggle, context });
    head.add(' ');
    head.add(collapsed ? type.icon : type.icon === '\uf07b' ? OPEN_FOLDER_ICON : type.icon, s(type.color), { run, context });
    head.add(' ');
    const badge = [];
    if (folder.status) badge.push([`${statusGlyph(folder.status, this.frame)}`, STATUS_STYLE[folder.status].color]);
    if (folder.agentCount) badge.push([`${AGENT_ICON}${folder.agentCount}`, THEME.muted]);
    if (folder.terminalCount) badge.push([`${TERMINAL_ICON} ${folder.terminalCount}`, THEME.faint]);
    const badgeText = badge.map(([text]) => text).join(' ');
    const nameMax = cols - head.cols - width(badgeText) - 6;
    const holdsFocus = folder.panes.some((pane) => pane.paneId === this.focusedPaneId);
    head.add(truncate(folder.name, nameMax), s(holdsFocus ? THEME.accent : THEME.text, ANSI.bold), { run, context });
    head.pad(cols - width(badgeText) - 5);
    badge.forEach(([text, color], i) => {
      if (i) head.add(' ');
      head.add(text, s(color));
    });
    head.add(' ');
    head.add(' + ', `${bg(THEME.hover)}${fg(THEME.green)}${ANSI.bold}`, { run: () => this.newTab(folder) });
    addSelectable(head, { run, toggle, folder, context });

    if (folder.isRepo && folder.git) {
      const gitLine = new Line();
      gitLine.add(pad);
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
      gitLine.selectIndex = head.selectIndex;
      gitLine.rowAction = head.rowAction;
      lines.push(gitLine);
    } else if (!folder.isRepo && this.state.grouping !== 'tree') {
      const pathLine = new Line();
      pathLine.add(pad);
      pathLine.add('    ');
      pathLine.add(truncateLeft(folder.path.replace(os.homedir(), '~'), cols - 5), s(THEME.faint));
      pathLine.selectIndex = head.selectIndex;
      pathLine.rowAction = head.rowAction;
      lines.push(pathLine);
    }

    if (collapsed) return;
    const tall = this.state.spacing !== 'compact';
    folder.panes.forEach((pane, index) => {
      const last = index === folder.panes.length - 1;
      const branch = last ? '\u2570' : '\u251c';
      const marked = pane.paneId === this.focusedPaneId;
      const focusRun = () => this.focus(pane);
      const labelStyle = (color) => s(marked ? THEME.text : color, marked ? ANSI.bold : '');
      // Each pane is a card: the main row plus, in comfortable spacing, a second row with its
      // title. Both rows are one click target and highlight together.
      const start = (line, first) => {
        line.add(pad);
        if (marked) {
          line.background = THEME.selected;
          line.add('\u258c', s(THEME.accent));
        } else {
          line.add(' ');
        }
        line.add(first ? ` ${branch}\u2500` : last ? '   ' : ' \u2502 ', s(THEME.border));
        return line;
      };
      const row = start(new Line(), true);
      let subtitle;
      let toggle;
      if (pane.kind === 'agent') {
        const style = STATUS_STYLE[pane.status] || STATUS_STYLE.unknown;
        toggle = () => this.toggleAgent(pane.paneId);
        row.add(statusGlyph(pane.status, this.frame), s(style.color));
        row.add(' ');
        row.add(AGENT_ICON, s(THEME.accent));
        row.add(' ');
        const label = pane.name ? `${pane.name} · ${pane.agent}` : pane.agent;
        const right = style.label;
        const room = cols - row.cols - width(right) - 3;
        row.add(truncate(label, room), labelStyle(THEME.text));
        const title = displayTitle(pane);
        if (!tall && title && room - width(label) > 4) row.add(` ${truncate(title, room - width(label) - 1)}`, s(THEME.faint));
        row.pad(cols - width(right) - 2);
        row.add(right, s(style.color));
        subtitle = title || (pane.tabLabel ? `tab ${pane.tabLabel}` : pane.paneId);
      } else {
        // A shell reads like an agent row: icon, its name, and a state word on the right.
        const style = STATUS_STYLE[pane.status];
        row.add(style.glyph, s(style.color));
        row.add(' ');
        row.add(TERMINAL_ICON, s(pane.busy ? THEME.cyan : THEME.green));
        row.add(' ');
        const right = pane.busy ? 'running' : 'ready';
        const name = pane.busy ? pane.command : pane.shell || 'shell';
        row.add(truncate(name, cols - row.cols - width(right) - 3), labelStyle(pane.busy ? THEME.text : THEME.muted));
        row.pad(cols - width(right) - 2);
        row.add(right, s(pane.busy ? THEME.cyan : THEME.faint));
        const subdir = pane.cwd !== folder.path ? pane.cwd.replace(`${folder.path}/`, '') : '';
        subtitle = [subdir && `./${subdir}`, pane.tabLabel && `tab ${pane.tabLabel}`, pane.busy && pane.shell && `in ${pane.shell}`].filter(Boolean).join(' · ') || pane.paneId;
      }
      const item = { run: focusRun, toggle, folder, pane, context };
      addSelectable(row, item);
      const attach = (line) => {
        line.selectIndex = row.selectIndex;
        line.rowAction = row.rowAction;
        lines.push(line);
      };
      if (tall) {
        const sub = start(new Line(), false);
        sub.add('    ');
        sub.add(truncate(subtitle, cols - sub.cols - 1), s(marked ? THEME.muted : THEME.faint));
        attach(sub);
      }
      if (pane.kind === 'agent' && this.agentExpanded(pane.paneId)) {
        const details = [[`${pane.tabLabel || pane.tabId} · ${pane.paneId}`, THEME.faint]];
        if (tall) details.unshift([displayTitle(pane) && displayTitle(pane) !== subtitle ? displayTitle(pane) : '', THEME.muted]);
        else details.unshift([displayTitle(pane), THEME.muted]);
        if (pane.cwd !== folder.path) details.push([pane.cwd.replace(folder.path, '.'), THEME.faint]);
        for (const [text, color] of details) {
          if (!text) continue;
          const detail = start(new Line(), false);
          detail.add('    ');
          detail.add(truncate(text, cols - detail.cols - 1), s(color));
          attach(detail);
        }
      }
    });
  }

  dirLine(node, depth, lines, addSelectable) {
    const key = `dir:${node.path}`;
    const collapsed = this.isCollapsed(key);
    const toggle = () => (this.collapsible() ? this.toggleFolder(key) : undefined);
    const home = os.homedir();
    const label = depth === 0 && node.path.startsWith(home) ? `~${node.path.slice(home.length)}` : node.name;
    const line = new Line();
    line.add(`${'  '.repeat(depth)} `);
    line.add(this.collapsible() ? (collapsed ? '\uf105' : '\uf107') : ' ', s(THEME.faint), { run: toggle });
    line.add(' ');
    line.add(collapsed ? '\uf07b' : OPEN_FOLDER_ICON, s(THEME.faint), { run: toggle });
    line.add(' ');
    line.add(truncateLeft(label, this.cols - line.cols - 2), s(THEME.muted), { run: toggle });
    line.isDir = true;
    addSelectable(line, { run: toggle, toggle });
  }

  projectLines() {
    const lines = [];
    this.selectable = [];
    const cols = this.cols;
    const search = new Line();
    search.add(' \uf002 ', s(THEME.faint));
    search.add(this.query ? `${this.query}\u2588` : 'type to filter', s(this.query ? THEME.text : THEME.faint));
    if (this.discovering) {
      search.pad(cols - 4);
      search.add(statusGlyph('working', this.frame), s(THEME.amber));
    }
    lines.push(search);
    const openPaths = new Map(this.folders.map((folder) => [folder.path, folder]));
    const projects = projectsApi.filterProjects(this.projects, this.query);
    for (const project of projects) {
      const folder = openPaths.get(project.path);
      const type = folderType(project.path, true);
      const line = new Line();
      const run = () => this.openProject(project, 'workspace');
      const context = () => this.openProject(project, 'tab');
      line.add('  ');
      line.add(type.icon, s(type.color), { run, context });
      line.add(' ');
      const badge = folder ? (folder.status ? statusGlyph(folder.status, this.frame) : '\u25cf') : '';
      line.add(truncate(project.name, cols - line.cols - 4), s(folder ? THEME.text : THEME.muted, folder ? ANSI.bold : ''), { run, context });
      if (badge) {
        line.pad(cols - 3);
        line.add(badge, s(folder.status ? STATUS_STYLE[folder.status].color : THEME.green), { run, context });
      }
      line.selectIndex = this.selectable.length;
      line.rowAction = { run, context, select: this.selectable.length };
      this.selectable.push({ run, line: lines.length, project });
      lines.push(line);
    }
    if (!projects.length) {
      const empty = new Line();
      empty.add(this.discovering ? '  discovering projects…' : this.query ? '  no match' : '  no projects (check project-manager globs)', s(THEME.faint));
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
    } else if (this.view === 'projects' && !this.drag) {
      line.add(truncate(' enter open · right-click/^T tab · ^R rescan · tab folders', this.cols - 1), s(THEME.faint));
    } else if (this.drag) {
      line.add(' drag to resize', s(THEME.accent));
    } else {
      line.add(truncate(' ? all actions · click focus · right-click git', this.cols - 1), s(THEME.faint));
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
        if (!this.menu && selectedItem && line.selectIndex === this.selected) line.background = line.background === THEME.selected ? THEME.selectedHover : THEME.hover;
      }
      const hovered = visible[this.hoverY - HEADER_ROWS];
      if (hovered?.selectIndex !== undefined) {
        for (const line of visible) if (line.selectIndex === hovered.selectIndex && line.background === null) line.background = THEME.hover;
      }
      while (visible.length < viewport) visible.push(new Line());
      screen = [...header, ...visible, this.footerLine()];
    }

    // The grip column sits on the movable border: left edge for a right panel, right edge for a left one.
    let output = ANSI.home;
    screen.forEach((line, y) => {
      for (const hit of line.hits) this.hits.push({ ...hit, y });
      // The whole row is a click target; segment hits come first so buttons inside it still win.
      if (line.rowAction) this.hits.push({ x0: 0, x1: cols, y, action: line.rowAction });
      output += `\x1b[${y + 1};1H${line.render(cols)}`;
    });
    for (let y = screen.length; y < rows; y += 1) output += `\x1b[${y + 1};1H${ANSI.clearLine}`;
    if (!this.state.hidden) {
      const gripColor = this.drag ? THEME.accent : THEME.border;
      const column = this.gripColumn() + 1;
      const glyph = this.side === 'left' ? '\u258f' : '\u2595';
      for (let y = HEADER_ROWS; y < rows - FOOTER_ROWS; y += 1) output += `\x1b[${y + 1};${column}H${fg(gripColor)}${glyph}${ANSI.reset}`;
    }
    process.stdout.write(output);
  }
}

if (require.main === module) {
  new Sidebar().start();
}

module.exports = { Sidebar, CLOSE_MENU };
