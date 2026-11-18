'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../core/orch');

const { TTL_SECS, CACHE_MS, MAX_BYTES } = core;

const cache = new Map();

function activityDir() {
  return path.join(process.env.HARNESS_ORCH_HOME || path.join(os.homedir(), '.harness-orch'), 'activity');
}

function readFile(sessionId, nowMs) {
  try {
    const file = path.join(activityDir(), `${sessionId}.json`);
    if (fs.statSync(file).size > MAX_BYTES) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return core.summaryFromActivity(data, nowMs);
  } catch {
    return null;
  }
}

// Summary of the orch work of an agent session, or null. Cached for 2 s; never throws.
function orchSummary(sessionId, nowMs = Date.now()) {
  if (!core.isSafeSessionId(sessionId)) return null;
  const hit = cache.get(sessionId);
  if (hit && nowMs - hit.at >= 0 && nowMs - hit.at < CACHE_MS) return hit.summary;
  const summary = readFile(sessionId, nowMs);
  cache.set(sessionId, { at: nowMs, summary });
  return summary;
}

function clearCache() {
  cache.clear();
}

module.exports = { TTL_SECS, CACHE_MS, MAX_BYTES, orchSummary, tokenSummary: core.tokenSummary, clearCache };
