// The right-click menu of the folders panel: opened as a popup at the pointer, props.menu = { title, subtitle, items }.
// An item: { label, icon, hint, danger, sep?, act } where act is one of
//   { run: [name, args] } an app command, { mod: "<command>" } a command for the panel, { copy: text },
//   { exec: [cmd, ...args] }.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, theme, exec } from "herdr";

const ICON = (name) => `mods/workspace-chrome/${name}.svg`;

export class ContextMenu {
  init(cx) {
    this.handle = cx.focus_handle();
    this.sel = 0;
    this.menu = props().menu || { items: [] };
    this.rows = this.menu.items.filter((i) => !i.sep);
    this.handle.focus();
  }

  fire(item, cx) {
    const act = item.act || {};
    if (act.copy !== undefined) cx.write_to_clipboard(act.copy);
    else if (act.run) run(act.run[0], act.run[1] || {});
    else if (act.mod) run(`folders.${act.mod}`);
    else if (act.exec) exec(act.exec[0], act.exec.slice(1), { timeout: 10000 }).catch(() => {});
    closeOverlay(props().overlay);
  }

  render(cx) {
    const t = theme();
    const key = (e, cx) => {
      const k = e.key;
      if (k === "down" || k === "j") this.sel = Math.min(this.rows.length - 1, this.sel + 1);
      else if (k === "up" || k === "k") this.sel = Math.max(0, this.sel - 1);
      else if (k === "enter") return this.fire(this.rows[this.sel], cx);
      else if (k === "escape") return closeOverlay(props().overlay);
      else return;
      cx.stop_propagation();
      cx.notify();
    };
    let n = -1;
    const list = this.menu.items.map((item, i) => {
      if (item.sep) return div().h(1).my(4).mx(6).bg(t.input);
      const at = ++n;
      const on = at === this.sel;
      const color = item.danger ? t.blocked : t.foreground;
      return h_flex()
        .id(`m-${i}`)
        .h(26)
        .px(8)
        .gap(8)
        .items_center()
        .rounded(6)
        .when(on, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_hover((h, cx) => { if (h && this.sel !== at) { this.sel = at; cx.notify(); } })
        .on_click((e, cx) => this.fire(item, cx))
        .child(svg(ICON(item.icon || "square")).size(13).flex_none().text_color(item.danger ? t.blocked : t.muted))
        .child(div().flex_1().truncate().text_size(13).text_color(color).child(item.label))
        .when(Boolean(item.hint), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(item.hint)));
    });
    return v_flex()
      .id("ctx-popup")
      .size_full()
      .track_focus(this.handle)
      .on_key_down(key)
      .bg(t.popover)
      .rounded(10)
      .p(4)
      .child(
        v_flex().px(8).pt(4).pb(6).child(div().truncate().text_size(12).font_semibold().text_color(t.foreground).child(this.menu.title || ""))
          .when(Boolean(this.menu.subtitle), (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(this.menu.subtitle))),
      )
      .children(list);
  }
}
