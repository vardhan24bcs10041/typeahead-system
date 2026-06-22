// suggest.js — turn a typed prefix into the top-10 matching queries.
//
// CORE IDEA: a prefix search is a RANGE SCAN on the sorted `query` index.
// Every string that starts with "ip" sits in the half-open interval
// ["ip", "iq") when strings are ordered byte-by-byte. So instead of scanning
// the whole table, the B-tree jumps to "ip" in O(log n) and walks matches.
// This is the SQL "indexes" advantage from Session 9, made concrete.

import db from './db.js';

// Normalize a string the SAME way for stored queries and incoming prefixes:
// trim surrounding whitespace + lowercase. This is what makes matching
// case-insensitive "by construction" (we never compare mixed case).
export function normalize(s) {
  return (s ?? '').trim().toLowerCase();
}

// Exclusive upper bound of the prefix range.
// We bump the LAST character's code point by one: "ip" -> "iq", "iz" -> "i{".
// Every string starting with `prefix` is strictly less than this value in byte
// order, so [prefix, upperBound) captures exactly the prefix matches — no more,
// no less. (Using an explicit range guarantees the index is used, regardless of
// SQLite's LIKE/collation settings. LIKE 'prefix%' is the alternative.)
export function prefixUpperBound(prefix) {
  if (prefix.length === 0) return null;
  const lastCode = prefix.charCodeAt(prefix.length - 1);
  return prefix.slice(0, -1) + String.fromCharCode(lastCode + 1);
}

// Prepared once, reused for every request (prepared statements avoid re-parsing
// the SQL and are a small but real latency win on the hot path).
//
// The WHERE clause is an index range-scan. The ORDER BY count DESC then sorts
// the matches and LIMIT 10 keeps the top suggestions. NOTE: the sort cost grows
// with how many rows match the prefix — short/hot prefixes match more rows. That
// cost is exactly what the Redis cache (Milestone 4) will absorb by caching the
// top-10 per prefix.
const suggestStmt = db.prepare(`
  SELECT query, count
  FROM queries
  WHERE query >= ? AND query < ?
  ORDER BY count DESC
  LIMIT 10
`);

/**
 * Return up to 10 suggestions for a prefix, sorted by count descending.
 * Handles empty/missing/mixed-case input gracefully (empty -> []).
 * @param {string} rawPrefix
 * @returns {{query: string, count: number}[]}
 */
export function getSuggestions(rawPrefix) {
  const prefix = normalize(rawPrefix);
  if (prefix.length === 0) return []; // empty or missing input -> graceful empty
  const upper = prefixUpperBound(prefix);
  return suggestStmt.all(prefix, upper);
}

// Candidate generation for recency-aware ranking (Milestone 5): the top-N
// prefix matches by all-time count, which we then re-rank by recent activity.
const candidatesStmt = db.prepare(`
  SELECT query, count
  FROM queries
  WHERE query >= ? AND query < ?
  ORDER BY count DESC
  LIMIT ?
`);

export function getTopByPrefix(rawPrefix, limit) {
  const prefix = normalize(rawPrefix);
  if (prefix.length === 0) return [];
  return candidatesStmt.all(prefix, prefixUpperBound(prefix), limit);
}
