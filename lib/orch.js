'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TTL_SECS = 120;
const CACHE_MS = 2000;
const MAX_BYTES = 8 * 1024;
const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_SUMMARY = 200;

const cache = new Map();

function activityDir() {
  return path.join(process.env.HARNESS_ORCH_HOME || path.join(os.homedir(), '.harness-orch'), 'activity');
}

function readFile(sessionId, nowMs) {
  try {
    const file = path.join(activityDir(), `${sessionId}.json`);
    if (fs.statSync(file).size > MAX_BYTES) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || data.active !== true) return null;
    if (typeof data.updated_at !== 'number' || !Number.isFinite(data.updated_at)) return null;
    if (nowMs / 1000 - data.updated_at > TTL_SECS) return null;
    const summary = typeof data.summary === 'string' ? data.summary.trim().slice(0, MAX_SUMMARY) : '';
    return summary || 'orch running';
  } catch {
    return null;
  }
}

// Summary of the orch work of an agent session, or null. Cached for 2 s; never throws.
function orchSummary(sessionId, nowMs = Date.now()) {
  if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId)) return null;
  const hit = cache.get(sessionId);
  if (hit && nowMs - hit.at >= 0 && nowMs - hit.at < CACHE_MS) return hit.summary;
  const summary = readFile(sessionId, nowMs);
  cache.set(sessionId, { at: nowMs, summary });
  return summary;
}

// Herdr's `orch` pane token is display-only metadata with a 120 s TTL set by the orch status bridge.
// Herdr drops it itself when it expires, so a present non-empty string counts as fresh.
function tokenSummary(tokens) {
  const value = tokens && typeof tokens === 'object' ? tokens.orch : null;
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_SUMMARY) : null;
}

function clearCache() {
  cache.clear();
}

module.exports = { TTL_SECS, CACHE_MS, MAX_BYTES, orchSummary, tokenSummary, clearCache };
