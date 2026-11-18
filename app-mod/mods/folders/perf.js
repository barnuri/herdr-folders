// Scratch timing log of the folders mod (render ms, spawns, notifies). Hand-written.
// Off unless ~/.local/state/herdr-folders/perf.on exists. flushPerf() runs from the refresh tick.

import { home, readTextFile, writeTextFile } from "herdr";

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
let file = null;
let text = "";
let written = null;
let busy = false;

export async function initPerf() {
  try {
    const dir = `${home()}/.local/state/herdr-folders`;
    if ((await readTextFile(`${dir}/perf.on`)) === null) return;
    file = `${dir}/perf-${Date.now()}.log`;
  } catch {
    file = null;
  }
}

export function perfLog(kind, ms, extra = "") {
  if (file) text += `${Date.now()} ${kind} ${ms.toFixed(2)} ${extra}\n`;
}

export async function flushPerf() {
  if (!file || text === written || busy) return;
  busy = true;
  try {
    const out = text;
    await writeTextFile(file, out, await readTextFile(file));
    written = out;
  } catch (error) {
    console.log(`folders perf: flush failed: ${error}`);
  }
  busy = false;
}

// Runs fn and logs its wall time under `kind`.
export function timed(kind, fn, extra = "") {
  if (!file) return fn();
  const t0 = now();
  const out = fn();
  if (out && typeof out.then === "function") return out.finally(() => perfLog(kind, now() - t0, extra));
  perfLog(kind, now() - t0, extra);
  return out;
}
