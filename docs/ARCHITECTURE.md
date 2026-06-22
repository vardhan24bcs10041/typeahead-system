# Architecture

## Diagram

```
                            ┌──────────────────────────────────────────────┐
                            │            BROWSER  (plain HTML/CSS/JS)        │
                            │  search box · debounced, fires at >=2 chars    │
                            │  suggestion dropdown (kbd nav) · trending panel │
                            └───────────────────────┬────────────────────────┘
                                                    │ HTTP / JSON
                                                    ▼
   ┌───────────────────────────────────────────────────────────────────────────────┐
   │                        APP  (Express, Node.js)  — one service                    │
   │                                                                                  │
   │  GET /suggest   POST /search   GET /cache/debug   GET /trending   GET /metrics   │
   │                                                                                  │
   │   ┌───────────────┐   ┌──────────────────┐   ┌───────────────┐  ┌────────────┐  │
   │   │ Consistent-   │   │ Recency scorer   │   │ Batch-write   │  │  Metrics   │  │
   │   │ hash ring     │   │ sliding window + │   │ buffer +      │  │  hit rate, │  │
   │   │ (150 vnodes)  │   │ (1-α)pop+α·recent│   │ periodic/size │  │  p95, DB   │  │
   │   └──┬───┬───┬────┘   └────────┬─────────┘   │ flush         │  │  counts    │  │
   └──────┼───┼───┼─────────────────┼─────────────┴──────┬────────┴──┴────────────┘
          │   │   │                 │ ZUNIONSTORE        │ aggregated UPSERT (batched)
   GET/SET│   │   │SET/GET          │ (one node)         ▼
          ▼   ▼   ▼                 ▼            ┌──────────────────────────────┐
   ┌────────┐┌────────┐┌────────┐ (trending      │        SQLite (WAL)          │
   │redis-0 ││redis-1 ││redis-2 │  pinned to     │  queries(query PK, count,    │
   │ cache  ││ cache  ││ cache  │  one node)     │   last_searched_at)          │
   └────────┘└────────┘└────────┘                │  B-tree prefix index         │
        distributed suggestion cache             └──────────────────────────────┘
        (TTL + invalidation)                       primary system-of-record
```

## Components

### Frontend (`frontend/`)
Plain HTML/CSS/JS served as static files by the app. Debounces input (200ms),
only calls the backend at **≥2 characters**, cancels stale in-flight requests
(`AbortController` + request-id race guard), and supports keyboard navigation.

### App / API (`backend/src/server.js`)
Thin Express routes that delegate to focused modules. Hosts both the API and the
static UI (one "app" service).

### Suggestion read path (`suggest.js` + `cache/cache.js`)
1. Normalize prefix (trim + lowercase).
2. Consistent-hash `suggest:<prefix>:<rank>` → owning Redis node.
3. **Cache hit** → return JSON. **Miss** → SQLite **range-scan**
   (`query >= prefix AND query < prefix⁺`, top-10 by count) → cache with TTL → return.

### Primary store — SQLite (`db.js`)
Embedded SQL store in **WAL mode** (readers don't block the single writer).
`query` is the TEXT primary key → an automatic B-tree index that makes prefix
search a fast range-scan and gives clean UPSERT semantics.

### Distributed cache — Redis ×3 + consistent hashing (`cache/ring.js`, `redisClients.js`)
Three **independent** Redis nodes (not Redis Cluster). A self-written
**consistent-hashing ring** with **150 virtual nodes per physical node** maps each
prefix key to one node. Adding/removing a node moves only ~1/N of keys (vs ~all
for `hash % N`). Entries expire by **TTL**; they're **invalidated** when the
relevant counts change.

### Trending (`trending.js`)
Recent searches are counted in **per-bucket sorted sets** (`trend:bucket:<id>`)
with TTLs, so old activity ages out of the window. `/trending` and the recency
re-ranker union the last *W* buckets (newer weighted higher). All trending keys
are pinned to one node (ZUNIONSTORE can't span instances), chosen by the ring.

### Batch writes (`batch.js`)
`/search` increments an in-memory `Map<query,count>` buffer. A flusher writes one
**aggregated transaction** every `BATCH_INTERVAL_MS` or every `BATCH_MAX_SIZE`
distinct queries, then invalidates affected cache prefixes. A graceful-shutdown
handler drains the buffer.

## Request flows

**`GET /suggest`** → ring → Redis (hit ⇒ return) / miss ⇒ SQLite range-scan → cache → return.

**`POST /search`** → buffer++ → record recency → return `{message:"Searched"}` immediately;
later → batch flush → SQLite UPSERT → cache invalidation.

## Data model

```sql
CREATE TABLE queries (
  query            TEXT PRIMARY KEY,   -- normalized; PK => B-tree prefix index
  count            INTEGER NOT NULL,   -- all-time popularity
  last_searched_at INTEGER NOT NULL DEFAULT 0
);
```

Cache keys: `suggest:<prefix>:popular` / `suggest:<prefix>:trending` (TTL'd);
trending: `trend:bucket:<id>` (sorted sets, TTL'd).
