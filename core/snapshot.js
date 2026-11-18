'use strict';

// Pure snapshot logic: recognises this plugin's own panel panes from their process info.
// Collecting panes, git and plugin roots from herdr lives in lib/snapshot.js.

const PANEL_SCRIPT = /bin\/(sidebar|slot|git-panel|confirm)\.js/;

// A pane whose foreground process runs one of this plugin's panel scripts is our own panel.
// herdr starts manifest commands with relative paths, so the process cwd identifies the plugin.
function isPanelPane(info, pluginRoot, script = PANEL_SCRIPT) {
  return (info?.foreground_processes || []).some((proc) => {
    const cmdline = proc.cmdline || '';
    if (!script.test(cmdline)) return false;
    return cmdline.includes(pluginRoot) || (proc.cwd || '') === pluginRoot;
  });
}

module.exports = { PANEL_SCRIPT, isPanelPane };
