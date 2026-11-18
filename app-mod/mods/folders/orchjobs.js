// Orch jobs in the folders mod: which panes belong to orch, and the rows of the "Orch" section.
// Pure: no herdr imports. Hand-written (not generated).

export const ORCH_SPACE = "orch";

// Jobs come from `hc ls --json --all --label orch=1`. A name looks like "<run tail>-<node>-<job id>".
export function parseJobs(json) {
  let data;
  try { data = typeof json === "string" ? JSON.parse(json) : json; } catch { return []; }
  const list = data && Array.isArray(data.terminals) ? data.terminals : [];
  return list.filter((t) => t && typeof t.address === "string").map((t) => ({
    address: t.address,
    name: String(t.name || t.address),
    where: String(t.where || ""),
    state: t.state === "live" ? "live" : "finished",
    exitCode: typeof t.exit_code === "number" ? t.exit_code : null,
  }));
}

// Group key (the run) of a job: the tab part of "orch / <run tab>", else "other".
export function runOf(job) {
  const part = job.where.includes("/") ? job.where.split("/").pop().trim() : "";
  return part || "other";
}

// Panes of orch: in the orch space, or with a terminal address an orch job owns.
export function orchPaneIds(panes, spaces, jobs, orchSpace = ORCH_SPACE) {
  const tabIsOrch = new Set();
  for (const space of spaces) if (space.name === orchSpace) for (const tab of space.tabs) tabIsOrch.add(tab.id);
  const addresses = new Set(jobs.map((j) => j.address));
  return new Set(panes.filter((p) => tabIsOrch.has(p.tab) || addresses.has(p.terminal)).map((p) => p.pane));
}

// Rows to show: jobs that have a pane (so a click can focus them), running or failed. Finished and ok are dropped.
// Returns { running, failed, groups: [{ run, jobs: [{ ...job, pane, failed }] }] }.
export function orchRows(jobs, panes) {
  const byTerminal = new Map(panes.map((p) => [p.terminal, p]));
  const rows = [];
  for (const job of jobs) {
    const pane = byTerminal.get(job.address);
    if (!pane) continue;
    const failed = job.state === "finished" && job.exitCode !== 0;
    if (job.state === "finished" && !failed) continue;
    rows.push({ ...job, pane, failed });
  }
  const groups = new Map();
  for (const row of rows) {
    const key = runOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return {
    running: rows.filter((r) => !r.failed).length,
    failed: rows.filter((r) => r.failed).length,
    groups: [...groups.entries()].map(([run, list]) => ({ run, jobs: list })),
  };
}
