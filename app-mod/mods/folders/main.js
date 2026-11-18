// Folders: terminals and agents grouped by folder (the git repo name, else the folder name).
// Data comes from herdr-app (adapter.js) and git (data.js); grouping, status and close rules come from
// the generated model.js and git.js.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, agents, theme, run, exec, nextCommand, props, setShared, shared, notify, home, readTextFile } from "herdr";
import { parseJobs, orchRows } from "./orchjobs.js";
import { ChangesView } from "./changes-view.js";
import { buildFolders, sortFolders, planClose, displayTitle } from "./model.js";
import { readSettings } from "./settings.js";
import { gitSegments, paneStatus, summarize, TOKEN, STATE_LABEL } from "./view.js";
import { herdrInput } from "./adapter.js";
import { repoRoot, repoStatus } from "./data.js";
import { createRefresh, rootsDue, ttlDue, GIT_TTL_MS, JOBS_TTL_MS } from "./util.js";
import { installExtras } from "./extras.js";
import { orchSpaceName, panesForEnv, spacesForEnv, ORCH_SPACE } from "./env.js";
import { ContextMenu } from "./menu.js";
import { installUi } from "./ui.js";
import { filterFolders, applyOrder } from "./listops.js";
import { initPerf, flushPerf, timed, perfLog } from "./perf.js";

const REFRESH_MS = 5000;
const CLOSE_LABELS = {
  "empty-folders": "Empty folders",
  "idle-agents-and-empty-folders": "Idle agents and empty folders",
  terminals: "All terminals (agents stay)",
  all: "Everything",
};
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;

