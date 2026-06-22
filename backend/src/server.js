// server.js — Express app exposing the typeahead APIs.
//
//   GET  /suggest?q=<prefix>        cache-aside top-10 suggestions
//   POST /search                    record search + invalidate affected cache
//   GET  /cache/debug?prefix=<p>    which node owns the prefix + hit/miss
//   GET  /metrics                   cache hit rate, DB counts, p95 latency
//   GET  /health                    liveness
//   GET  /trending                  recency-aware trending (Milestone 5)
//
// Routes stay thin: parse input, delegate to a focused module, respond.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalize } from './suggest.js';
import { getStoredCount } from './search.js';
import { getSuggestionsCached, cacheDebug, ring } from './cache/cache.js';
import { metrics } from './metrics.js';
import { seedIfEmpty } from './seed.js';
import { getTrending, recordRecent } from './trending.js';
import { bufferSearch, pendingFor, startBatchWriter, stopAndDrain } from './batch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Serve the static frontend (one "app" service hosts UI + API).
const FRONTEND_DIR = process.env.FRONTEND_DIR || path.join(__dirname, '..', '..', 'frontend');
app.use(express.static(FRONTEND_DIR));

/**
 * GET /suggest?q=<prefix>&rank=<popular|trending>
 * Up to 10 prefix matches, cache-first. rank=popular (default) sorts by all-time
 * count; rank=trending re-ranks by recent activity (Milestone 5).
 */
app.get('/suggest', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const rank = typeof req.query.rank === 'string' ? req.query.rank : 'popular';
  const start = process.hrtime.bigint();
  const result = await getSuggestionsCached(q, rank);
  metrics.recordSuggestLatency(Number(process.hrtime.bigint() - start) / 1e6);
  res.json({ prefix: q, ...result });
});

/** GET /trending — top recency-weighted queries (sliding window). */
app.get('/trending', async (_req, res) => {
  res.json({ trending: await getTrending(10) });
});

/** POST /search {query} — record + update count, then invalidate affected cache. */
app.post('/search', (req, res) => {
  const raw = typeof req.body?.query === 'string' ? req.body.query : '';
  const query = normalize(raw);
  if (!query) return res.status(400).json({ error: 'query is required' });
  bufferSearch(query); // deferred + aggregated DB write (flushed by batch.js)
  recordRecent(query); // recency tracking is independent of the DB flush
  // show the increment immediately: committed (DB) + pending (buffer)
  res.json({ message: 'Searched', query, count: getStoredCount(query) + pendingFor(query) });
});

/** GET /cache/debug?prefix=<p> — routing + hit/miss (consistent-hashing proof). */
app.get('/cache/debug', async (req, res) => {
  const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : '';
  const rank = typeof req.query.rank === 'string' ? req.query.rank : 'popular';
  if (!normalize(prefix)) return res.status(400).json({ error: 'prefix is required' });
  res.json(await cacheDebug(prefix, rank));
});

/** GET /metrics — non-functional reporting (hit rate, DB counts, latency, ring). */
app.get('/metrics', (_req, res) => {
  res.json({ ...metrics.snapshot(), ringDistribution: ring.distribution() });
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
const rows = seedIfEmpty(); // self-seed on a fresh DB so the app always has data
startBatchWriter();         // begin the periodic flush loop

const server = app.listen(PORT, () => {
  console.log(
    `Typeahead API on http://localhost:${PORT} ` +
      `(db rows: ${rows}, cache nodes: ${ring.getPhysicalNodes().join(', ')})`
  );
});

// Graceful shutdown: drain the buffer so a normal restart loses no counts.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.log(`\n${sig} received — draining batch buffer before exit...`);
    try { await stopAndDrain(); } catch { /* best-effort */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
