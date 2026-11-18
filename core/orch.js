'use strict';

// Pure orch logic: validation of an activity record and the orch token of a pane.
// Reading the activity files and the cache live in lib/orch.js.

const TTL_SECS = 120;
const CACHE_MS = 2000;
const MAX_BYTES = 8 * 1024;
const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_SUMMARY = 200;

function isSafeSessionId(sessionId) {
  return typeof sessionId === 'string' && SAFE_ID.test(sessionId);
}

// Summary text of a parsed activity record, or null when the record is not an active, fresh one.
function summaryFromActivity(data, nowMs) {
  if (!data || typeof data !== 'object' || data.active !== true) return null;
  if (typeof data.updated_at !== 'number' || !Number.isFinite(data.updated_at)) return null;
  if (nowMs / 1000 - data.updated_at > TTL_SECS) return null;
  const summary = typeof data.summary === 'string' ? data.summary.trim().slice(0, MAX_SUMMARY) : '';
  return summary || 'orch running';
}

// Herdr's `orch` pane token is display-only metadata with a 120 s TTL set by the orch status bridge.
// Herdr drops it itself when it expires, so a present non-empty string counts as fresh.
function tokenSummary(tokens) {
  const value = tokens && typeof tokens === 'object' ? tokens.orch : null;
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_SUMMARY) : null;
}

module.exports = { TTL_SECS, CACHE_MS, MAX_BYTES, MAX_SUMMARY, isSafeSessionId, summaryFromActivity, tokenSummary };