export default class Folders extends View {
  init(_props, cx) {
    // A block with props.view "changes" is the Changes view of this mod, not the folder list.
    if ((props() || {}).menu) {
      this.menuView = new ContextMenu();
      this.menuView.init(cx);
      return;
    }
    if ((props() || {}).view === "changes") {
      this.changes = new ChangesView();
      this.changes.init(cx);
      return;
    }
    this.handle = cx.focus_handle();
    this.search = null; // live filter text, null = no filter
    this.searching = false; // the search box takes the keys
    this.rename = null; // inline rename: { key, kind, id, text }
    this.hoverKey = null; // row under the pointer (hover actions)
    this.pressed = null; // folder path pressed for a drag
    this.over = null; // folder path under the pointer while dragging
    const order = localStorage.getItem("order");
    this.order = typeof order === "string" ? JSON.parse(order) : [];
    this.roots = {}; // cwd -> git repo root, or null outside git
    this.git = {}; // repo root -> git status summary
    this.gitAt = {}; // repo root -> ms timestamp of its last status read
    this.jobsAt = undefined; // ms timestamp of the last hc ls
    this.force = false;
    this.lastSig = null;
    this.menu = false; // bulk close menu open
    this.ctx = null; // right-click menu: { folder, pane? }
    this.pending = null; // { mode, panes } waiting for confirmation
    this.cycle = 0; // refresh cycles run, to re-resolve the roots every ROOT_RESET_CYCLES
    this.refreshRun = createRefresh(() => this.readRepos());
    this.settings = readSettings(props());
    const saved = localStorage.getItem("collapsed");
    this.collapsed = new Set(typeof saved === "string" ? JSON.parse(saved) : Object.keys(this.settings.collapsed).filter((k) => this.settings.collapsed[k]));
    this.expanded = new Set(Object.keys(this.settings.expandedAgents).filter((k) => this.settings.expandedAgents[k]));
    this.allAgents = this.settings.allAgentsExpanded;
    this.showOrch = this.settings.showOrch; // orch terminals mixed into the folder groups
    this.orchOpen = localStorage.getItem("orchOpen") === "1"; // the Orch row is expanded
    this.jobs = []; // orch jobs from hc
    this.env = "default"; // "default" | "orch"; saved in the shared prefs
    this.lastDefaultSpace = null; // space selected before the switch to orch
    this.orchSpace = ORCH_SPACE; // settings.herdr_space of orch
    this.readOrchSpace();
    initPerf();
    this.initExtras();
    this.listen(cx);
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  // Refreshes the repo data, then redraws only when something the panel shows changed.
  // A refresh that starts while one runs is skipped. `force` (ctrl+r) ignores the TTLs.
  refresh(cx, force = false) {
    if (force) this.force = true;
    perfLog("tick", 0, `force=${force}`);
    flushPerf();
    cx.spawn(async (cx) => {
      const ran = await this.refreshRun();
      perfLog("repos", 0, `ran=${ran}`);
      await this.pullPrefs(cx);
      perfLog("prefs", 0);
      perfLog("refreshed", 0);
      const sig = this.signature();
      if (sig !== this.lastSig) {
        this.lastSig = sig;
        cx.notify();
      }
      flushPerf();
    });
  }

  // Everything a render reads that is not already tracked by the app: the app data, git, jobs, settings.
  signature() {
    return JSON.stringify([spaces(), panes(), agents(), this.git, this.jobs, this.settings, this.view, this.allAgents, this.env, this.orchSpace]);
  }

  // Resolves the repo root of each new pane folder, then reads the git status of the repos and the orch jobs
  // that are older than their TTL, all in parallel. No spawn happens on a tick where every cache is fresh.
  async readRepos() {
    const force = this.force;
    this.force = false;
    const cycle = this.cycle++;
    if (rootsDue(cycle)) this.roots = {};
    const cwds = [...new Set(panes().filter((pane) => pane.terminal !== null).map((pane) => pane.cwd || ""))].filter((cwd) => cwd && !(cwd in this.roots));
    const found = await Promise.all(cwds.map((cwd) => timed("git-root", () => repoRoot(cwd).catch(() => null), cwd)));
    cwds.forEach((cwd, i) => (this.roots[cwd] = found[i]));
    const now = Date.now();
    const roots = [...new Set(Object.values(this.roots).filter(Boolean))];
    const due = roots.filter((root) => ttlDue(this.gitAt[root], now, GIT_TTL_MS, force));
    const jobsDue = ttlDue(this.jobsAt, now, JOBS_TTL_MS, force);
    for (const root of due) this.gitAt[root] = now;
    if (jobsDue) this.jobsAt = now;
    const [statuses, hc] = await Promise.all([
      Promise.all(due.map((root) => timed("git-status", () => repoStatus(root).catch(() => null), root))),
      jobsDue ? timed("hc-ls", () => exec("hc", ["ls", "--json", "--all", "--label", "orch=1"], { timeout: 5000 }).catch(() => null)) : null,
    ]);
    due.forEach((root, i) => (this.git[root] = statuses[i]));
    if (hc && hc.code === 0) this.jobs = parseJobs(hc.stdout);
  }

  // Mod commands (<mod>.<command>), so the panel can be driven without a pointer:
  // collapse-all, expand-all, toggle-<n>, focus-<n>-<m>, close-<mode>, confirm, cancel, changes-<n> (n, m: 1-based).
  // A command that throws is logged; the loop keeps taking commands.
  listen(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const command = String(await nextCommand());
        try {
          this.command(command, cx);
        } catch (error) {
          console.log(`folders: command "${command}" failed: ${error && error.stack ? error.stack : error}`);
        }
        cx.notify();
      }
    });
  }

  command(command, cx) {
    if (this.extraCommand(command, cx)) return;
    const folders = this.folders();
    const [, name, a, b] = command.match(/^(toggle|focus|changes)-(\d+)(?:-(\d+))?$/) || [];
    const folder = folders[Number(a) - 1];
    if (command === "collapse-all") this.collapsed = new Set(folders.map((f) => f.path));
    else if (command === "expand-all") this.collapsed = new Set();
    else if (command === "orch-toggle") { this.orchOpen = !this.orchOpen; localStorage.setItem("orchOpen", this.orchOpen ? "1" : "0"); return; }
    else if (name === "toggle" && folder) return this.toggle(folder.path, cx);
    else if (name === "focus" && folder && folder.panes[Number(b) - 1]) run("pane.focus", { pane: folder.panes[Number(b) - 1].paneId });
    else if (name === "changes" && folder) return this.openChanges(folder);
    else if (command.startsWith("changes-do-")) return setShared("folders.changes-cmd", { seq: Date.now(), verb: command.slice(11) });
    else if (command === "changes-focused") return this.openFocusedChanges();
    else if (command.startsWith("close-") && CLOSE_LABELS[command.slice(6)]) return this.askClose(command.slice(6), cx);
    else if (command === "confirm" && this.pending) return this.confirmClose(cx);
    else if (command === "cancel") this.pending = null;
    else return;
    this.persist();
  }

  // Key g: the Changes view of the folder that holds the focused pane.
  openFocusedChanges() {
    const folders = this.folders();
    const folder = folders.find((f) => f.panes.some((p) => p.focused)) || folders[0];
    if (folder) this.openChanges(folder);
  }

  persist() {
    localStorage.setItem("collapsed", JSON.stringify([...this.collapsed]));
  }

  toggle(path, cx) {
    if (this.collapsed.has(path)) this.collapsed.delete(path);
    else this.collapsed.add(path);
    this.persist();
    cx.notify();
  }

  folders() {
    // Inside one render the model is built once; commands and ticks build it fresh.
    if (this.frame) return this.frame;
    return timed("folders()", () => this.foldersRaw());
  }

  foldersRaw() {
    return filterFolders(this.foldersAllRaw(), this.search);
  }

  // Every folder in the manual order, ignoring the search filter (bulk close, rename, reorder use this).
  foldersAllRaw() {
    const all = panes();
    const shown = panesForEnv(all, spaces(), this.env, this.jobAddresses(), this.orchSpace);
    const input = herdrInput({ spaces: spaces(), panes: shown, agents: agents() });
    return applyOrder(sortFolders(buildFolders({ ...input, roots: this.roots }), this.settings.sort), this.order);
  }

  askClose(mode, cx) {
    const focused = new Set(panes().filter((pane) => pane.focused).map((pane) => pane.pane));
    this.pending = { mode, panes: planClose(this.foldersAllRaw(), mode, { keepPaneIds: focused }) };
    this.menu = false;
    cx.notify();
  }

  confirmClose(cx) {
    for (const pane of this.pending.panes) run("pane.close", { pane: pane.paneId });
    notify({ title: "Folders", body: `closed ${this.pending.panes.length} pane(s)`, level: "success", timeout: 3000 });
    this.pending = null;
    cx.notify();
  }

  // Shows this mod's own Changes view (the panel block) for the folder.
  openChanges(folder) {
    const seq = Date.now();
    setShared("folders.changes", { cwd: folder.path, seq });
    run("layout.show", { id: "panel" });
  }

  button(t, id, label, onClick) {
    return div()
      .id(id)
      .px(8)
      .h(22)
      .items_center()
      .rounded(6)
      .bg(t.raised)
      .text_color(t.foreground)
      .hover((s) => s.bg(t.hover))
      .on_click(onClick)
      .child(label);
  }

  // Status glyph: spinner when working or orch, a dot for idle, check for done, ! for blocked, > running, › shell.
  glyph(t, status) {
    const color = t[TOKEN[status]] ?? t.dim;
    if (status === "working" || status === "orch") return svg(ICON("spinner")).size(12).flex_none().text_color(color).spin(900);
    if (status === "done") return svg(ICON("check")).size(12).flex_none().text_color(color);
    const text = { blocked: "!", idle: "\u25cf", unknown: "\u25cb", running: "\u25b6", shell: "\u203a" }[status] || "\u25cb";
    return div().w(12).flex_none().text_size(status === "idle" || status === "running" ? 9 : 12).text_color(color).flex().justify_center().child(text);
  }

  // Closes `targets` now, or asks first when confirmKill is on.
  trash(label, targets, cx) {
    if (!this.settings.confirmKill) {
      for (const pane of targets) run("pane.close", { pane: pane.paneId });
      return;
    }
    this.pending = { mode: "custom", label, panes: targets };
    cx.notify();
  }

  // Focuses a pane; herdr-app switches to its space and tab itself.
  focusPane(pane) {
    run("pane.focus", { pane: pane.paneId });
  }

  newTab(folder) {
    const [first] = folder.panes;
    // tab.new only shows the new tab in the selected space, so select the folder's space first.
    if (first && first.workspaceId) run("space.select", { id: first.workspaceId });
    run("tab.new", { folder: folder.path });
  }

  // Always asks before closing.
  ask(label, targets) {
    this.pending = { mode: "custom", label, panes: targets };
  }

  renderBulk(t, cx) {
    if (this.pending) {
      const count = this.pending.panes.length;
      const what = this.pending.label || CLOSE_LABELS[this.pending.mode];
      const text = count ? `${what}: close ${count} pane${count === 1 ? "" : "s"}?` : `Nothing to close (${what}).`;
      return v_flex()
        .id("bulk-confirm")
        .gap(6)
        .p(8)
        .m(8)
        .rounded(6)
        .border_1()
        .border_color(t.input)
        .bg(t.popover)
        .child(div().text_color(t.foreground).child(text))
        .child(
          h_flex()
            .gap(6)
            .child(this.button(t, "bulk-cancel", "Cancel", () => { this.pending = null; cx.notify(); }))
            .when(count > 0, (el) => el.child(this.button(t, "bulk-close", "Close", () => this.confirmClose(cx)))),
        );
    }
    if (!this.menu) return div();
    return this.renderActions(t, cx);
  }

  renderOldBulk(t, cx) {
    return v_flex()
      .id("bulk-menu")
      .gap(2)
      .p(6)
      .m(8)
      .rounded(6)
      .bg(t.popover)
      .child(div().px(4).font_bold().text_color(t.foreground).child("Actions"))
      .child(
        h_flex()
          .id("agents-all")
          .gap(8)
          .px(4)
          .h(24)
          .items_center()
          .rounded(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => { this.allAgents = !this.allAgents; cx.notify(); })
          .child(div().flex_1().text_color(this.allAgents ? t.accent : t.foreground).child("Agent details")),
      )
      .child(div().px(4).text_color(t.dim).child("Bulk close"))
      .children(
        Object.entries(CLOSE_LABELS).map(([mode, label], i) => {
          const count = planClose(this.folders(), mode).length;
          return h_flex()
            .id(`bulk-${mode}`)
            .gap(8)
            .px(4)
            .h(24)
            .items_center()
            .rounded(4)
            .hover((s) => s.bg(t.hover))
            .on_click(() => this.askClose(mode, cx))
            .child(div().text_color(t.accent).font_bold().child(String(i + 1)))
            .child(div().flex_1().truncate().text_color(mode === "all" ? t.blocked : t.foreground).child(label))
            .child(div().text_color(count ? t.muted : t.dim).child(String(count)));
        }),
      );
  }

  // The orch env: jobs grouped by run. Each job focuses like a card.
  renderOrch(t, orch, cx) {
    if (!orch.groups.length) return div().px(10).h(24).flex().items_center().text_size(12).text_color(t.dim).child("no orch work running");
    return v_flex()
      .id("orch-section")
      .children(
        orch.groups.map((group) =>
          v_flex()
            .id(`orch-run-${group.run}`)
            .child(div().pl(10).h(22).flex().items_center().font_bold().text_size(12).text_color(t.accent).child(group.run))
            .children(
              group.jobs.map((job) =>
                h_flex()
                  .id(`orch-job-${job.address}`)
                  .gap(6)
                  .pl(16)
                  .pr(8)
                  .h(22)
                  .items_center()
                  .when(Boolean(job.pane.focused), (e) => e.bg(t.selected))
                  .hover((s) => s.bg(t.hover))
                  .on_click(() => this.focusPane(job.pane))
                  .child(div().w(12).flex_none().text_color(job.failed ? t.blocked : t.accent).child(job.failed ? "!" : "\u25b6"))
                  .child(div().flex_1().truncate().text_size(12).text_color(job.failed ? t.blocked : t.muted).child(job.name))
                  .child(div().flex_none().text_size(12).text_color(job.failed ? t.blocked : t.dim).child(job.failed ? `exit ${job.exitCode}` : "running")),
              ),
            ),
        ),
      );
  }

  jobAddresses() {
    return new Set(this.jobs.map((j) => j.address));
  }

  // The orch space name comes from the orch settings (read only). Missing file or key: "orch".
  async readOrchSpace() {
    try {
      const text = await readTextFile(`${home()}/.harness-orch/profiles.json`);
      const name = orchSpaceName(text ? (JSON.parse(text).settings || {}).herdr_space : undefined);
      if (name !== this.orchSpace) this.orchSpace = name;
    } catch {}
    setShared("folders.env", { env: this.env, orchSpace: this.orchSpace });
  }

  // Env selector: Default | Orch, the Orch tab carries a badge (N running, a mark when something failed).
  renderEnvSelector(t, orch, cx) {
    const seg = (env, label, badge) =>
      h_flex()
        .id(`env-${env}`)
        .gap(5)
        .px(10)
        .h(22)
        .items_center()
        .justify_center()
        .flex_1()
        .rounded(6)
        .when(this.env === env, (el) => el.bg(t.selected).text_color(t.accent).font_bold())
        .when(this.env !== env, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover)))
        .on_click(() => this.setEnv(env, cx))
        .child(label)
        .when(Boolean(badge), (el) => el.child(badge));
    const badge = orch.running || orch.failed
      ? h_flex().gap(3).items_center().text_size(12)
          .when(orch.running > 0, (el) => el.child(div().text_color(t.accent).child(`${orch.running} running`)))
          .when(orch.failed > 0, (el) => el.child(div().text_color(t.blocked).child(`\u25cf ${orch.failed}`)))
      : null;
    return h_flex().id("env-selector").gap(2).px(10).pb(4).child(seg("default", "Default", null)).child(seg("orch", "Orch", badge));
  }

  // Space chips: the folders panel's own space switcher, shown while the app sidebar is hidden.
  renderSpaces(t, cx) {
    if (this.settings.showAppSidebar) return div();
    const list = spacesForEnv(spaces(), this.env, this.orchSpace);
    return h_flex().id("space-switcher").flex_wrap().gap(4).px(10).pb(4).children(
      list.map((space) =>
        div()
          .id(`space-${space.id}`)
          .px(8)
          .h(22)
          .flex()
          .items_center()
          .rounded(6)
          .max_w(150)
          .truncate()
          .when(Boolean(space.active), (el) => el.bg(t.selected).text_color(t.accent).font_bold())
          .when(!space.active, (el) => el.bg(t.raised).text_color(t.muted).hover((s) => s.bg(t.hover)))
          .on_click(() => run("space.select", { id: space.id }))
          .child(space.name),
      ),
    );
  }

  render(cx) {
    if (this.menuView) return this.menuView.render(cx);
    return timed(this.changes ? "render-changes" : "render", () => {
      if (this.changes) return this.renderInner(cx);
      this.frame = null;
      this.frame = this.folders();
      try {
        return this.renderInner(cx);
      } finally {
        this.frame = null;
      }
    });
  }
}

installExtras(Folders);
installUi(Folders);

