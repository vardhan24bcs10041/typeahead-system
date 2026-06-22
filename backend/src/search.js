// search.js — read helper for the search flow.
//
// The write path lives in batch.js: searches are buffered and flushed in
// aggregated batches rather than written synchronously. This module only reads
// the committed count, which /search adds to the pending buffer value so the
// user sees their increment immediately.

import db from './db.js';
import { normalize } from './suggest.js';

const countStmt = db.prepare('SELECT count FROM queries WHERE query = ?');

/** Committed (already-flushed) count for a query, or 0 if not stored yet. */
export function getStoredCount(rawQuery) {
  const row = countStmt.get(normalize(rawQuery));
  return row ? row.count : 0;
}
