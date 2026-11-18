// The folders mod's own Changes view: staged and unstaged groups, side-by-side or unified diff,
// stage, unstage, discard (asks first), commit, fetch, pull and push.
// main.js creates it when the block's props say view: "changes". It is opened by main.js, which
// writes the folder to shared("folders.changes"); commands arrive in shared("folders.changes-cmd").

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, shared, setShared, settings, layout } from "herdr";
import { repoOf, readChanges, readDiff, stage, unstage, stageAll, unstageAll, commit, fetch, pull, push, discard } from "./changes.js";
import { diffRows } from "./difflogic.js";
import { prepare, diffList } from "./diff.js";
import { formatGitLine } from "./git.js";
import { timed } from "./perf.js";

const POLL_MS = 300;
const REFRESH_MS = 10000;

// The panel that holds this view is shown (a hidden panel needs no git status every 4 s).
function panelShown() {
  const find = (node) => (!node || typeof node !== "object" ? null : node.id === "panel" ? node : (node.children || []).map(find).find(Boolean) || null);
  const panel = find(layout());
  return !panel || panel.hidden !== true;
}
const LETTER = { M: "M", A: "A", D: "D", R: "R", C: "C", T: "M", "?": "U", U: "!" };

const letter = (file, staged) => {
  if (file.untracked) return "U";
  if (file.conflict) return "!";
  return LETTER[staged ? file.index : file.worktree] || "M";
};

