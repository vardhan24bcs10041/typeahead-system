// batch.js — write-behind buffer for search-count updates.
//
// Instead of one synchronous SQLite transaction per search (M3), searches
// accumulate in an in-memory Map and are flushed together:
//   - aggregated: 1,000 searches of "java" become ONE "count = count + 1000"
//   - dual-triggered: flush every BATCH_INTERVAL_MS OR when the buffer reaches
//     BATCH_MAX_SIZE distinct queries (whichever comes first)
//
// TRADE-OFF (crash before flush): a search is acked immediately but only
// durable after the next flush. A hard crash loses up to one flush window of
// buffered counts. We mitigate with a graceful-shutdown drain (stopAndDrain);
// the production fix is a durable log (WAL / Redis list / Kafka — Session 5).

import db from './db.js';
import { metrics } from './metrics.js';
import { invalidatePrefixesOf } from './cache/cache.js';

const INTERVAL_MS = parseInt(process.env.BATCH_INTERVAL_MS || '2000', 10);
const MAX_SIZE = parseInt(process.env.BATCH_MAX_SIZE || '500', 10);

const buffer = new Map(); // query -> pending increment (aggregated)
let timer = null;
let flushing = false;

// UPSERT that ADDS the buffered delta (note `count = count + excluded.count`).
const upsertStmt = db.prepare(`
  INSERT INTO queries (query, count, last_searched_at)
  VALUES (?, ?, ?)
  ON CONFLICT(query) DO UPDATE
    SET count = count + excluded.count,
        last_searched_at = excluded.last_searched_at
`);

/** Record a search into the buffer (no DB write here). */
export function bufferSearch(query) {
  buffer.set(query, (buffer.get(query) || 0) + 1);
  metrics.searchBuffered();
  if (buffer.size >= MAX_SIZE) flush('size'); // burst -> flush early (fire & forget)
}

/** Pending (not-yet-flushed) increment for a query. */
export function pendingFor(query) {
  return buffer.get(query) || 0;
}

/**
 * Flush the buffer: ONE transaction of aggregated UPSERTs, then invalidate the
 * popular-cache prefixes of the flushed queries (their rankings just changed).
 */
export async function flush(reason = 'interval') {
  if (flushing || buffer.size === 0) return { rows: 0, reason };
  flushing = true;
  // snapshot + clear synchronously so new searches land in a fresh buffer
  const entries = [...buffer.entries()];
  buffer.clear();
  try {
    const now = Date.now();
    const writeAll = db.transaction((rows) => {
      for (const [q, c] of rows) upsertStmt.run(q, c, now);
    });
    writeAll(entries); // single transaction => single fsync, single writer lock
    metrics.recordFlush(entries.length, reason);
    await Promise.all(entries.map(([q]) => invalidatePrefixesOf(q)));
  } finally {
    flushing = false;
  }
  return { rows: entries.length, reason };
}

/** Start the periodic flush loop. */
export function startBatchWriter() {
  if (timer) return;
  timer = setInterval(() => flush('interval').catch(() => {}), INTERVAL_MS);
  if (timer.unref) timer.unref();
}

/** Stop the loop and drain the buffer (called on graceful shutdown). */
export async function stopAndDrain() {
  if (timer) { clearInterval(timer); timer = null; }
  await flush('shutdown');
}
