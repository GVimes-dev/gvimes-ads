'use strict';

/**
 * Simple in-memory TTL cache.
 *
 * Strategy: each placement×publisher pair gets one cache entry containing
 * the full serve_ad() result (eligible creatives + fallback URLs).
 * TTL defaults to 60 s (CACHE_TTL_SECONDS env var).
 *
 * On a cache miss the serve handler calls Postgres once via the serve_ad()
 * RPC, caches the result, then does sub-millisecond Map lookups for the
 * duration of the TTL window. The round-robin counter is stored separately
 * and is never cached — it advances on every request regardless of cache state.
 */

const TTL_MS = (parseInt(process.env.CACHE_TTL_SECONDS, 10) || 60) * 1000;

/** @type {Map<string, { value: any; expiresAt: number }>} */
const store = new Map();

/**
 * Return the cached value for `key`, or null if missing/expired.
 * @param {string} key
 */
function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

/**
 * Store `value` under `key` for TTL_MS milliseconds.
 * @param {string} key
 * @param {any} value
 */
function set(key, value) {
  store.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

/**
 * Remove a single cache entry (e.g. after a contract update).
 * @param {string} key
 */
function invalidate(key) {
  store.delete(key);
}

/** Flush the entire cache (called after contract mutations). */
function invalidateAll() {
  store.clear();
}

/** Current number of live entries (for health/debug endpoints). */
function size() {
  return store.size;
}

module.exports = { get, set, invalidate, invalidateAll, size };
