// The folders panel look and interaction, in the app's own style (spaces sidebar: 13 px names, 11 px dim captions,
// 26-30 px rounded rows, avatar letters, hover and selected fills from the theme, status dots, quiet chips).
// Installed over the Folders class by installUi(Folders) after installExtras, so these methods win.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, home, theme } from "herdr";
import { displayTitle } from "./model.js";
import { gitSegments, paneStatus, summarize, TOKEN, STATE_LABEL } from "./view.js";
import { orchRows } from "./orchjobs.js";
import { avatarColor, menuHeight } from "./listops.js";

const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const tilde = (p) => String(p || "").replace(home(), "~");

function paneName(pane) {
  const isAgent = pane.kind === "agent";
  const tab = pane.tabLabel ? `tab ${pane.tabLabel}` : pane.paneId;
  return isAgent ? pane.name || displayTitle(pane) || tab : pane.busy ? pane.command : pane.tabLabel || pane.shell || "shell";
}

const methods = {
  // --- hover, tooltips, small parts -------------------------------------------------------------------------

  hoverProps(key) {
    return (h, cx) => {
      const next = h ? key : this.hoverKey === key ? null : this.hoverKey;
      if (next !== this.hoverKey) { this.hoverKey = next; cx.notify(); }
    };
  },

  // Icon button on mouse down, so a press never reaches the row under it (drag, click, double-click).
  iconButton(t, id, icon, color, onClick, bg, tip) {
    return div()
      .id(id)
      .size(22)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(6)
      .when(Boolean(bg), (el) => el.bg(bg))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (event, cx) => {
        cx.stop_propagation();
        onClick(event, cx);
      })
      .child(svg(ICON(icon)).size(13).flex_none().text_color(color));
  },

  chip(t, text, color, icon) {
    return h_flex().flex_none().gap(3).px(5).h(16).items_center().rounded(4).bg(t.raised).text_size(11).text_color(color)
      .when(Boolean(icon), (el) => el.child(svg(ICON(icon)).size(10).flex_none().text_color(color)))
      .child(text);
  },

  dot(t, status) {
    const color = t[TOKEN[status]] ?? t.dim;
    if (status === "working" || status === "orch") return svg(ICON("spinner")).size(11).flex_none().text_color(color).spin(900);
    if (status === "done") return svg(ICON("check")).size(11).flex_none().text_color(color);
    return div().w(11).flex_none().flex().justify_center().child(div().size(6).rounded(3).bg(color).when(status === "shell" || status === "unknown", (el) => el.opacity(0.55)));
  },

  // --- search and rename (keys go through onKey) ------------------------------------------------------------

  startSearch(cx) {
    if (this.search === null) this.search = "";
    this.searching = true;
    this.handle.focus();
    cx.notify();
  },

  stopSearch(cx) {
    this.search = null;
    this.searching = false;
    cx.notify();
  },

  // Rename target: { key, kind: "folder" | "pane", id (space or tab), text }.
  startRename(target, cx) {
    this.rename = target;
    this.handle.focus();
    cx.notify();
  },

  commitRename(cx) {
    const r = this.rename;
    this.rename = null;
    const name = (r.text || "").trim();
    if (name && r.id) run(r.kind === "folder" ? "space.rename" : "tab.rename", { id: r.id, name });
    cx.notify();
  },

  renameFolder(folder, cx) {
    const [first] = folder.panes;
    const space = first && first.workspaceId;
    if (space) this.startRename({ key: `folder:${folder.path}`, kind: "folder", id: space, text: (spaces().find((s) => s.id === space) || {}).name || folder.name }, cx);
  },

  renamePane(pane, cx) {
    if (pane.tabId) this.startRename({ key: `pane:${pane.paneId}`, kind: "pane", id: pane.tabId, text: pane.tabLabel || paneName(pane) }, cx);
  },

  onKey(e, cx) {
    const mods = e.modifiers || {};
    const ch = e.key_char && e.key_char.length === 1 ? e.key_char : e.key;
    if (this.rename) {
      if (ch === "enter") this.commitRename(cx);
      else if (ch === "escape") { this.rename = null; cx.notify(); }
      else if (ch === "backspace") { this.rename.text = this.rename.text.slice(0, -1); cx.notify(); }
      else if (ch.length === 1 && !mods.platform && !mods.control) { this.rename.text += ch; cx.notify(); }
      return true;
    }
    if (e.keystroke === "cmd-f" || (mods.platform && ch === "f")) { this.startSearch(cx); return true; }
    if (this.searching && !this.pending) {
      if (ch === "escape") this.stopSearch(cx);
      else if (ch === "enter") { this.searching = false; cx.notify(); }
      else if (ch === "backspace") { this.search = this.search.slice(0, -1); cx.notify(); }
      else if (ch === "down" || ch === "up") { this.move(ch === "down" ? 1 : -1); cx.notify(); }
      else if (ch.length === 1 && !mods.platform && !mods.control) { this.search += ch; cx.notify(); }
      return true;
    }
    if (ch === "escape" && this.search !== null && !this.pending && !this.menu) { this.stopSearch(cx); return true; }
    if (ch === "f2") {
      const item = this.selected();
      if (item && item.type === "folder") this.renameFolder(item.folder, cx);
      else if (item && item.type === "pane") this.renamePane(item.pane, cx);
      return true;
    }
    return this.onKeyBase(e, cx);
  },

  // --- context menu (a popup overlay at the pointer, see menu.js) -------------------------------------------

  findPane(paneId) {
    for (const folder of this.foldersAllRaw()) for (const pane of folder.panes) if (pane.paneId === paneId) return { folder, pane };
    return null;
  },

  menuItems(target) {
    const { folder, pane, project } = target;
    const sep = { sep: true };
    const editor = (path) => ({ exec: ["open", "-a", "Visual Studio Code", path] });
    if (project) {
      return [
        { label: "Open", icon: "folder", hint: "enter", act: { mod: `ctx:open-project:${project.path}` } },
        { label: "Open as tab", icon: "plus", hint: "ctrl-t", act: { mod: `ctx:open-project-tab:${project.path}` } },
        sep,
        { label: "Open in editor", icon: "square-pen", act: editor(project.path) },
        { label: "Reveal in Finder", icon: "folder-plus", act: { exec: ["open", "-R", project.path] } },
        { label: "Copy path", icon: "files", act: { copy: project.path } },
      ];
    }
    if (pane) {
      const live = panes().find((p) => p.pane === pane.paneId);
      const term = live && live.terminal;
      const cwd = (live && live.cwd) || folder.path;
      return [
        { label: "Focus", icon: "terminal", hint: "enter", act: { run: ["pane.focus", { pane: pane.paneId }] } },
        { label: "Rename", icon: "square-pen", hint: "F2", act: { mod: `ctx:rename-pane:${pane.paneId}` } },
        ...(pane.kind === "agent" ? [{ label: this.expanded.has(pane.paneId) ? "Hide details" : "Show details", icon: "layers", hint: "space", act: { mod: `ctx:details:${pane.paneId}` } }] : []),
        sep,
        ...(term ? [
          { label: "Move to env: orch", icon: "server", act: { exec: ["hc", "label", term, "herdr.space=orch"] } },
          { label: "Move to env: default", icon: "monitor", act: { exec: ["hc", "label", term, "herdr.space="] } },
        ] : []),
        { label: "Copy cwd", icon: "files", act: { copy: cwd } },
        { label: "Git changes", icon: "git-compare", hint: "g", act: { mod: `ctx:git:${folder.path}` } },
        sep,
        { label: pane.kind === "agent" ? "Close agent…" : "Close shell…", icon: "x", hint: "x", danger: true, act: { mod: `ctx:ask-pane:${pane.paneId}` } },
      ];
    }
    const first = folder.panes[0];
    const git = Boolean(this.git[folder.path]);
    return [
      { label: "New tab here", icon: "plus", hint: "n", act: { mod: `ctx:new-tab:${folder.path}` } },
      { label: "New shell here", icon: "terminal", act: { run: ["terminal.open", { folder: folder.path, place: "right" }] } },
      sep,
      { label: "Open in editor", icon: "square-pen", act: editor(folder.path) },
      { label: "Reveal in Finder", icon: "folder-plus", act: { exec: ["open", folder.path] } },
      { label: "Copy path", icon: "files", act: { copy: folder.path } },
      ...(git ? [{ label: "Git changes", icon: "git-compare", hint: "g", act: { mod: `ctx:git:${folder.path}` } }] : []),
      sep,
      ...(first && first.workspaceId ? [{ label: "Rename space", icon: "square-pen", hint: "F2", act: { mod: `ctx:rename-folder:${folder.path}` } }] : []),
      { label: "Move up", icon: "chevron-left", act: { mod: `ctx:up:${folder.path}` } },
      { label: "Move down", icon: "chevron-right", act: { mod: `ctx:down:${folder.path}` } },
      ...(this.settings.collapsible ? [{ label: "Collapse all", icon: "chevron-right", hint: "c", act: { mod: "ctx:collapse-all:" } }, { label: "Expand all", icon: "chevron-down", hint: "e", act: { mod: "ctx:expand-all:" } }] : []),
      ...(folder.panes.length ? [sep, { label: `Close all ${folder.panes.length}…`, icon: "x", hint: "x", danger: true, act: { mod: `ctx:ask-folder:${folder.path}` } }] : []),
    ];
  },

  openMenu(target, cx) {
    const { folder, pane, project } = target;
    const title = project ? project.name : pane ? paneName(pane) : folder.name;
    const subtitle = tilde(project ? project.path : pane ? `${folder.name} · ${pane.kind}` : folder.path);
    const items = this.menuItems(target);
    this.menu = false;
    openOverlay({ mod: "folders", props: { menu: { title, subtitle, items } }, kind: "popup", at: "pointer", width: 252, height: menuHeight(items) + 14 });
    cx.notify();
  },

  // "ctx:<verb>:<arg>" commands sent by the menu popup.
  ctxCommand(command, cx) {
    const m = /^ctx:([a-z-]+):(.*)$/s.exec(command);
    if (!m) return false;
    const [, verb, arg] = m;
    const folder = this.foldersAllRaw().find((f) => f.path === arg);
    const found = this.findPane(arg);
    if (verb === "new-tab" && folder) this.newTab(folder);
    else if (verb === "git" && folder) this.openChanges(folder);
    else if (verb === "rename-folder" && folder) this.renameFolder(folder, cx);
    else if (verb === "rename-pane" && found) this.renamePane(found.pane, cx);
    else if (verb === "details" && found) { if (this.expanded.has(arg)) this.expanded.delete(arg); else this.expanded.add(arg); }
    else if (verb === "ask-pane" && found) this.ask(`Close ${found.pane.kind === "agent" ? "agent" : "shell"}`, [found.pane]);
    else if (verb === "ask-folder" && folder) this.ask(`Close everything in ${folder.name}`, folder.panes);
    else if (verb === "up" || verb === "down") this.reorder(arg, verb === "up" ? -1 : 1);
    else if (verb === "collapse-all") this.setAllCollapsed(true);
    else if (verb === "expand-all") this.setAllCollapsed(false);
    else if (verb === "open-project" || verb === "open-project-tab") { const p = this.projects.find((x) => x.path === arg); if (p) this.openProject(p, verb.endsWith("tab")); }
    else return false;
    cx.notify();
    return true;
  },

  extraCommand(command, cx) {
    if (command.startsWith("ctx:")) return this.ctxCommand(command, cx);
    if (command === "search") { this.startSearch(cx); return true; }
    if (command === "search-clear") { this.stopSearch(cx); return true; }
    if (command.startsWith("search-")) { this.search = command.slice(7); this.searching = false; cx.notify(); return true; }
    const mn = /^menu-(folder|pane)-(\d+)(?:-(\d+))?$/.exec(command);
    if (mn) {
      const f = this.foldersAllRaw()[Number(mn[2]) - 1];
      if (f) this.openMenu(mn[1] === "pane" ? { folder: f, pane: f.panes[Number(mn[3] || 1) - 1] } : { folder: f }, cx);
      return true;
    }
    const rn = /^rename-folder-(\d+)$/.exec(command);
    if (rn) { const f = this.foldersAllRaw()[Number(rn[1]) - 1]; if (f) this.renameFolder(f, cx); return true; }
    const rt = /^rename-text-(.*)$/s.exec(command);
    if (rt && this.rename) { this.rename.text = rt[1]; this.commitRename(cx); return true; }
    return this.extraCommandBase(command, cx);
  },

  // Manual folder order, kept in localStorage; a drag or Move up/down writes it.
  reorder(path, by) {
    const paths = this.foldersAllRaw().map((f) => f.path);
    const at = paths.indexOf(path);
    const to = at + by;
    if (at < 0 || to < 0 || to >= paths.length) return;
    paths.splice(to, 0, ...paths.splice(at, 1));
    this.setOrder(paths);
  },

  setOrder(paths) {
    this.order = paths;
    this.frame = null;
    localStorage.setItem("order", JSON.stringify(paths));
  },

  // --- rows -------------------------------------------------------------------------------------------------

  renderPane(t, pane, folder, _tint, _stripe, cx) {
    const key = `pane:${pane.paneId}`;
    const status = paneStatus(pane);
    const isAgent = pane.kind === "agent";
    const marked = pane.focused;
    const hovered = this.hoverKey === key;
    const cursor = this.selKey === key;
    const renaming = this.rename && this.rename.key === key;
    const name = paneName(pane);
    const expanded = isAgent && (this.allAgents || this.expanded.has(pane.paneId));
    const tab = pane.tabLabel ? `tab ${pane.tabLabel}` : pane.paneId;
    const detail = isAgent && pane.orchSummary ? pane.orchSummary : expanded ? [tab, displayTitle(pane)].filter(Boolean).join(" · ") : null;
    const live = panes().find((p) => p.pane === pane.paneId);
    const label = renaming
      ? h_flex().flex_1().h(20).px(6).items_center().rounded(5).bg(t.raised).border_1().border_color(t.accent).text_color(t.foreground).child(div().truncate().child(`${this.rename.text}\u258f`))
      : div().flex_1().truncate().when(Boolean(marked), (el) => el.font_semibold()).text_color(marked || pane.busy || isAgent ? t.foreground : t.muted).child(name);
    return v_flex()
      .id(`card-${pane.paneId}`)
      .mx(8)
      .rounded(7)
      .tooltip(`${name} · ${tilde((live && live.cwd) || folder.path)}`)
      .when(Boolean(marked), (el) => el.bg(t.selected))
      .when(!marked && cursor, (el) => el.bg(t.hover))
      .hover((s) => s.bg(marked ? t.selected : t.hover))
      .on_hover(this.hoverProps(key))
      .on_click((e) => { if (e.click_count >= 2) this.renamePane(pane, cx); else this.focusPane(pane); })
      .on_mouse_down("right", () => this.openMenu({ folder, pane }, cx))
      .child(
        h_flex().gap(8).pl(34).pr(4).h(this.settings.spacing === "compact" ? 24 : 28).items_center()
          .child(this.dot(t, status))
          .child(label)
          .when(!hovered, (el) => el.child(div().flex_none().pr(4).text_size(11).text_color(t[TOKEN[status]] ?? t.dim).child(STATE_LABEL[status] || status)))
          .when(hovered && !renaming, (el) => el.child(this.iconButton(t, `kill-${pane.paneId}`, "x", t.blocked, () => this.trash(`Close ${isAgent ? "agent" : "shell"}`, [pane], cx), undefined, "Close"))),
      )
      .when(detail !== null, (el) => el.child(div().pl(53).pr(8).pb(4).truncate().text_size(11).text_color(pane.orchSummary ? t.accent : t.dim).child(detail)));
  },

  renderFolder(t, folder, index, cx) {
    const key = `folder:${folder.path}`;
    const collapsed = this.settings.collapsible && this.collapsed.has(folder.path);
    const git = this.git[folder.path];
    const holdsFocus = folder.panes.some((p) => p.focused);
    const hovered = this.hoverKey === key;
    const cursor = this.selKey === key;
    const renaming = this.rename && this.rename.key === key;
    const dragging = this.pressed === folder.path && this.over !== null && this.over !== folder.path;
    const target = this.pressed !== null && this.over === folder.path && this.pressed !== folder.path;
    const fromIndex = this.pressed === null ? -1 : this.folders().findIndex((f) => f.path === this.pressed);
    const click = () => (this.settings.collapsible ? this.toggle(folder.path, cx) : folder.panes[0] && this.focusPane(folder.panes[0]));
    const color = t[avatarColor(folder.name)];
    const avatar = h_flex().size(18).flex_none().rounded(5).bg(color).items_center().justify_center().text_size(10.5).font_bold().text_color(t.chrome).child([...folder.name][0]?.toUpperCase() ?? "?");
    const count = folder.status
      ? h_flex().gap(5).flex_none().items_center().child(this.dot(t, folder.status)).child(div().text_size(11).text_color(t[TOKEN[folder.status]]).child(String(folder.agentCount)))
      : folder.terminalCount
        ? h_flex().gap(4).flex_none().items_center().child(svg(ICON("terminal")).size(11).text_color(t.dim)).child(div().text_size(11).text_color(t.dim).child(String(folder.terminalCount)))
        : null;
    const name = renaming
      ? h_flex().flex_1().h(20).px(6).items_center().rounded(5).bg(t.raised).border_1().border_color(t.accent).text_color(t.foreground).child(div().truncate().child(`${this.rename.text}\u258f`))
      : div().flex_1().truncate().font_semibold().text_color(holdsFocus ? t.accent : t.foreground).child(folder.name);
    const head = h_flex()
      .id(`head-${folder.path}`)
      .relative()
      .gap(8)
      .px(8)
      .mx(8)
      .h(30)
      .items_center()
      .rounded(8)
      .tooltip(tilde(folder.path))
      .when(holdsFocus, (el) => el.bg(t.selected))
      .when(!holdsFocus && cursor, (el) => el.bg(t.hover))
      .hover((s) => s.bg(holdsFocus ? t.selected : t.hover))
      .when(dragging, (el) => el.opacity(0.5))
      .when(target, (el) => el.child(div().absolute().left(0).right(0).h(2).bg(t.accent).when(fromIndex < index, (l) => l.bottom(0)).when(fromIndex > index, (l) => l.top(0))))
      .on_hover(this.hoverProps(key))
      .on_mouse_down("left", (e) => {
        if (e.click_count >= 2) { this.pressed = null; this.over = null; this.renameFolder(folder, cx); return; }
        this.pressed = folder.path;
        this.over = folder.path;
      })
      .on_mouse_move((_e, cx) => {
        if (this.pressed !== null && this.over !== folder.path) { this.over = folder.path; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        this.pressed = null;
        this.over = null;
        if (from === null) return;
        if (from === folder.path) click();
        else {
          const paths = this.foldersAllRaw().map((f) => f.path);
          const a = paths.indexOf(from);
          const b = paths.indexOf(folder.path);
          if (a >= 0 && b >= 0) { paths.splice(b, 0, ...paths.splice(a, 1)); this.setOrder(paths); }
        }
        cx.notify();
      })
      .on_mouse_down("right", () => this.openMenu({ folder }, cx))
      .when(this.settings.collapsible, (el) => el.child(svg(ICON(collapsed ? "chevron-right" : "chevron-down")).size(10).flex_none().text_color(t.dim)))
      .child(avatar)
      .child(name)
      .when(!hovered && count !== null, (el) => el.child(count))
      .when(hovered && !renaming, (el) => el
        .child(this.iconButton(t, `new-${folder.path}`, "plus", t.muted, () => this.newTab(folder), undefined, "New tab here"))
        .when(folder.panes.length > 0, (e2) => e2.child(this.iconButton(t, `trash-${folder.path}`, "x", t.blocked, () => this.trash(`Close everything in ${folder.name}`, folder.panes, cx), undefined, "Close all"))));
    const segments = git ? gitSegments(git) : [];
    const sub = collapsed
      ? null
      : git
        ? h_flex().pl(44).pr(8).pb(3).gap(4).items_center().flex_wrap().children(segments.map((seg, i) =>
            this.chip(t, seg.text, seg.key === "branch" ? t.accent : t[seg.token], seg.key === "branch" ? "git-branch" : undefined)
              .id(`git-${folder.path}-${i}`)
              .tooltip("Git changes")
              .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.openChanges(folder); })))
        : div().pl(44).pr(8).pb(3).truncate().text_size(11).text_color(t.dim).child(tilde(folder.path));
    return v_flex()
      .id(`folder-${folder.path}`)
      .pt(index === 0 ? 0 : 6)
      .child(head)
      .when(sub !== null, (el) => el.child(sub))
      .children(collapsed ? [] : folder.panes.map((pane) => this.renderPane(t, pane, folder, undefined, undefined, cx)));
  },

  // The panel: header, status line, env, search, list, footer hint.
  renderInner(cx) {
    if (this.changes) return this.changes.render(cx);
    const t = theme();
    const folders = this.folders();
    const all = this.foldersAllRaw();
    const allPaths = all.map((f) => f.path);
    const orch = orchRows(this.jobs, panes());
    const summary = this.env === "orch"
      ? [...(orch.running ? [{ status: "orch", count: orch.running }] : []), ...(orch.failed ? [{ status: "blocked", count: orch.failed }] : [])]
      : summarize(folders);
    const set = (fn) => () => { fn(); this.persist(); cx.notify(); };
    const searching = this.search !== null;
    const searchBar = searching
      ? h_flex().id("search-bar").mx(12).mb(6).px(8).h(28).gap(8).items_center().rounded(8).bg(t.raised).border_1().border_color(this.searching ? t.accent : t.input)
          .child(svg(ICON("search")).size(13).flex_none().text_color(t.dim))
          .child(div().flex_1().truncate().text_color(this.search ? t.foreground : t.dim).child(this.search ? `${this.search}${this.searching ? "\u258f" : ""}` : "Filter folders and terminals"))
          .child(this.iconButton(t, "search-clear", "x", t.muted, () => this.stopSearch(cx), undefined, "Clear (esc)"))
      : null;
    const empty = (title, hint) => v_flex().px(16).pt(24).gap(4).items_center().child(div().text_size(13).text_color(t.muted).child(title)).child(div().text_size(11).text_color(t.dim).child(hint));
    let list;
    if (this.view === "projects" && this.pm) list = this.renderProjects(t, cx);
    else if (this.env === "orch") list = v_flex().id("folder-list").flex_1().overflow_y_scroll().child(this.renderOrch(t, orch, cx));
    else if (!folders.length) {
      list = v_flex().id("folder-list").flex_1().child(
        searching && all.length ? empty(`No match for \u201c${this.search}\u201d`, "Esc clears the filter") : empty("No terminals yet", "Press + on a folder, or open a project"),
      );
    } else list = v_flex().id("folder-list").flex_1().min_h(0).overflow_y_scroll().pb(8).children(this.settings.grouping === "tree" ? this.renderTree(t, cx) : folders.map((folder, i) => this.renderFolder(t, folder, i, cx)));
    return v_flex()
      .id("folders-root")
      .size_full()
      .bg(t.chrome)
      .text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => { if (this.onKey(e, cx)) cx.stop_propagation(); })
      .on_mouse_up("left", (_e, cx) => { if (this.pressed !== null) { this.pressed = null; this.over = null; cx.notify(); } })
      .child(
        h_flex().h(31).pl(16).pr(8).items_center().justify_between().text_size(11.5).text_color(t.dim)
          .child(div().child("Folders"))
          .child(
            h_flex().gap(2)
              .child(this.iconButton(t, "search", "search", searching ? t.accent : t.muted, () => this.startSearch(cx), undefined, "Search (cmd-f)"))
              .when(this.settings.collapsible, (el) => el
                .child(this.iconButton(t, "collapse-all", "chevron-right", t.muted, set(() => { this.collapsed = new Set(allPaths); }), undefined, "Collapse all"))
                .child(this.iconButton(t, "expand-all", "chevron-down", t.muted, set(() => { this.collapsed = new Set(); }), undefined, "Expand all")))
              .child(this.iconButton(t, "hide", "chevron-left", t.muted, () => run("layout.hide", { id: "folders" }), undefined, "Hide panel"))
              .child(this.iconButton(t, "gear", "settings", this.menu ? t.accent : t.muted, () => { this.menu = !this.menu; this.ctx = null; cx.notify(); }, undefined, "Settings and actions")),
          ),
      )
      .child(
        h_flex().gap(12).pl(16).pr(8).pb(6).h(22).items_center()
          .children(summary.length
            ? summary.map(({ status, count }) => h_flex().gap(5).items_center().child(this.dot(t, status)).child(div().text_size(11).text_color(t[TOKEN[status]]).child(`${count} ${STATE_LABEL[status]}`)))
            : [div().text_size(11).text_color(t.dim).child("No agents running")]),
      )
      .child(this.renderEnvSelector(t, orch, cx))
      .child(this.renderSpaces(t, cx))
      .child(this.renderBulk(t, cx))
      .child(this.renderTabs(t, cx))
      .when(searchBar !== null, (el) => el.child(searchBar))
      .child(list)
      .child(h_flex().px(16).h(26).items_center().gap(10).border_t_1().border_color(t.input).text_size(11).text_color(t.dim).truncate().child("\u2318F search").child("\u23ce focus").child("right-click for more"));
  },

  renderEnvSelector(t, orch, cx) {
    const seg = (env, label, badge) =>
      h_flex().id(`env-${env}`).gap(5).px(10).h(22).items_center().justify_center().flex_1().rounded(6)
        .when(this.env === env, (el) => el.bg(t.selected).text_color(t.foreground).font_semibold())
        .when(this.env !== env, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover)))
        .on_click(() => this.setEnv(env, cx))
        .text_size(12)
        .child(label)
        .when(Boolean(badge), (el) => el.child(badge));
    const badge = orch.running || orch.failed
      ? h_flex().gap(4).items_center().text_size(11)
          .when(orch.running > 0, (el) => el.child(div().text_color(t.accent).child(`${orch.running} running`)))
          .when(orch.failed > 0, (el) => el.child(div().text_color(t.blocked).child(`\u25cf ${orch.failed}`)))
      : null;
    return h_flex().id("env-selector").mx(12).mb(6).p(2).gap(2).rounded(8).bg(t.raised).child(seg("default", "Default", null)).child(seg("orch", "Orch", badge));
  },
};

export function installUi(cls) {
  const proto = cls.prototype;
  proto.onKeyBase = proto.onKey;
  proto.extraCommandBase = proto.extraCommand;
  Object.assign(proto, methods);
}
