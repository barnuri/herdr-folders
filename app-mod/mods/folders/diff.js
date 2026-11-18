// Draws diff rows: side by side (old | new, each with its line number) or unified.

import { div } from "gpui-kit";
import { h_flex, v_virtual_list, Scrollbar } from "gpui-base";
import { sideBySide } from "./difflogic.js";

const ROW = 20;

// One drawn row of the side-by-side layout.
function sideRow(t, row) {
  if (!row.left && !row.right) return row.kind === "@" ? div().w_full().px(12).h(ROW).flex_none().truncate().bg(t.raised).text_color(t.dim).child(row.text) : div().w_full().h(ROW).px(8).child(row.text);
  const leftKind = row.left && row.left.kind === " " ? " " : "-";
  const rightKind = row.right && row.right.kind === " " ? " " : "+";
  const half = (side, kind, n) =>
    h_flex()
      .flex_1()
      .min_w(0)
      .h(ROW)
      .gap(6)
      .when(Boolean(side) && kind !== " ", (el) => el.bg((kind === "-" ? t.ansi1 : t.ansi2) + "22"))
      .child(div().w(34).flex_none().text_right().text_color(t.dim).child(n))
      .child(div().flex_1().min_w(0).truncate().text_color(side && kind !== " " ? (kind === "-" ? t.ansi1 : t.ansi2) : t.foreground).child(side ? side.text : " "));
  return h_flex().w_full().h(ROW).flex_none().gap(2).child(half(row.left, leftKind, row.left ? String(row.left.old) : "")).child(div().w(1).h(ROW).flex_none().bg(t.border)).child(half(row.right, rightKind, row.right ? String(row.right.next) : ""));
}

function unifiedRow(t, row) {
  if (row.kind === "@") return div().w_full().px(12).h(ROW).flex_none().truncate().bg(t.raised).text_color(t.dim).child(row.text);
  if (row.kind === "") return div().w_full().h(ROW).px(8).child(row.text);
  const tint = row.kind === "+" ? t.ansi2 + "22" : row.kind === "-" ? t.ansi1 + "22" : undefined;
  return h_flex()
    .w_full()
    .h(ROW)
    .flex_none()
    .gap(6)
    .when(Boolean(tint), (el) => el.bg(tint))
    .child(div().w(34).flex_none().text_right().text_color(t.dim).child(row.old === undefined ? "" : String(row.old)))
    .child(div().w(34).flex_none().text_right().text_color(t.dim).child(row.next === undefined ? "" : String(row.next)))
    .child(div().w(10).flex_none().text_color(row.kind === "+" ? t.ansi2 : row.kind === "-" ? t.ansi1 : t.dim).child(row.kind === " " ? "" : row.kind))
    .child(div().flex_1().min_w(0).truncate().child(row.text));
}

// Prepares what the list draws: unified rows as they are, side-by-side rows paired.
export function prepare(rows, mode) {
  return mode === "unified" ? rows : sideBySide(rows);
}

// A virtual list of the prepared rows, with its scrollbar. `id` must stay the same for one list.
export function diffList(t, id, drawn, mode) {
  const draw = mode === "unified" ? unifiedRow : sideRow;
  return div()
    .flex_1()
    .min_h(0)
    .relative()
    .child(v_virtual_list(id, drawn.length, ROW, (i) => String(i), (range) => drawn.slice(range.start, range.end).map((row) => draw(t, row))).size_full())
    .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0());
}
