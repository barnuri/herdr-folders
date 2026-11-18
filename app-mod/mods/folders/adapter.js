// Maps herdr-app data (spaces(), panes(), agents() from the "herdr" module) to the input of buildFolders
// in ./model.js. Pure: no herdr imports, so it takes the data as arguments.

export function herdrInput({ spaces, panes, agents }) {
  const tabSpace = new Map();
  const tabs = [];
  for (const space of spaces) {
    for (const tab of space.tabs) {
      tabSpace.set(tab.id, space.id);
      tabs.push({ tab_id: tab.id, label: tab.name });
    }
  }

  const agentByPane = new Map(agents.map((agent) => [agent.pane, agent]));
  const outPanes = [];
  const outAgents = [];
  const processInfo = {};
  const excludePaneIds = new Set();

  for (const pane of panes) {
    // Mod panes have no terminal: they are tools, not work.
    if (pane.terminal === null) {
      excludePaneIds.add(pane.pane);
      continue;
    }
    const cwd = pane.cwd || '';
    outPanes.push({
      pane_id: pane.pane,
      tab_id: pane.tab,
      workspace_id: tabSpace.get(pane.tab) ?? null,
      cwd,
      foreground_cwd: cwd,
      terminal_title: pane.title,
      label: pane.name ?? '',
      focused: pane.focused,
    });

    const agent = agentByPane.get(pane.pane);
    if (agent) {
      outAgents.push({
        pane_id: pane.pane,
        agent: agent.app || agent.program.name,
        agent_status: agent.status,
        name: agent.pane_name,
      });
    } else if (!pane.program.shell) {
      // A running program (not a shell, not an agent): busy. herdr-app gives no process tree,
      // so the program name stands in for the command line.
      processInfo[pane.pane] = {
        shell_pid: 1,
        foreground_process_group_id: 2,
        foreground_processes: [{ pid: 2, name: pane.program.name, cmdline: pane.program.name }],
      };
    }
  }

  return { panes: outPanes, agents: outAgents, processInfo, tabs, excludePaneIds, roots: {} };
}
