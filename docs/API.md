# API Reference

Base URL: `http://localhost:3000`

---

## GET /suggest

Up to 10 prefix-matching suggestions, sorted by count (or recency).

**Query params**
| param | required | default | notes |
|---|---|---|---|
| `q` | yes | — | the prefix; trimmed + lowercased. Empty/missing → `[]`. |
| `rank` | no | `popular` | `popular` = all-time count; `trending` = recency-aware. |

**Example**
```bash
curl 'http://localhost:3000/suggest?q=ip'
```
```json
{
  "prefix": "ip",
  "rank": "popular",
  "cached": false,
  "node": "redis-2:6379",
  "suggestions": [
    { "query": "iphone", "count": 510647 },
    { "query": "iphone pro", "count": 415316 }
  ]
}
```
- `cached` — served from Redis (`true`) or computed from SQLite (`false`).
- `node` — which cache node owns this prefix.
- `trending` mode adds `recent` and `score` fields per suggestion.

Edge cases: empty/missing `q` → `{ "suggestions": [] }`; mixed case handled
(normalized); no matches → empty array. All return HTTP 200.

---

## POST /search

Record a submitted search. The write is **buffered** and flushed in an aggregated
batch (not written synchronously).

**Body** `application/json`
```json
{ "query": "iphone 15" }
```

**Response**
```json
{ "message": "Searched", "query": "iphone 15", "count": 42 }
```
- `count` = committed (DB) + pending (buffer), so it reflects the increment
  immediately even though the DB write is deferred.
- Empty/missing `query` → HTTP 400 `{ "error": "query is required" }`.

The count becomes durable on the next flush (`BATCH_INTERVAL_MS` / `BATCH_MAX_SIZE`),
after which it appears in `/suggest` and may appear in `/trending`.

---

## GET /cache/debug

Show consistent-hashing routing + current hit/miss for a prefix.

**Query params:** `prefix` (required), `rank` (optional, default `popular`).

```bash
curl 'http://localhost:3000/cache/debug?prefix=ip'
```
```json
{
  "prefix": "ip",
  "rank": "popular",
  "key": "suggest:ip:popular",
  "keyHash": 3555701832,
  "ownerNode": "redis-2:6379",
  "status": "hit",
  "allNodes": ["redis-0:6379", "redis-1:6379", "redis-2:6379"]
}
```
`status` is `hit`, `miss`, or `node-unreachable` (node down → app falls back to DB).

---

## GET /trending

Top recency-weighted queries from the sliding window.

```json
{ "trending": [ { "query": "iphone 15", "score": 87.5 }, ... ] }
```

---

## GET /metrics

Operational metrics for the performance report.

```json
{
  "cacheHits": 4583, "cacheMisses": 417, "cacheErrors": 0, "cacheHitRate": 0.9166,
  "dbReads": 417,
  "searchesBuffered": 2025, "flushes": 3, "rowsWritten": 81, "writeReductionPct": 96,
  "lastFlush": { "rows": 40, "reason": "interval" },
  "suggestSamples": 5000, "p50LatencyMs": 3.3, "p95LatencyMs": 7.3, "p99LatencyMs": 26.3,
  "ringDistribution": { "redis-0:6379": 3336, "redis-1:6379": 3483, "redis-2:6379": 3181 }
}
```

---

## GET /health

```json
{ "status": "ok" }
```
