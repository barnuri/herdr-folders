#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const herdrApi = require('../lib/herdr');
const { collect } = require('../lib/snapshot');
const { planClose, displayTitle, buildTree, dirKeys } = require('../lib/model');
const { loadState, updateState, statePath, stateDir } = require('../lib/state');
const { folderType, PLAIN_FOLDER, OPEN_FOLDER_ICON, AGENT_ICON, TERMINAL_ICON, BRANCH_ICON } = require('../lib/icons');
const { promptSegments } = require('../lib/prompt');
const { ANSI, THEME, STATUS_STYLE, fg, bg, statusGlyph, truncate, truncateLeft, width, Line, parseInput, keyName } = require('../lib/tui');
const { logError } = require('../lib/log');
const projectsApi = require('../lib/projects');
const { fitWidth } = require('../lib/fit');

const REFRESH_MS = 2500;
const HIDDEN_CHECK_MS = 5000;
const GIT_REFRESH_MS = 10000;
const DISCOVER_MS = 10 * 60 * 1000;
const SPIN_MS = 120;
const HIDDEN_COLS = 4;
const MIN_COLS = 24;
const MAX_COLS = 120;
const RESIZE_STEP_COLS = 6;
const HEADER_ROWS = 2;
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
    this.refreshTimer = setInterval(() => {
      if (this.visible === false && Date.now() - (this.lastCheck || 0) < HIDDEN_CHECK_MS) return;
      this.lastCheck = Date.now();
      this.refresh();
    }, REFRESH_MS);
    this.spinTimer = setInterval(() => {
      this.frame += 1;
      // Spinner frames are output to a pty; only the panel the user can see draws them.
      if (this.visible !== false && this.folders.some((folder) => folder.panes.some((pane) => pane.status === 'working'))) this.render();
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

  // The placeholder slots in other tabs show this frame, so a tab looks right before the panel
  // arrives. Written at most once a second, and only while the panel is visible.
  saveFrame(output) {
    if (this.visible === false || Date.now() - (this.frameSavedAt || 0) < 1000) return;
    this.frameSavedAt = Date.now();
    fs.promises.writeFile(path.join(stateDir(), 'frame.ansi'), output).catch(() => {});
  }

  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const panes = await herdrApi.listPanes();
      let mine = panes.find((pane) => pane.pane_id === this.paneId);
      if (!mine && this.paneId) {
        // `pane move` gives the panel a new id; herdr still resolves our original one for us.
        const current = await herdrApi.herdr(['pane', 'current', '--current']).catch(() => null);
        mine = current?.pane && panes.find((pane) => pane.pane_id === current.pane.pane_id);
        if (mine) {
          this.paneId = mine.pane_id;
          this.applyWidth(this.state.hidden ? HIDDEN_COLS : this.state.width);
        }
      }
      if (mine) {
        // Alone in its tab: the user closed every other pane, so the panel goes too.
        if (!panes.some((pane) => pane.tab_id === mine.tab_id && pane.pane_id !== this.paneId)) process.exit(0);
        // Every tab may hold a panel. A panel in a hidden tab does no work beyond this one
        // `pane list` every few seconds, so it notices when its tab is shown again.
        this.visible = panes.some((pane) => pane.focused && pane.tab_id === mine.tab_id);
        if (!this.visible) {
          this.hiddenSince = this.hiddenSince || Date.now();
          return;
        }
        this.hiddenSince = null;
      }
      // git status is the slow part: refresh it every 10 s and reuse it in between.
      const withGit = Date.now() - (this.lastGit || 0) >= GIT_REFRESH_MS;
      const { folders } = await collect({ withGit, excludePaneIds: this.paneId ? [this.paneId] : [] });
      if (withGit) this.lastGit = Date.now();
      else {
        const previous = new Map(this.folders.map((folder) => [folder.path, folder.git]));
        for (const folder of folders) folder.git = previous.get(folder.path);
      }
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
    if (this.state.focusSeq && this.state.focusSeq !== this.lastFocusSeq) {
      this.lastFocusSeq = this.state.focusSeq;
      this.lastCheck = Date.now();
      this.refresh();
    }
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
      this.side = await fitWidth(this.paneId, target, () => this.cols);
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

  // Menus share one look: a title row with a close button, then sections of icon rows.
  openList(title, sections) {
    this.menu = { list: true, title, sections };
    this.selected = 0;
    this.scroll = 0;
    this.render();
  }

  openPaneMenu(pane, folder) {
    const close = (fn) => () => {
      this.menu = null;
      const result = fn();
      this.render();
      return result;
    };
    const kind = pane.kind === 'agent' ? pane.agent : pane.busy ? pane.command : pane.shell || 'shell';
    this.openList(kind, [
      ['Pane', [
        ['\uf0a9', 'Focus', 'enter', close(() => this.focus(pane))],
        ...(pane.kind === 'agent' ? [['\uf05a', this.agentExpanded(pane.paneId) ? 'Hide details' : 'Show details', 'space', close(() => this.toggleAgent(pane.paneId))]] : []),
        ['\uf00d', pane.kind === 'agent' ? 'Close agent…' : 'Close shell…', '', () => this.askCloseTargets(`Close ${kind}`, [pane])],
      ]],
      ['Folder', [
        ['\uf067', `New tab in ${folder.name}`, 'n', close(() => this.newTab(folder))],
        ...(folder.isRepo ? [['\ue702', 'Git changes', 'g', close(() => this.openGit(folder))]] : []),
      ]],
    ]);
  }

  openFolderMenu(folder) {
    const close = (fn) => () => {
      this.menu = null;
      const result = fn();
      this.render();
      return result;
    };
    this.openList(folder.name, [
      ['Folder', [
        ['\uf067', 'New tab here', 'n', close(() => this.newTab(folder))],
        ...(folder.isRepo ? [['\ue702', 'Git changes', 'g', close(() => this.openGit(folder))]] : []),
        ...(this.collapsible() ? [['\uf107', this.isCollapsed(folder.path) ? 'Expand' : 'Collapse', 'space', close(() => this.toggleFolder(folder.path))]] : []),
      ]],
      ['Close', [
        ['\uf1f8', `Close all ${folder.panes.length} pane(s)…`, '', () => this.askCloseTargets(`Close everything in ${folder.name}`, folder.panes)],
      ]],
    ]);
  }

  actionLines() {
    const lines = [];
    this.selectable = [];
    const cols = this.cols;
    const isList = typeof this.menu === 'object' && this.menu?.list;
    const header = new Line();
    header.background = THEME.surface;
    header.add(isList ? ` ${truncate(this.menu.title, cols - 8)}` : ' \uf013 Settings & actions', s(THEME.text, ANSI.bold));
    header.pad(cols - 5);
    header.add(' \uf00d ', s(THEME.muted), {
      run: () => {
        this.menu = null;
        this.render();
      },
    });
    lines.push(header);
    for (const [title, actions] of isList ? this.menu.sections : this.actionList()) {
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
    this.menu = { confirm: CLOSE_MENU.find((entry) => entry.mode === mode).label, targets };
    this.render();
  }

  askCloseTargets(label, targets) {
    this.menu = { confirm: label, targets };
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
    if (this.menu && typeof this.menu === 'object' && this.menu.confirm) {
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

  // Top row: the tabs (Folders, Projects) on the left and the two tools on the right. With no
  // Projects tab, the Folders tab alone names the panel, so there is no separate title.
  headerLines() {
    const cols = this.cols;
    const top = new Line();
    top.background = THEME.surface;
    top.add(' ');
    const tab = (label, view) => {
      const active = this.view === view;
      top.add(` ${label} `, active ? `${bg(THEME.hover)}${fg(THEME.accent)}${ANSI.bold}` : s(THEME.muted), { run: () => this.setView(view) });
    };
    tab(`\uf07b Folders ${this.folders.length}`, 'folders');
    if (this.projectsEnabled()) {
      top.add(' ');
      tab(`\uf503 Projects ${this.projects.length || (this.discovering ? '…' : 0)}`, 'projects');
    }
    const tools = [
      ...(this.collapsible()
        ? [
            ['\uf102', () => this.setAllCollapsed(true), THEME.muted],
            ['\uf103', () => this.setAllCollapsed(false), THEME.muted],
          ]
        : []),
      // Everything else lives in the settings list (gear), with the same icons.
      ['\uf101', () => this.toggleHidden(), THEME.muted],
      ['\uf013', () => this.openActions(), this.menu === 'actions' ? THEME.accent : THEME.muted],
    ];
    top.pad(Math.max(top.cols + 1, cols - tools.length * 2 - 1));
    for (const [glyph, run, color] of tools) this.button(top, glyph, run, color);

    const rule = new Line();
    rule.add('\u2500'.repeat(cols), s(THEME.border));
    return [top, rule];
  }

  bodyLines() {
    this.cardIndex = 0;
    if (this.menu === 'actions' || this.menu?.list) return this.actionLines();
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

  // One folder = one card: a coloured stripe down its left edge, the head row (icon, name,
  // status, +), its git line, then a two-row item per agent and shell.
  folderBody(folder, depth, lines, addSelectable) {
    const cols = this.cols;
    const pad = '  '.repeat(depth);
    const collapsed = this.isCollapsed(folder.path);
    const type = folderType(folder.path, folder.isRepo);
    const holdsFocus = folder.panes.some((pane) => pane.paneId === this.focusedPaneId);
    const stripe = holdsFocus ? THEME.accent : type.color;
    // With collapsing off, a folder click focuses its first pane instead.
    const toggle = () => (this.collapsible() ? this.toggleFolder(folder.path) : folder.panes[0] && this.focus(folder.panes[0]));
    const context = () => this.openFolderMenu(folder);
    const begin = () => {
      const line = new Line();
      line.add(pad);
      line.add('\u258e', s(stripe));
      return line;
    };
    const attachTo = (owner) => (line) => {
      line.selectIndex = owner.selectIndex;
      line.rowAction = owner.rowAction;
      lines.push(line);
    };

    const head = begin();
    head.add(' ');
    if (this.collapsible()) head.add(collapsed ? '\uf105 ' : '\uf107 ', s(THEME.faint));
    head.add(PLAIN_FOLDER.icon, s(PLAIN_FOLDER.color));
    head.add(' ');
    const right = [];
    if (folder.status) right.push([`${statusGlyph(folder.status, this.frame)} ${folder.agentCount}`, STATUS_STYLE[folder.status].color]);
    else if (folder.terminalCount) right.push([`${TERMINAL_ICON} ${folder.terminalCount}`, THEME.faint]);
    const rightText = right.map(([text]) => text).join(' ');
    const plusWidth = 4;
    const rightEdge = cols - width(rightText) - plusWidth - 3;
    head.add(truncate(folder.name, rightEdge - head.cols), s(holdsFocus ? THEME.accent : THEME.text, ANSI.bold));
    // The git status follows the name on the same row, as far as there is room.
    if (folder.isRepo && folder.git) {
      for (const segment of promptSegments(folder.git)) {
        const room = rightEdge - head.cols - 1;
        if (room < 2) break;
        head.add(' ');
        head.add(truncate(segment.text, room), s(segment.key === 'branch' ? THEME.faint : segment.color));
      }
    }
    head.pad(cols - width(rightText) - plusWidth - 2);
    for (const [text, color] of right) head.add(text, s(color));
    head.add(' ');
    head.add(' + ', `${bg(THEME.hover)}${fg(THEME.green)}${ANSI.bold}`, { run: () => this.newTab(folder) });
    addSelectable(head, { run: toggle, toggle, folder, context });
    const sub = attachTo(head);

    if (!folder.isRepo && this.state.grouping !== 'tree') {
      const pathLine = begin();
      pathLine.add('   ');
      pathLine.add(truncateLeft(folder.path.replace(os.homedir(), '~'), cols - pathLine.cols - 2), s(THEME.faint));
      sub(pathLine);
    }

    if (collapsed) return;
    const tall = this.state.spacing !== 'compact';
    for (const pane of folder.panes) {
      const marked = pane.paneId === this.focusedPaneId;
      const focusRun = () => this.focus(pane);
      const row = begin();
      if (marked) row.background = THEME.selected;
      row.add('  ');
      let name;
      let state;
      let stateColor;
      let subtitle;
      let toggle;
      if (pane.kind === 'agent') {
        const style = STATUS_STYLE[pane.status] || STATUS_STYLE.unknown;
        toggle = () => this.toggleAgent(pane.paneId);
        row.add(statusGlyph(pane.status, this.frame), s(style.color));
        row.add(' ');
        row.add(AGENT_ICON, s(marked ? THEME.accent : THEME.blue));
        name = pane.name ? `${pane.name} · ${pane.agent}` : pane.agent;
        state = style.label;
        stateColor = style.color;
        subtitle = displayTitle(pane) || (pane.tabLabel ? `tab ${pane.tabLabel}` : pane.paneId);
      } else if (pane.kind === 'plugin') {
        // A plugin's own pane (a mod view, a log): shown with the work in its tab.
        row.add(STATUS_STYLE.plugin.glyph, s(STATUS_STYLE.plugin.color));
        row.add(' ');
        row.add('\uf12e', s(THEME.magenta));
        name = pane.name;
        state = 'plugin';
        stateColor = THEME.faint;
        subtitle = pane.tabLabel ? `tab ${pane.tabLabel}` : pane.paneId;
      } else {
        const style = STATUS_STYLE[pane.status];
        row.add(style.glyph, s(style.color));
        row.add(' ');
        row.add(TERMINAL_ICON, s(pane.busy ? THEME.cyan : THEME.green));
        name = pane.busy ? pane.command : pane.shell || 'shell';
        state = pane.busy ? 'running' : 'ready';
        stateColor = pane.busy ? THEME.cyan : THEME.faint;
        const subdir = pane.cwd !== folder.path ? pane.cwd.replace(`${folder.path}/`, '') : '';
        subtitle = [subdir && `./${subdir}`, pane.tabLabel && `tab ${pane.tabLabel}`, pane.busy && pane.shell && `in ${pane.shell}`].filter(Boolean).join(' · ') || pane.paneId;
      }
      row.add(' ');
      // Narrow panels (phones) drop the state word and keep the colour-coded glyph.
      const showState = cols >= 34;
      const stateWidth = showState ? width(state) + 2 : 1;
      row.add(truncate(name, cols - row.cols - stateWidth), s(marked ? THEME.text : pane.busy || pane.kind === 'agent' ? THEME.text : THEME.muted, marked ? ANSI.bold : ''));
      if (showState) {
        row.pad(cols - width(state) - 2);
        row.add(state, s(stateColor));
      }
      addSelectable(row, { run: focusRun, toggle, folder, pane, context: () => this.openPaneMenu(pane, folder) });
      const more = attachTo(row);
      const detail = (text, color) => {
        const line = begin();
        if (marked) line.background = THEME.selected;
        line.add('      ');
        line.add(truncate(text, cols - line.cols - 2), s(color));
        more(line);
      };
      if (tall) detail(subtitle, marked ? THEME.muted : THEME.faint);
      if (pane.kind === 'agent' && this.agentExpanded(pane.paneId)) {
        if (!tall && displayTitle(pane)) detail(displayTitle(pane), THEME.muted);
        detail(`${pane.tabLabel || pane.tabId} · ${pane.paneId}`, THEME.faint);
        if (pane.cwd !== folder.path) detail(pane.cwd.replace(folder.path, '.'), THEME.faint);
      }
    }
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
      const line = new Line();
      const run = () => this.openProject(project, 'workspace');
      const context = () => this.openProject(project, 'tab');
      line.add('  ');
      line.add(PLAIN_FOLDER.icon, s(PLAIN_FOLDER.color), { run, context });
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
      const { confirm: label, targets } = this.menu;
      add((line) => line.add(` ${label}?`, s(THEME.text, ANSI.bold)));
      add((line) => line.add(` ${targets.length} pane(s) will close:`, s(THEME.muted)));
      for (const pane of targets.slice(0, Math.max(1, this.rows - 10))) {
        add((line) => {
          const style = STATUS_STYLE[pane.status] || STATUS_STYLE.unknown;
          line.add('   ');
          line.add(statusGlyph(pane.status, this.frame), s(style.color));
          line.add(' ');
          const name = pane.kind === 'agent' ? pane.agent : pane.command || pane.shell || 'shell';
          line.add(truncate(`${name}  ${pane.cwd.replace(os.homedir(), '~')}`, cols - 6), s(THEME.muted));
        });
      }
      if (targets.length > this.rows - 10) add((line) => line.add(`   … ${targets.length - (this.rows - 10)} more`, s(THEME.faint)));
      add(() => {});
      add((line) => {
        line.add('  ');
        line.add(' Close (y) ', `${bg(THEME.red)}${fg(THEME.base)}${ANSI.bold}`, { run: () => this.confirmClose() });
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
      line.add(folder.status ? statusGlyph(folder.status, this.frame) : PLAIN_FOLDER.icon, s(color), { run: () => this.toggleHidden() });
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
        if ((!this.menu || this.menu === 'actions' || this.menu.list) && selectedItem && line.selectIndex === this.selected) line.background = line.background === THEME.selected ? THEME.selectedHover : THEME.hover;
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
    this.saveFrame(output);
  }
}

if (require.main === module) {
  new Sidebar().start();
}

module.exports = { Sidebar, CLOSE_MENU };
