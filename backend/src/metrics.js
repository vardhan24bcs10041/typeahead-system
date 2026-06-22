// metrics.js — in-process counters for the non-functional reporting:
// cache hit rate, DB reads, batch write-reduction, and /suggest p95 latency.

export const metrics = {
  cacheHits: 0,
  cacheMisses: 0,
  cacheErrors: 0, // Redis call failed (node down) -> we fell back to the DB
  dbReads: 0,

  // batch-write stats (Milestone 6)
  searchesBuffered: 0, // total search events accepted into the buffer
  flushes: 0,          // number of flush transactions
  rowsWritten: 0,      // total rows UPSERTed across all flushes
  lastFlush: null,

  suggestLatencies: [], // ms per /suggest request (bounded)

  cacheHit() { this.cacheHits++; },
  cacheMiss() { this.cacheMisses++; },
  cacheError() { this.cacheErrors++; },
  dbRead() { this.dbReads++; },
  searchBuffered() { this.searchesBuffered++; },
  recordFlush(rows, reason) {
    this.flushes++;
    this.rowsWritten += rows;
    this.lastFlush = { rows, reason };
  },

  recordSuggestLatency(ms) {
    this.suggestLatencies.push(ms);
    if (this.suggestLatencies.length > 10000) this.suggestLatencies.shift();
  },
  percentile(p) {
    if (this.suggestLatencies.length === 0) return 0;
    const sorted = [...this.suggestLatencies].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)));
    return +sorted[idx].toFixed(3);
  },

  snapshot() {
    const lookups = this.cacheHits + this.cacheMisses;
    return {
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      cacheErrors: this.cacheErrors,
      cacheHitRate: lookups ? +(this.cacheHits / lookups).toFixed(4) : 0,
      dbReads: this.dbReads,
      // batch write-reduction: how many fewer row-writes than raw searches
      searchesBuffered: this.searchesBuffered,
      flushes: this.flushes,
      rowsWritten: this.rowsWritten,
      writeReductionPct: this.searchesBuffered
        ? +(100 * (1 - this.rowsWritten / this.searchesBuffered)).toFixed(1)
        : 0,
      lastFlush: this.lastFlush,
      // latency
      suggestSamples: this.suggestLatencies.length,
      p50LatencyMs: this.percentile(50),
      p95LatencyMs: this.percentile(95),
      p99LatencyMs: this.percentile(99),
    };
  },
};
