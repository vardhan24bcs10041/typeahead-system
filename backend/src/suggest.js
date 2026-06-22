// suggest.js — turn a typed prefix into the top-10 matching queries.
//
// A prefix search is a range scan on the sorted `query` index: every string
// starting with "ip" lies in the half-open interval ["ip", "iq") under byte
// ordering, so the B-tree jumps to "ip" in O(log n) and walks the matches
// instead of scanning the whole table.

import db from './db.js';

// Normalize stored queries and incoming prefixes the same way (trim + lowercase)
// so matching is case-insensitive by construction.
export function normalize(s) {
  return (s ?? '').trim().toLowerCase();
}

// Exclusive upper bound of the prefix range: bump the last code point by one
// ("ip" -> "iq", "iz" -> "i{"). Every string starting with `prefix` is strictly
// less than this, so [prefix, upperBound) captures exactly the matches. An
// explicit range also guarantees the index is used regardless of LIKE/collation.
export function prefixUpperBound(prefix) {
  if (prefix.length === 0) return null;
  const lastCode = prefix.charCodeAt(prefix.length - 1);
  return prefix.slice(0, -1) + String.fromCharCode(lastCode + 1);
}

// Prepared once and reused (avoids re-parsing the SQL on the hot path). The
// WHERE clause is the index range-scan; ORDER BY count DESC + LIMIT 10 keeps the
// top matches. Sort cost grows with how many rows the prefix matches, which is
// what the Redis cache absorbs by caching the top-10 per prefix.
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

// Candidate generation for recency-aware ranking: the top-N prefix matches by
// all-time count, later re-ranked by recent activity.
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
