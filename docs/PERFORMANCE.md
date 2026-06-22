# Performance Report

Measured on the local dev setup (Node 22, 3 Redis containers, **333,333-word real
dataset** — Google Web Trillion Word Corpus). Reproduce with `node scripts/bench.js`
and `node scripts/hashing_demo.js`.

## Methodology
- **Latency** measured both client-side (in `bench.js`) and server-side (inside the
  `/suggest` handler, exposed at `/metrics`) to separate API time from HTTP-client overhead.
- **Traffic** uses a **Zipf prefix mix** (a few hot prefixes dominate, like real search
  traffic) so the cache hit rate is realistic — not inflated (all-same) or deflated (uniform).
- **Cold vs warm** isolated by flushing Redis between the miss and hit measurement.
- Percentiles reported as p50 / p95 / p99 because tail latency is what users feel.

## 1. Suggestion latency

| Metric | Value |
|---|---|
| Server-side `/suggest` p50 | **2.2 ms** |
| Server-side `/suggest` p95 | **7.9 ms** |
| Server-side `/suggest` p99 | 38 ms |
| Throughput (5k req, concurrency 20) | ~**1,270 req/s** |

## 2. Cache effectiveness

| Metric | Value |
|---|---|
| Cache hit rate (Zipf load) | **~92–96%** |
| Cache MISS latency (SQLite path), p50 | 3.4 ms |
| Cache HIT latency (Redis path), p50 | 2.5 ms |
| Speedup (p50) | **1.4×** (prefix `ip`, small match set) |
| DB reads for 5,000+ suggest requests | **452** (~92% offloaded) |

> On a *local* SQLite the latency speedup is modest and prefix-dependent (SQLite is
> already fast, and `ip` matches few words). The dominant benefit is offloading
> **~92% of reads** from the primary store; the speedup is larger for hot,
> high-cardinality prefixes and would be far larger against a *networked* DB.

## 3. Consistent-hashing behavior (`hashing_demo.js`)

Distribution of 10,000 keys across 3 nodes (150 vnodes each): **~31% / 35% / 31%** — balanced.

Keys forced to move when removing one node (3 → 2):

| Strategy | Keys moved |
|---|---|
| **Consistent hashing** | **31.1%** (~ideal 1/3) |
| Naive `hash % N` | 66.6% |

## 4. Write reduction via batching (`/metrics`)

| Metric | Value |
|---|---|
| Searches submitted | 2,025 |
| Flush transactions | **3** |
| Rows written (aggregated) | 81 |
| **Row-write reduction** | **96%** |
| **Transaction reduction** | **99.9%** |

## Summary
Cache-first reads keep `/suggest` at single-digit-millisecond p95 while serving ~92% of
reads from Redis; consistent hashing keeps key movement minimal on membership change; and
batching cuts search-count writes by ~96%. All numbers are reproducible via the scripts above.
