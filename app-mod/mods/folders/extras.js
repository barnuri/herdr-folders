// TUI parity for the folders mod: keyboard table, tree grouping, settings/actions list, Projects tab,
// state.json sharing with the TUI CLI, and the commands behind them. Installed on the Folders class
// by installExtras(Folders), so main.js only calls into it.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, run, exec, layout, setShared, notify } from "herdr";
import { spaceEnv } from "./env.js";
import { buildTree, dirKeys, planClose } from "./model.js";
import { actionForKey, nextSort, KEY_ROWS } from "./keys.js";
import { loadPrefs, savePrefs, readCache } from "./prefs.js";
import { filterProjects } from "./fuzzy.js";
import { STATE_LABEL, TOKEN } from "./view.js";

const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const CLOSE_MODES = ["empty-folders", "idle-agents-and-empty-folders", "terminals", "all"];
const RESIZE_PX = 50;
const PM_ID = "barnuri.project-manager";
const SELF_ID = "barnuri.folders";

function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children || []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

const methods = {
  initExtras() {
    this.view = "folders"; // "folders" | "projects"
    this.query = "";
    this.projects = [];
    this.projSel = 0;
    this.pm = false; // herdr-project-manager installed
    this.selKey = null; // selected row: folder:<path> | pane:<id> | dir:<path>
    this.closeMenu = false;
    this.pluginRoot = null;
    this.settings.projectsTab = true;
    exec("herdr", ["plugin", "list", "--json"], { timeout: 8000 })
      .then((result) => {
        const plugins = result.code === 0 ? (() => { const j = JSON.parse(result.stdout); return (j.result || j).plugins || []; })() : [];
        this.pm = plugins.some((p) => p.plugin_id === PM_ID);
        const self = plugins.find((p) => p.plugin_id === SELF_ID);
        this.pluginRoot = self ? self.plugin_root : null;
      })
      .catch(() => {});
  },

  // Applies state.json (the file the TUI CLI writes) over the layout settings.
  async pullPrefs(cx) {
    const prefs = await loadPrefs();
    let changed = false;
    for (const [key, value] of Object.entries(prefs)) {
      if (key === "view") { if (this.view !== value && (value !== "projects" || this.pm)) { this.view = value; changed = true; } continue; }
      if (key === "env") { const env = value === "orch" ? "orch" : "default"; if (this.env !== env) { this.env = env; changed = true; this.shareEnv(); } continue; }
      if (key === "lastDefaultSpace") { this.lastDefaultSpace = value; continue; }
      if (key === "showAppSidebar") { if (this.settings.showAppSidebar !== value) changed = true; this.settings.showAppSidebar = value; continue; }
      if (key === "allAgentsExpanded") { if (this.allAgents !== value) { this.allAgents = value; changed = true; } continue; }
      if (this.settings[key] !== value) { this.settings[key] = value; changed = true; }
    }
    this.syncSidebar();
    if (this.followSpace()) changed = true;
    if (changed && cx) cx.notify();
  },

  shareEnv() {
    setShared("folders.env", { env: this.env, orchSpace: this.orchSpace });
  },

  // Switches the env. Orch selects the orch space and remembers the current default space; default selects it back.
  setEnv(env, cx) {
    if (env === this.env) return;
    const all = spaces();
    const active = all.find((s) => s.active);
    const orchSpace = all.find((s) => spaceEnv(s, this.orchSpace) === "orch");
    if (env === "orch") {
      if (active && spaceEnv(active, this.orchSpace) === "default") { this.lastDefaultSpace = active.id; savePrefs({ lastDefaultSpace: active.id }); }
      if (orchSpace) run("space.select", { id: orchSpace.id });
    } else {
      const back = all.find((s) => s.id === this.lastDefaultSpace && spaceEnv(s, this.orchSpace) === "default") || all.find((s) => spaceEnv(s, this.orchSpace) === "default");
      if (back) run("space.select", { id: back.id });
    }
    this.env = env;
    this.envGrace = Date.now() + 3000;
    this.selKey = null;
    this.shareEnv();
    savePrefs({ env });
    if (cx) cx.notify();
  },

  // The app sidebar follows settings.showAppSidebar. The layout is the truth when someone toggled it by hand
  // (cmd-b): the setting then adopts the layout state. The first call applies the saved setting.
  syncSidebar() {
    const node = findNode(layout(), "sidebar");
    if (!node) return;
    const shown = !node.hidden;
    if (this.sidebarSeen === undefined) {
      this.sidebarSeen = shown;
      if (shown !== this.settings.showAppSidebar) { run(this.settings.showAppSidebar ? "layout.show" : "layout.hide", { id: "sidebar" }); this.sidebarSeen = this.settings.showAppSidebar; }
      return;
    }
    if (shown !== this.sidebarSeen) {
      this.sidebarSeen = shown;
      if (this.settings.showAppSidebar !== shown) { this.settings.showAppSidebar = shown; savePrefs({ showAppSidebar: shown }); }
    }
  },

  // The env follows the active space, so a space picked anywhere (sidebar, key, orch job click) shows its own env.
  // A switch made here gets 3 s to land first.
  followSpace() {
    if (Date.now() < (this.envGrace || 0)) return false;
    const active = spaces().find((s) => s.active);
    if (!active) return false;
    const env = spaceEnv(active, this.orchSpace);
    if (env === this.env) return false;
    this.env = env;
    this.shareEnv();
    savePrefs({ env });
    return true;
  },

  // Sets the setting and the layout together (command, key, gear list).
  setSidebar(show, cx) {
    this.settings.showAppSidebar = show;
    this.sidebarSeen = show;
    savePrefs({ showAppSidebar: show });
    run(show ? "layout.show" : "layout.hide", { id: "sidebar" });
    if (cx) cx.notify();
  },

  setPref(key, value, cx) {
    if (key === "view") this.view = value;
    else if (key === "allAgentsExpanded") this.allAgents = value;
    else this.settings[key] = value;
    savePrefs({ [key]: value });
    if (cx) cx.notify();
  },

  // Rows in draw order, for the keyboard selection.
  items() {
    const folders = this.folders();
    const out = [];
    const folderItems = (folder) => {
      out.push({ key: `folder:${folder.path}`, type: "folder", folder });
      if (!(this.settings.collapsible && this.collapsed.has(folder.path))) for (const pane of folder.panes) out.push({ key: `pane:${pane.paneId}`, type: "pane", folder, pane });
    };
    if (this.settings.grouping === "tree") {
      const walk = (node) => {
        if (node.type === "dir") {
          out.push({ key: `dir:${node.path}`, type: "dir", path: node.path });
          if (this.settings.collapsible && this.collapsed.has(`dir:${node.path}`)) return;
        } else folderItems(node.folder);
        node.children.forEach(walk);
      };
      buildTree(folders).forEach(walk);
    } else folders.forEach(folderItems);
    return out;
  },

  selected() {
    const items = this.items();
    return items.find((i) => i.key === this.selKey) || null;
  },

  move(delta) {
    const items = this.items();
    if (!items.length) return;
    const at = items.findIndex((i) => i.key === this.selKey);
    const next = Math.max(0, Math.min(items.length - 1, (at < 0 ? (delta > 0 ? -1 : items.length) : at) + delta));
    this.selKey = items[next].key;
  },

  setAllCollapsed(collapsed) {
    const folders = this.folders();
    this.collapsed = new Set();
    if (collapsed) {
      for (const f of folders) this.collapsed.add(f.path);
      if (this.settings.grouping === "tree") for (const k of dirKeys(buildTree(folders))) this.collapsed.add(k);
    }
    this.persist();
  },

  resize(delta) {
    const node = findNode(layout(), "folders");
    const px = node && node.size && node.size.px;
    if (px) run("layout.resize", { id: "folders", px: Math.max(300, Math.min(560, px + delta)) });
  },

  async toggleSidebarSpaces() {
    run("layout.toggle", { id: "sidebar" });
  },

  openProjectsList() {
    return readCache().then((list) => { this.projects = list; });
  },

  visibleProjects() {
    return filterProjects(this.projects, this.query);
  },

  openFolderPaths() {
    const open = new Map();
    for (const f of this.folders()) open.set(f.path, f);
    return open;
  },

  // enter: focus the space that already holds the project, else open a new space (a workspace).
  openProject(project, asTab) {
    const folder = this.openFolderPaths().get(project.path);
    const first = folder && folder.panes[0];
    if (asTab) {
      if (first && first.workspaceId) run("space.select", { id: first.workspaceId });
      run("tab.new", { folder: project.path, name: project.name });
    } else if (first) run("pane.focus", { pane: first.paneId });
    else run("space.new", { folder: project.path, name: project.name });
    notify({ title: "Folders", body: `opened ${project.name} as a ${asTab ? "tab" : "workspace"}`, level: "success", timeout: 3000 });
  },

  async rescanProjects(cx) {
    if (!this.pluginRoot) return;
    this.scanning = true;
    cx.notify();
    await exec("node", [`${this.pluginRoot}/bin/folders.js`, "projects", "--rescan"], { timeout: 600000 }).catch(() => null);
    await this.openProjectsList();
    this.scanning = false;
    cx.notify();
  },

  async act(action, cx) {
    const item = this.selected();
    const folderOf = () => (item ? item.folder : null) || this.folders().find((f) => f.panes.some((p) => p.focused)) || null;
    if (action.startsWith("filter:")) { this.query += action.slice(7); this.projSel = 0; }
    else if (action === "filter-clear") { this.query = ""; this.projSel = 0; }
    else if (action === "filter-back") { this.query = this.query.slice(0, -1); this.projSel = 0; }
    else if (action === "down" || action === "up") {
      if (this.view === "projects") this.projSel = Math.max(0, Math.min(this.visibleProjects().length - 1, this.projSel + (action === "down" ? 1 : -1)));
      else this.move(action === "down" ? 1 : -1);
    }
    else if (action === "page-down") this.move(10);
    else if (action === "page-up") this.move(-10);
    else if (action === "activate") {
      if (!item) this.move(1);
      else if (item.type === "pane") this.focusPane(item.pane);
      else if (item.type === "folder") { if (this.settings.collapsible) this.toggle(item.folder.path, cx); else if (item.folder.panes[0]) this.focusPane(item.folder.panes[0]); }
      else this.toggle(`dir:${item.path}`, cx);
    }
    else if (action === "toggle") {
      if (!item) return;
      if (item.type === "pane") { if (this.expanded.has(item.pane.paneId)) this.expanded.delete(item.pane.paneId); else this.expanded.add(item.pane.paneId); }
      else if (this.settings.collapsible) this.toggle(item.type === "dir" ? `dir:${item.path}` : item.folder.path, cx);
    }
    else if (action === "git") { const f = folderOf(); if (f) this.openChanges(f); }
    else if (action === "expand-all") this.setAllCollapsed(false);
    else if (action === "collapse-all") this.setAllCollapsed(true);
    else if (action === "agents") this.setPref("allAgentsExpanded", !this.allAgents);
    else if (action === "grouping") this.setPref("grouping", this.settings.grouping === "tree" ? "folder" : "tree");
    else if (action === "spacing") this.setPref("spacing", this.settings.spacing === "compact" ? "comfortable" : "compact");
    else if (action === "sort") this.setPref("sort", nextSort(this.settings.sort));
    else if (action === "new-tab") { const f = folderOf(); if (f) this.newTab(f); }
    else if (action === "actions") { this.menu = !this.menu; this.closeMenu = false; this.ctx = null; }
    else if (action === "close-menu") { this.menu = true; this.closeMenu = true; }
    else if (action.startsWith("close-")) this.askClose(CLOSE_MODES[Number(action.slice(6)) - 1], cx);
    else if (action === "confirm") { if (this.pending) this.confirmClose(cx); }
    else if (action === "cancel") { this.pending = null; this.menu = false; this.ctx = null; this.closeMenu = false; }
    else if (action === "narrow") this.resize(-RESIZE_PX);
    else if (action === "widen") this.resize(RESIZE_PX);
    else if (action === "restore") this.toggleSidebarSpaces();
    else if (action === "hide") run("layout.hide", { id: "folders" });
    else if (action === "refresh") this.refresh(cx, true);
    else if (action === "switch-view") { if (this.pm && this.settings.projectsTab) { const next = this.view === "projects" ? "folders" : "projects"; this.setPref("view", next, cx); if (next === "projects") await this.openProjectsList(); } }
    else if (action === "project-open") { const p = this.visibleProjects()[this.projSel]; if (p) this.openProject(p, false); }
    else if (action === "project-tab") { const p = this.visibleProjects()[this.projSel]; if (p) this.openProject(p, true); }
    else if (action === "project-rescan") await this.rescanProjects(cx);
    cx.notify();
  },

  onKey(e, cx) {
    const mods = e.modifiers || {};
    const ch = e.key_char && e.key_char.length === 1 ? e.key_char : e.key;
    const action = actionForKey(ch, Boolean(mods.control), { confirm: Boolean(this.pending), closeMenu: this.closeMenu, projects: this.view === "projects" });
    if (!action) return false;
    this.act(action, cx);
    return true;
  },

  // Mod commands for the CLI (herdr-app do folders.<name>). True when handled.
  extraCommand(command, cx) {
    const sets = /^(grouping|spacing|sort|collapsible|card-backgrounds|confirm-kill|projects-tab)-(.+)$/.exec(command);
    if (sets) {
      const [, name, value] = sets;
      const key = { "card-backgrounds": "cardBackgrounds", "confirm-kill": "confirmKill", "projects-tab": "projectsTab" }[name] || name;
      const bool = ["collapsible", "cardBackgrounds", "confirmKill", "projectsTab"].includes(key);
      this.setPref(key, bool ? value === "on" : value, cx);
      return true;
    }
    if (command.startsWith("key-")) { const k = command.slice(4); this.act(actionForKey(k === "space" ? " " : k.replace(/^ctrl-/, ""), k.startsWith("ctrl-"), { confirm: Boolean(this.pending), closeMenu: this.closeMenu, projects: this.view === "projects" }) || "none", cx); return true; }
    if (command === "pull-prefs") { this.pullPrefs(cx); return true; }
    if (command === "view-folders" || command === "view-projects") { this.act("switch-view", cx); return true; }
    if (command === "show-projects" || command === "show-folders") { this.setPref("view", command.slice(5), cx); this.openProjectsList(); return true; }
    if (command.startsWith("filter-")) { this.query = command.slice(7); this.projSel = 0; cx.notify(); return true; }
    if (command === "rescan-projects") { this.rescanProjects(cx); return true; }
    const open = /^open-project-(\d+)(-tab)?$/.exec(command);
    if (open) { const p = this.visibleProjects()[Number(open[1]) - 1]; if (p) this.openProject(p, Boolean(open[2])); return true; }
    const nt = /^new-tab-(\d+)$/.exec(command);
    if (nt) { const f = this.folders()[Number(nt[1]) - 1]; if (f) this.newTab(f); return true; }
    if (command === "sidebar-toggle" || command === "replace-toggle") { this.toggleSidebarSpaces(); return true; }
    if (command === "toggle-sidebar") { this.setSidebar(!this.settings.showAppSidebar, cx); return true; }
    if (command === "open-sidebar") { this.sidebarSeen = true; run("layout.show", { id: "sidebar" }); return true; }
    if (command === "env-default" || command === "env-orch") { this.setEnv(command.slice(4), cx); return true; }
    if (command === "snapshot") { this.writeSnapshot(); return true; }
    if (command === "agents-on" || command === "agents-off") { this.setPref("allAgentsExpanded", command === "agents-on", cx); return true; }
    if (command.startsWith("changes-path-")) { const f = this.folders().find((x) => x.path === command.slice(13)); if (f) this.openChanges(f); return true; }
    if (command.startsWith("width-")) { const px = Number(command.slice(6)); if (px) run("layout.resize", { id: "folders", px }); return true; }
    if (command === "restore-sidebar" || command === "replace-on") { run("layout.hide", { id: "sidebar" }); return true; }
    if (command === "replace-off") { run("layout.show", { id: "sidebar" }); return true; }
    if (command === "toggle-gear") { this.act("actions", cx); return true; }
    return false;
  },

  // JSON like `folders.js snapshot`, under shared state "folders.snapshot" (shared.json).
  writeSnapshot() {
    const snap = this.folders().map((f) => ({
      path: f.path, name: f.name, status: f.status, collapsed: this.collapsed.has(f.path),
      git: this.git[f.path] || null,
      panes: f.panes.map((p) => ({ paneId: p.paneId, kind: p.kind, name: p.name || p.shell || null, status: p.status || null, busy: Boolean(p.busy), command: p.command || null, focused: Boolean(p.focused) })),
    }));
    setShared("folders.snapshot", { at: Date.now(), settings: { ...this.settings, view: this.view }, folders: snap });
  },

  // Folders | Projects tab strip. Only drawn when herdr-project-manager is installed and the tab is on.
  renderTabs(t, cx) {
    if (!this.pm || !this.settings.projectsTab) return div();
    const tab = (id, label) => div().id(`tab-${id}`).px(10).h(22).flex().items_center().rounded(6)
      .when(this.view === id, (el) => el.bg(t.selected).text_color(t.accent).font_bold())
      .when(this.view !== id, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover)))
      .on_click(async () => { this.setPref("view", id, cx); if (id === "projects") await this.openProjectsList(); cx.notify(); })
      .child(label);
    return h_flex().gap(4).px(10).pb(4).child(tab("folders", "Folders")).child(tab("projects", `Projects${this.projects.length ? ` ${this.projects.length}` : ""}`));
  },

  renderProjects(t, cx) {
    const list = this.visibleProjects();
    const open = this.openFolderPaths();
    const rows = list.slice(0, 200).map((p, i) => {
      const folder = open.get(p.path);
      const status = folder ? folder.status || (folder.terminalCount ? "shell" : "idle") : null;
      return h_flex()
        .id(`project-${i}`)
        .gap(6).pl(10).pr(8).h(24).items_center()
        .when(i === this.projSel, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click(() => { this.projSel = i; this.openProject(p, false); cx.notify(); })
        .on_mouse_down("right", () => { this.openProject(p, true); })
        .child(status ? this.glyph(t, status) : div().w(12).flex_none())
        .child(div().flex_none().max_w(150).truncate().font_bold().text_color(t.foreground).child(p.name))
        .child(div().flex_1().truncate().text_size(12).text_color(t.dim).child(p.path.replace(/^\/Users\/[^/]+/, "~")));
    });
    return v_flex()
      .id("projects-list")
      .flex_1()
      .overflow_y_scroll()
      .child(div().px(10).h(24).flex().items_center().text_size(12).text_color(t.dim).child(`filter: ${this.query || "(type to filter)"}${this.scanning ? " · scanning…" : ""}`))
      .children(rows.length ? rows : [div().px(10).h(24).text_color(t.dim).child(this.projects.length ? "no match" : "no projects cached: ctrl+r rescans")]);
  },

  // Tree grouping: directories nest the folder cards.
  renderTree(t, cx) {
    const nodes = buildTree(this.folders());
    let index = 0;
    const draw = (node, depth) => {
      const pad = depth * 12;
      if (node.type === "dir") {
        const key = `dir:${node.path}`;
        const collapsed = this.settings.collapsible && this.collapsed.has(key);
        const selected = this.selKey === key;
        return v_flex().id(key)
          .child(h_flex().id(`${key}-row`).gap(6).pl(8 + pad).pr(8).h(24).items_center()
            .when(selected, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click(() => (this.settings.collapsible ? this.toggle(key, cx) : null))
            .when(this.settings.collapsible, (el) => el.child(svg(ICON(collapsed ? "chevron-right" : "chevron-down")).size(11).flex_none().text_color(t.dim)))
            .child(svg(ICON("folder")).size(13).flex_none().text_color(t.dim))
            .child(div().flex_1().truncate().text_color(t.muted).child(node.name)))
          .children(collapsed ? [] : node.children.map((child) => draw(child, depth + 1)));
      }
      const card = this.renderFolder(t, node.folder, index++, cx);
      return v_flex().id(`tree-${node.folder.path}`).pl(pad).child(card).children(node.children.map((child) => draw(child, depth + 1)));
    };
    return nodes.map((n) => draw(n, 0));
  },

  // The gear list: every action with its key, like the TUI's "Settings & actions".
  renderActions(t, cx) {
    const tree = this.settings.grouping === "tree";
    const folder = (this.selected() || {}).folder || this.folders().find((f) => f.panes.some((p) => p.focused)) || null;
    const then = (action) => () => { this.menu = false; this.closeMenu = false; this.act(action, cx); };
    const toggle = (key, id) => () => { this.menu = false; this.setPref(key, !this.settings[key], cx); };
    const sections = [
      ["View", [
        ...(this.settings.collapsible ? [["Expand all folders", "e", then("expand-all")], ["Collapse all folders", "c", then("collapse-all")]] : []),
        [this.settings.collapsible ? "Always expanded (no collapsing)" : "Allow collapsing folders", "", toggle("collapsible")],
        [this.settings.cardBackgrounds ? "Hide folder card backgrounds" : "Show folder card backgrounds", "", toggle("cardBackgrounds")],
        [this.allAgents ? "Collapse agent details" : "Expand agent details", "a", then("agents")],
        [`Sort: ${this.settings.sort} (next: ${nextSort(this.settings.sort)})`, "o", then("sort")],
        [tree ? "Group flat, one per folder" : "Group as a tree by path", "v", then("grouping")],
        ...(this.pm ? [[this.view === "projects" ? "Show Folders tab" : "Show Projects tab", "tab", then("switch-view")], ["Rescan projects", "^R", () => { this.menu = false; this.rescanProjects(cx); }]] : []),
        [this.settings.spacing === "compact" ? "Taller rows (easier to click)" : "Compact rows", "s", then("spacing")],
        [this.settings.confirmKill ? "Trash icon: kill without asking" : "Trash icon: ask before kill", "", toggle("confirmKill")],
        ["Refresh now", "r", then("refresh")],
      ]],
      ["Panel", [
        ["Widen panel", "]", then("widen")],
        ["Narrow panel", "[", then("narrow")],
        ["Hide panel", "h", then("hide")],
        [this.settings.showAppSidebar ? "Show the app sidebar: on (turn off)" : "Show the app sidebar: off (turn on)", "cmd-alt-b", () => { this.menu = false; this.setSidebar(!this.settings.showAppSidebar, cx); }],
        ["Open app sidebar", "", () => { this.menu = false; this.sidebarSeen = true; run("layout.show", { id: "sidebar" }); cx.notify(); }],
        ["Toggle the app's own sidebar", "R", then("restore")],
      ]],
      ["Folder", [
        [folder ? `New tab in ${folder.name}` : "New tab (select a folder)", "n", then("new-tab")],
        [folder ? `Git changes: ${folder.name}` : "Git changes (select a folder)", "g", then("git")],
      ]],
      ["Close", CLOSE_MODES.map((mode, i) => [`${{ "empty-folders": "Close empty folders", "idle-agents-and-empty-folders": "Close idle agents + empty folders", terminals: "Close all terminals (keep agents)", all: "Close everything" }[mode]} (${planClose(this.folders(), mode).length})`, `x ${i + 1}`, then(`close-${i + 1}`)])],
    ];
    const row = ([label, key, onClick], i) => h_flex().id(`act-${label}-${i}`).gap(8).px(8).h(24).items_center().rounded(4).hover((s) => s.bg(t.hover)).on_click(onClick)
      .child(div().flex_1().truncate().text_color(label.startsWith("Close everything") ? t.blocked : t.foreground).child(label))
      .child(div().flex_none().text_size(12).text_color(t.accent).child(key));
    return v_flex().id("actions-menu").gap(2).p(6).m(8).rounded(6).bg(t.popover)
      .child(h_flex().px(8).items_center().child(div().flex_1().font_bold().text_color(t.foreground).child("Settings & actions")).child(div().id("actions-close").px(6).text_color(t.dim).on_click(() => { this.menu = false; cx.notify(); }).child("×")))
      .children(sections.flatMap(([title, rows]) => [div().px(8).pt(4).text_size(12).text_color(t.dim).child(title), ...rows.map(row)]))
      .child(div().px(8).pt(4).text_size(12).text_color(t.dim).child("keys: " + KEY_ROWS.map((r) => r[0]).slice(0, 4).join(" · ")));
  },
};

export function installExtras(cls) {
  Object.assign(cls.prototype, methods);
}
