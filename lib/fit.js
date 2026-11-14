'use strict';

const herdrApi = require('./herdr');

// Which edge of the tab a pane's movable border is on: a pane whose right edge is short of the
// tab's right edge is on the left side, so its border is on its right.
function sideOf(layout, paneId) {
  const me = layout?.panes?.find((pane) => pane.pane_id === paneId);
  if (!me) return null;
  return me.rect.x + me.rect.width < layout.area.x + layout.area.width ? 'left' : 'right';
}

// Resize `paneId` to `target` columns. `pane resize --amount` is a fraction of the split, not a
// column count, so each step converts the missing columns with the tab width and re-measures.
async function fitWidth(paneId, target, currentCols) {
  const layout = (await herdrApi.herdr(['pane', 'layout', '--pane', paneId]).catch(() => null))?.layout;
  const side = sideOf(layout, paneId) || 'right';
  const total = layout?.area?.width || currentCols() * 3;
  const grow = side === 'left' ? 'right' : 'left';
  const shrink = side === 'left' ? 'left' : 'right';
  for (let step = 0; step < 8; step += 1) {
    const diff = target - currentCols();
    if (Math.abs(diff) < 1) break;
    const before = currentCols();
    const amount = Math.min(0.9, Math.max(0.005, Math.abs(diff) / total));
    await herdrApi.resizePane(paneId, diff > 0 ? grow : shrink, amount.toFixed(4)).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 80));
    if (currentCols() === before) break;
  }
  return side;
}

module.exports = { sideOf, fitWidth };