export class ChangesView {
  init(cx) {
    this.target = null; // { cwd, seq } last shared target taken
    this.cmdSeq = 0;
    this.root = null;
    this.data = null; // { summary, staged, unstaged }
    this.open = null; // { path, staged }
    this.rows = [];
    this.drawn = [];
    this.mode = "side";
    this.confirm = null; // file waiting for a discard answer
    this.note = null;
    this.error = null;
    this.busy = false;
    this.typing = false;
    this.message = "";
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message (enter commits staged)" });
    this.input.on("change", () => { this.message = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    cx.timer.every(POLL_MS, (cx) => this.poll(cx));
    cx.timer.every(REFRESH_MS, (cx) => { if (panelShown()) this.refresh(cx, false); });
  }

  // Takes a new folder and any new command from shared state.
  poll(cx) {
    const target = shared("folders.changes");
    if (target && target.cwd && (!this.target || target.seq !== this.target.seq)) {
      this.target = target;
      this.root = null;
      this.data = null;
      this.open = null;
      this.rows = [];
      this.drawn = [];
      this.note = null;
      this.confirm = null;
      this.refresh(cx);
    }
    const cmd = shared("folders.changes-cmd");
    if (cmd && cmd.seq > this.cmdSeq) {
      this.cmdSeq = cmd.seq;
      this.verb(String(cmd.verb), cx);
    }
  }

  // Command verbs (folders.changes-do-<verb>), so the view is drivable without a pointer.
  verb(verb, cx) {
    const [, name, n] = verb.match(/^(stage|unstage|discard|select|select-staged)-(\d+)$/) || [];
    const d = this.data;
    if (name === "stage" && d && d.unstaged[n - 1]) return this.act(cx, () => stage(this.root, [d.unstaged[n - 1].path]));
    if (name === "unstage" && d && d.staged[n - 1]) return this.act(cx, () => unstage(this.root, [d.staged[n - 1].path]));
    if (name === "discard" && d && d.unstaged[n - 1]) return this.ask(d.unstaged[n - 1], cx);
    if (name === "select" && d && d.unstaged[n - 1]) return this.pick(d.unstaged[n - 1], false, cx);
    if (name === "select-staged" && d && d.staged[n - 1]) return this.pick(d.staged[n - 1], true, cx);
    if (verb === "stage-all") return this.act(cx, () => stageAll(this.root));
    if (verb === "unstage-all") return this.act(cx, () => unstageAll(this.root));
    if (verb === "toggle-view") return this.toggleMode(cx);
    if (verb === "confirm-discard") return this.doDiscard(cx);
    if (verb === "cancel") { this.confirm = null; cx.notify(); return; }
    if (verb === "commit") return this.commit(cx);
    if (verb === "fetch") return this.act(cx, () => fetch(this.root), "Fetched");
    if (verb === "pull") return this.act(cx, () => pull(this.root), "Pulled");
    if (verb === "push") return this.act(cx, () => push(this.root), "Pushed");
    if (verb.startsWith("msg-")) { this.input.set_value(verb.slice(4)); this.message = verb.slice(4); cx.notify(); }
  }

  // `force` (a new folder, a command) always reloads the open diff and redraws; the timer only when git status changed.
  refresh(cx, force = true) {
    if (!this.target || this.loading) return;
    const seq = this.target.seq;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        if (!this.root) this.root = await repoOf(this.target.cwd);
        if (!this.root) { this.error = "Not a git repository"; this.data = null; return; }
        const data = await timed("changes-status", () => readChanges(this.root));
        if (!this.target || this.target.seq !== seq) return;
        if (!force && this.data && JSON.stringify(data) === JSON.stringify(this.data)) { this.unchanged = true; return; }
        this.data = data;
        this.error = null;
        // Keep the open file while it is still in its group; otherwise open the first file.
        const group = this.open && (this.open.staged ? data.staged : data.unstaged);
        const still = group && group.find((f) => f.path === this.open.path);
        if (still) await this.load(still, this.open.staged);
        else {
          const first = data.unstaged[0] ? [data.unstaged[0], false] : data.staged[0] ? [data.staged[0], true] : null;
          if (first) await this.load(first[0], first[1]);
          else { this.open = null; this.setRows([]); }
        }
      } catch (e) {
        this.error = String(e.message || e);
      } finally {
        this.loading = false;
        if (this.unchanged) this.unchanged = false;
        else cx.notify();
      }
    });
  }

  async load(file, staged) {
    this.open = { path: file.path, staged };
    const lines = await readDiff(this.root, file, staged).catch((e) => [`Cannot preview this diff: ${e.message || e}`]);
    if (this.open && this.open.path === file.path && this.open.staged === staged) this.setRows(lines);
  }

  setRows(lines) {
    this.rows = diffRows(lines);
    this.drawn = prepare(this.rows, this.mode);
  }

  pick(file, staged, cx) {
    this.confirm = null;
    this.open = { path: file.path, staged };
    this.setRows([]);
    cx.spawn(async (cx) => { await this.load(file, staged); cx.notify(); });
    cx.notify();
  }

  toggleMode(cx) {
    this.mode = this.mode === "side" ? "unified" : "side";
    this.drawn = prepare(this.rows, this.mode);
    cx.notify();
  }

  // Runs a git write, then reloads. One write at a time.
  act(cx, fn, done) {
    if (this.busy || !this.root) return;
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        await fn();
        if (done) this.note = done;
      } catch (e) {
        this.note = `Failed: ${e.message || e}`;
      } finally {
        this.busy = false;
        this.loading = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  ask(file, cx) {
    this.confirm = file;
    cx.notify();
  }

  doDiscard(cx) {
    const file = this.confirm;
    this.confirm = null;
    if (file) this.act(cx, () => discard(this.root, file));
  }

  commit(cx) {
    const message = this.message.trim();
    if (!message) { this.note = "Type a commit message first"; cx.notify(); return; }
    if (!this.data || !this.data.staged.length) { this.note = "Nothing staged"; cx.notify(); return; }
    this.act(cx, async () => {
      await commit(this.root, message);
      this.input.set_value("");
      this.message = "";
    }, "Committed");
  }

  button(t, id, label, onClick, { color, enabled = true } = {}) {
    return div()
      .id(id)
      .h(22)
      .px(7)
      .flex()
      .items_center()
      .flex_none()
      .rounded(5)
      .bg(t.raised)
      .text_size(12)
      .text_color(enabled ? color || t.foreground : t.dim)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { if (enabled) onClick(cx); })
      .child(label);
  }

  fileRow(t, file, staged, i) {
    const parts = file.path.split("/");
    const name = parts.pop();
    const active = this.open && this.open.path === file.path && this.open.staged === staged;
    const l = letter(file, staged);
    const color = l === "A" || l === "U" ? t.ansi2 : l === "D" || l === "!" ? t.ansi1 : t.blocked;
    const tag = staged ? "s" : "u";
    return h_flex()
      .id(`chg-${tag}-${file.path}`)
      .h(26)
      .flex_none()
      .px(6)
      .gap(6)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .when(Boolean(active), (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.pick(file, staged, cx))
      .child(div().w(14).flex_none().text_size(12).text_color(color).child(l))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? `${parts.join("/")}/` : "")).child(div().min_w(0).truncate().child(name)))
      .child(staged ? this.button(t, `un-${tag}-${file.path}`, "−", (cx) => this.act(cx, () => unstage(this.root, [file.path])), {}) : this.button(t, `st-${tag}-${file.path}`, "+", (cx) => this.act(cx, () => stage(this.root, [file.path])), {}))
      .when(!staged, (el) => el.child(this.button(t, `dc-${file.path}`, "✕", (cx) => this.ask(file, cx), { color: t.ansi1 })));
  }

  group(t, title, files, staged, allLabel, onAll) {
    return v_flex()
      .flex_none()
      .child(
        h_flex()
          .h(26)
          .px(6)
          .gap(6)
          .items_center()
          .child(div().font_semibold().text_size(12).text_color(t.muted).child(`${title} (${files.length})`))
          .child(div().flex_1())
          .when(files.length > 0, (el) => el.child(this.button(t, `all-${staged ? "s" : "u"}`, allLabel, onAll))),
      )
      .children(files.map((file, i) => this.fileRow(t, file, staged, i)));
  }

  render(cx) {
    const t = theme();
    const d = this.data;
    const sum = d ? d.summary : null;
    const branch = sum ? formatGitLine(sum) : "";
    const body = d || { staged: [], unstaged: [] };
    return v_flex()
      .id("changes-view")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { if (this.confirm) this.confirm = null; this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
        else if (e.key === "v" && !this.typing) this.toggleMode(cx);
      })
      .child(
        h_flex()
          .h(40)
          .flex_none()
          .px(10)
          .gap(6)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().font_semibold().child("Changes"))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.accent).child(branch))
          .child(this.button(t, "chg-view", this.mode === "side" ? "Unified" : "Side by side", (cx) => this.toggleMode(cx)))
          .child(this.button(t, "chg-fetch", "Fetch", (cx) => this.act(cx, () => fetch(this.root), "Fetched"), { enabled: Boolean(this.root) }))
          .child(this.button(t, "chg-pull", "Pull", (cx) => this.act(cx, () => pull(this.root), "Pulled"), { enabled: Boolean(this.root) }))
          .child(this.button(t, "chg-push", "Push", (cx) => this.act(cx, () => push(this.root), "Pushed"), { enabled: Boolean(this.root) })),
      )
      .child(
        v_flex()
          .id("chg-list")
          .flex_none()
          .max_h(240)
          .overflow_y_scroll()
          .p(6)
          .border_b(1)
          .border_color(t.border)
          .child(this.group(t, "Staged", body.staged, true, "Unstage all", (cx) => this.act(cx, () => unstageAll(this.root))))
          .child(this.group(t, "Changes", body.unstaged, false, "Stage all", (cx) => this.act(cx, () => stageAll(this.root))))
          .when(!d, (el) => el.child(div().p(8).text_color(t.dim).child(this.error || (this.target ? "Loading changes…" : "Pick a folder: click its branch, right-click it, or press g"))))
          .when(Boolean(d) && !body.staged.length && !body.unstaged.length, (el) => el.child(div().p(8).text_color(t.dim).child("No uncommitted changes"))),
      )
      .when(Boolean(this.confirm), (el) =>
        el.child(
          h_flex()
            .id("chg-confirm")
            .flex_none()
            .px(10)
            .py(6)
            .gap(8)
            .items_center()
            .bg(t.popover)
            .child(div().flex_1().min_w(0).truncate().text_color(t.ansi1).child(`Discard changes to ${this.confirm.path}? This cannot be undone.`))
            .child(this.button(t, "chg-discard-yes", "Discard", (cx) => this.doDiscard(cx), { color: t.ansi1 }))
            .child(this.button(t, "chg-discard-no", "Cancel", (cx) => { this.confirm = null; cx.notify(); })),
        ),
      )
      .child(
        h_flex()
          .flex_none()
          .h(24)
          .px(10)
          .items_center()
          .text_size(11)
          .text_color(t.dim)
          .truncate()
          .child(this.open ? `${this.open.path}${this.open.staged ? " (staged)" : ""}` : "Select a file to view its changes"),
      )
      .child(div().flex_1().min_h(0).font_family(settings().font_family ?? "JetBrains Mono").text_size(11).flex().flex_col().child(diffList(t, "chg-diff", this.drawn, this.mode)))
      .when(Boolean(this.note), (el) => el.child(div().px(10).pb(6).text_size(11).text_color(String(this.note).startsWith("Failed") ? t.ansi1 : t.ansi2).child(this.note)))
      .child(
        h_flex()
          .flex_none()
          .p(10)
          .gap(8)
          .border_t(1)
          .border_color(t.border)
          .child(
            div()
              .id("chg-message")
              .flex_1()
              .min_w(0)
              .h(32)
              .px(10)
              .flex()
              .items_center()
              .rounded(8)
              .border_1()
              .border_color(this.typing ? t.accent : t.border)
              .cursor_text()
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)),
          )
          .child(this.button(t, "chg-commit", this.busy ? "Working…" : "Commit", (cx) => this.commit(cx), { enabled: Boolean(this.root) && !this.busy })),
      );
  }
}
