'use strict';

const ESC = '\x1b';

const ANSI = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  italic: `${ESC}[3m`,
  underline: `${ESC}[4m`,
  inverse: `${ESC}[7m`,
  clear: `${ESC}[2J`,
  home: `${ESC}[H`,
  clearLine: `${ESC}[2K`,
  hideCursor: `${ESC}[?25l`,
  showCursor: `${ESC}[?25h`,
  altScreenOn: `${ESC}[?1049h`,
  altScreenOff: `${ESC}[?1049l`,
  // 1002 = motion while a button is held (drag), 1003 = all motion (hover), 1006 = SGR coordinates
  mouseOn: `${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h`,
  mouseOff: `${ESC}[?1006l${ESC}[?1003l${ESC}[?1002l${ESC}[?1000l`,
};

// A number is a 256-colour index; an [r, g, b] array is truecolor.
const fg = (n) => (Array.isArray(n) ? `${ESC}[38;2;${n.join(';')}m` : `${ESC}[38;5;${n}m`);
const bg = (n) => (Array.isArray(n) ? `${ESC}[48;2;${n.join(';')}m` : `${ESC}[48;5;${n}m`);

// One calm palette (Catppuccin Mocha): neutral text in three steps, soft pastel accents, and
// surfaces only a few shades apart, so colour marks state instead of decorating.
const THEME = {
  text: [205, 214, 244],
  muted: [166, 173, 200],
  faint: [108, 112, 134],
  border: [69, 71, 90],
  base: [17, 17, 27],
  surface: [24, 24, 37],
  hover: [49, 50, 68],
  selected: [45, 52, 82],
  selectedHover: [54, 62, 96],
  // Folder cards alternate between two close shades; the stripe carries the folder's colour.
  cardA: [30, 30, 46],
  cardAHead: [36, 37, 56],
  cardB: [40, 41, 60],
  cardBHead: [48, 50, 72],
  accent: [137, 180, 250],
  green: [166, 227, 161],
  yellow: [249, 226, 175],
  amber: [250, 179, 135],
  red: [243, 139, 168],
  cyan: [148, 226, 213],
  magenta: [203, 166, 247],
  blue: [137, 180, 250],
};

const STATUS_STYLE = {
  working: { color: THEME.amber, glyph: null, label: 'working' },
  orch: { color: THEME.magenta, glyph: null, label: 'orch' },
  blocked: { color: THEME.red, glyph: '\uf071', label: 'blocked' },
  done: { color: THEME.blue, glyph: '\uf00c', label: 'done' },
  idle: { color: THEME.green, glyph: '\u25cf', label: 'idle' },
  unknown: { color: THEME.muted, glyph: '\u25cb', label: 'unknown' },
  running: { color: THEME.cyan, glyph: '\u25b6', label: 'running' },
  shell: { color: THEME.faint, glyph: '\u203a', label: 'shell' },
};

const SPINNER = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];

function statusGlyph(status, frame = 0) {
  const style = STATUS_STYLE[status] || STATUS_STYLE.unknown;
  return style.glyph || SPINNER[frame % SPINNER.length];
}

function isWide(codePoint) {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  );
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

function width(text) {
  let total = 0;
  for (const char of stripAnsi(text)) {
    total += isWide(char.codePointAt(0)) ? 2 : 1;
  }
  return total;
}

function truncate(text, max) {
  if (max <= 0) return '';
  if (width(text) <= max) return text;
  let out = '';
  let used = 0;
  for (const char of text) {
    const w = isWide(char.codePointAt(0)) ? 2 : 1;
    if (used + w > max - 1) break;
    out += char;
    used += w;
  }
  return `${out}\u2026`;
}

// Truncate from the left, keeping the tail of a path visible.
function truncateLeft(text, max) {
  if (width(text) <= max) return text;
  const chars = [...text];
  return `\u2026${chars.slice(chars.length - (max - 1)).join('')}`;
}

// A line is built from segments so the panel can map mouse columns back to actions.
class Line {
  constructor() {
    this.parts = [];
    this.cols = 0;
    this.hits = [];
    this.background = null;
    this.tint = null;
  }

  add(text, style = '', action = null) {
    const w = width(text);
    if (action) this.hits.push({ x0: this.cols, x1: this.cols + w, action });
    this.parts.push({ text, style, w });
    this.cols += w;
    return this;
  }

  pad(target) {
    if (this.cols < target) this.add(' '.repeat(target - this.cols));
    return this;
  }

  // Clip to `cols` so a long line never spills into a neighbouring column.
  render(cols) {
    // `tint` is a group colour under the row; `background` (selection, hover) wins over it.
    const colour = this.background ?? this.tint ?? null;
    const fill = colour === null ? '' : bg(colour);
    let body = '';
    let used = 0;
    for (const part of this.parts) {
      if (used >= cols) break;
      const text = used + part.w > cols ? truncate(part.text, cols - used) : part.text;
      used += Math.min(part.w, cols - used);
      body += part.style ? `${part.style}${text}${ANSI.reset}${fill}` : text;
    }
    return `${fill}${body}${' '.repeat(Math.max(0, cols - used))}${ANSI.reset}`;
  }
}

// Split a raw stdin chunk into key and SGR mouse events.
function parseInput(chunk) {
  const events = [];
  let i = 0;
  while (i < chunk.length) {
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(chunk.slice(i));
    if (mouse) {
      const button = Number(mouse[1]);
      events.push({
        type: 'mouse',
        button: button & 3,
        motion: Boolean(button & 32),
        wheel: Boolean(button & 64),
        x: Number(mouse[2]) - 1,
        y: Number(mouse[3]) - 1,
        press: mouse[4] === 'M',
      });
      i += mouse[0].length;
      continue;
    }
    const csi = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(chunk.slice(i)) || /^\x1bO[A-Za-z]/.exec(chunk.slice(i));
    if (csi) {
      events.push({ type: 'key', key: csi[0] });
      i += csi[0].length;
      continue;
    }
    events.push({ type: 'key', key: chunk[i] });
    i += 1;
  }
  return events;
}

const KEYS = {
  up: ['\x1b[A', '\x1bOA'],
  down: ['\x1b[B', '\x1bOB'],
  right: ['\x1b[C', '\x1bOC'],
  left: ['\x1b[D', '\x1bOD'],
  pageUp: ['\x1b[5~'],
  pageDown: ['\x1b[6~'],
  home: ['\x1b[H', '\x1b[1~', '\x1bOH'],
  end: ['\x1b[F', '\x1b[4~', '\x1bOF'],
  enter: ['\r', '\n'],
  escape: ['\x1b'],
  backspace: ['\x7f', '\b'],
  tab: ['\t'],
  ctrlC: ['\x03'],
};

function keyName(key) {
  for (const [name, codes] of Object.entries(KEYS)) {
    if (codes.includes(key)) return name;
  }
  return key;
}

module.exports = { ANSI, THEME, STATUS_STYLE, SPINNER, fg, bg, statusGlyph, width, truncate, truncateLeft, stripAnsi, Line, parseInput, keyName };
