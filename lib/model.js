'use strict';

// Adapter: the pure model lives in core/model.js. This file supplies the orch lookup from lib/orch.js.

const core = require('../core/model');
const { orchSummary } = require('./orch');

function buildFolders(options) {
  const orchLookup = options.orchLookup === undefined ? orchSummary : options.orchLookup;
  return core.buildFolders({ ...options, orchLookup });
}

module.exports = { ...core, buildFolders };
