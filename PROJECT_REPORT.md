# Project Report — Search Typeahead System

A walkthrough of the system: what it does, how it is structured, the data model,
the APIs, and notes on design trade-offs and known limitations.

---

## 1. Overview

A **search typeahead / autocomplete system** (like Google/Amazon search suggestions),
built as the SST-2028 **HLD101** graded assignment. As the user types (≥2 chars), it
returns the top-10 prefix-matching queries ranked by popularity — and optionally by
**recency**. Submitting a search records it and updates popularity. The emphasis is on
the **backend data-system design**: how query→count data is stored, served with low
latency via a **distributed cache routed by consistent hashing**, ranked with a
recency-aware **trending** signal, and updated through **batched write-behind**.

It is a single-machine, demo-grade but production-shaped implementation: cache-aside
reads, eventual-consistency writes, graceful degradation when the cache is down, and a
metrics endpoint for latency / hit-rate / write-reduction reporting.

---

## 2. Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Runtime | Node.js | 22 (`node:22-bookworm-slim`; local v22.21.0), ES modules (`"type":"module"`) |
| Web framework | Express | ^4.21.2 |
| Primary store | SQLite via **better-sqlite3** (synchronous) | ^11.8.0 |
| Cache | Redis (3 nodes) via **ioredis** | client ^5.11.1; server `redis:7-alpine` |
| Frontend | Plain HTML/CSS/JS (no framework, no build step); Plus Jakarta Sans font | — |
| Orchestration | Docker + Docker Compose | engine 29.x, compose v5.x |

No build tooling, transpiler, or test framework. Backend is pure ESM JavaScript.

---

## 3. Architecture

```
Browser (HTML/CSS/JS)
  │  GET /suggest, POST /search, GET /trending, /cache/debug, /metrics
  ▼
Express "app" (one service: serves API + static UI)
  ├─ suggest.js  ── prefix range-scan on SQLite (candidate generation)
  ├─ cache/      ── cache-aside; consistent-hashing ring routes prefix keys
  │     ├─ ring.js          (consistent-hash ring, 150 vnodes/node)
  │     ├─ ringInstance.js  (single shared ring; breaks a cache↔trending cycle)
  │     ├─ redisClients.js  (one ioredis client per node, fail-fast)
  │     └─ cache.js         (getSuggestionsCached / invalidate / cacheDebug)
  ├─ trending.js ── sliding-window recency (per-bucket Redis sorted sets)
  ├─ batch.js    ── in-memory buffer + periodic/size flush (write-behind)
  ├─ search.js   ── read committed count
  ├─ seed.js     ── self-seed synthetic data if DB empty
  ├─ db.js       ── SQLite connection (WAL) + schema
  └─ metrics.js  ── counters (hit rate, DB reads, write reduction, p95)
        │
        ├── SQLite (primary store, on a Docker volume)
        └── Redis ×3 (distributed cache + trending keyspace)
```

**Design principles in the code:** thin routes that delegate to focused single-purpose
modules; cache-aside with TTL + invalidation; consistent hashing implemented in-house
(not Redis Cluster) so routing is inspectable; write-behind batching to cut DB writes;
graceful degradation (every Redis call is wrapped — a node outage falls back to SQLite).

**Module organization:** `backend/src/` holds runtime modules; `backend/src/cache/` the
cache subsystem; `backend/scripts/` holds dataset/ingest/demo/benchmark tools (not part
of the serving path); `frontend/` the static UI; `docs/` the written deliverables.

---

## 4. Entry Points & Data Flow

**Entry point:** `backend/src/server.js` (`npm start` → `node src/server.js`). On boot it:
`seedIfEmpty()` (populate SQLite if empty) → `startBatchWriter()` (begin the flush loop)
→ `app.listen(PORT)` → registers SIGTERM/SIGINT handlers that drain the buffer.

**Read path (`GET /suggest?q=ip`):**
1. Normalize prefix (trim + lowercase).
2. `ring.getNode("suggest:ip:popular")` → one Redis node.
3. **Hit** → return cached JSON. **Miss** → SQLite range-scan
   (`query >= 'ip' AND query < 'iq' ORDER BY count DESC LIMIT 10`) → `SET … EX ttl` →
   return. (`rank=trending` re-ranks the top-50 candidates by recency before caching.)
4. Latency recorded to `metrics`.

**Write path (`POST /search`):**
1. Normalize; reject empty (400).
2. `bufferSearch(query)` increments an in-memory `Map<query,count>` (no DB write).
3. `recordRecent(query)` increments the current trending time-bucket (Redis).
4. Respond immediately with committed (DB) + pending (buffer) count.
5. Asynchronously, the batch flusher writes an aggregated `UPSERT` transaction every
   `BATCH_INTERVAL_MS` or `BATCH_MAX_SIZE` distinct queries, then invalidates the
   affected popular-cache prefixes.

---

## 5. Key Files

| File | Responsibility |
|---|---|
| `backend/src/server.js` | Express app, all routes, startup/seed/shutdown wiring |
| `backend/src/db.js` | SQLite connection (WAL, `synchronous=NORMAL`), `queries` schema |
| `backend/src/suggest.js` | `normalize`, `prefixUpperBound`, `getSuggestions` (top-10), `getTopByPrefix` (top-N candidates) |
| `backend/src/cache/ring.js` | `ConsistentHashRing` — md5 hashing, 150 vnodes, clockwise `getNode`, `distribution()` demo |
| `backend/src/cache/ringInstance.js` | Single shared ring instance (avoids cache↔trending import cycle) |
| `backend/src/cache/redisClients.js` | One ioredis client per node from `REDIS_NODES`; fail-fast so callers can fall back |
| `backend/src/cache/cache.js` | Cache-aside read (`popular`/`trending` modes), `invalidatePrefixesOf`, `cacheDebug` |
| `backend/src/trending.js` | Sliding-window buckets, `recordRecent`, `getTrending`, `getRecentScores` |
| `backend/src/batch.js` | Write-behind buffer, dual-trigger `flush`, `startBatchWriter`, `stopAndDrain` |
| `backend/src/search.js` | `getStoredCount` (committed count read) |
| `backend/src/metrics.js` | Counters + percentile/snapshot for `/metrics` |
| `backend/src/seed.js` | `seedIfEmpty` — synthetic seed on a fresh DB |
| `backend/scripts/*` | `ingest`, `generate_synthetic`, `fetch_wordfreq`, `fetch_wikipedia`, `hashing_demo`, `bench` |
| `frontend/{index.html,styles.css,app.js}` | UI: debounced search, dropdown, trending, liquid-glass theme |
| `docker-compose.yml`, `backend/Dockerfile`, `.dockerignore` | Containerization (app + redis-0/1/2) |

---

## 6. APIs / Interfaces

### HTTP endpoints (all served by `server.js`)
| Method | Route | Behavior |
|---|---|---|
| GET | `/suggest?q=<prefix>&rank=<popular\|trending>` | ≤10 prefix matches; `{prefix, suggestions[], cached, node, rank}` |
| POST | `/search` `{query}` | Buffers the search; `{message:"Searched", query, count}`; 400 if empty |
| GET | `/cache/debug?prefix=<p>&rank=<…>` | `{prefix, rank, key, keyHash, ownerNode, status, allNodes}` |
| GET | `/trending` | `{trending:[{query, score}]}` (sliding window) |
| GET | `/metrics` | hit rate, DB reads, batch write-reduction, p50/p95/p99, ring distribution |
| GET | `/health` | `{status:"ok"}` |

### Key exported functions
- `suggest.js`: `normalize`, `prefixUpperBound`, `getSuggestions`, `getTopByPrefix`
- `cache.js`: `getSuggestionsCached(prefix, rank)`, `invalidatePrefixesOf(query)`, `cacheDebug(prefix, rank)`, `ring`
- `ring.js`: `ConsistentHashRing` (`addNode`, `removeNode`, `getNode`, `hash`, `getPhysicalNodes`, `distribution`)
- `trending.js`: `recordRecent`, `getTrending`, `getRecentScores`
- `batch.js`: `bufferSearch`, `pendingFor`, `flush`, `startBatchWriter`, `stopAndDrain`
- `metrics.js`: `metrics` (counters + `snapshot`, `percentile`)

---

## 7. Database / Data Models

**SQLite — single table** (`db.js`):
```sql
CREATE TABLE IF NOT EXISTS queries (
  query            TEXT PRIMARY KEY,   -- normalized (trim+lowercase); PK => B-tree index
  count            INTEGER NOT NULL,   -- all-time popularity
  last_searched_at INTEGER NOT NULL DEFAULT 0  -- unix ms (reserved/secondary recency signal)
);
```
- The `query` primary key provides the B-tree index that turns prefix lookup into a
  range scan, and enables `INSERT … ON CONFLICT(query) DO UPDATE SET count = count + …`.
- No relationships (single table). WAL journaling enabled.

**Redis (cache, ephemeral)** — not a persistent model:
- `suggest:<prefix>:popular` / `suggest:<prefix>:trending` → JSON top-10 (TTL'd).
- `trend:bucket:<id>` → sorted set (member=query, score=count) per time bucket (TTL'd).
- `trend:merged:<bucket>` → transient window union for trending.
- Redis runs cache-only (`--save "" --appendonly no`).

---

## 8. Configuration & Environment

All via env (defaults in `.env.example` / `docker-compose.yml`):

| Var | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | server port |
| `FRONTEND_DIR` | `../frontend` (local) / `/frontend` (Docker) | static UI dir |
| `DB_PATH` | `backend/data/typeahead.db` / `/data/typeahead.db` | SQLite file (Docker volume) |
| `DATASET_PATH` | `backend/data/queries.tsv` | TSV to ingest; else synthetic |
| `REDIS_NODES` | `localhost:6379,6380,6381` / `redis-0/1/2:6379` | cache nodes for the ring |
| `CACHE_TTL_SECONDS` | 60 | popular-suggestion cache TTL |
| `CACHE_TTL_TRENDING_SECONDS` | 10 | trending cache TTL (shorter) |
| `RECENCY_ALPHA` | 0.5 | recency vs popularity blend weight |
| `TREND_BUCKET_MS` / `TREND_WINDOW_BUCKETS` | 30000 / 10 | sliding-window granularity/size |
| `BATCH_INTERVAL_MS` / `BATCH_MAX_SIZE` | 2000 / 500 | flush triggers |

**Build/deploy:** `docker compose up --build` runs `app` + `redis-0/1/2` (all
`restart: unless-stopped`). The image build context is the repo root; `.dockerignore`
excludes `node_modules` (critical — host-built `better-sqlite3` binaries are
OS-specific) so `npm ci` rebuilds them for Linux. The frontend is bind-mounted for live
edits. The DB persists on the `dbdata` named volume; the app self-seeds if empty.

---

## 9. Code Quality Observations

**Strengths**
- Clean module boundaries; thin routes; every file is heavily commented with rationale.
- Resilience: all Redis calls are wrapped → cache outage degrades to SQLite, not failure.
- Security basics are right: **parameterized SQL** (prepared statements, no injection)
  and **HTML-escaped** suggestion output in the frontend (`escapeHtml`) → no obvious XSS.
- The `ring.js` ring is pure and self-contained (easily unit-testable).
- Good async hygiene in the read path; prepared statements reused on the hot path.

**Potential bugs / edge cases**
- `prefixUpperBound` uses `String.fromCharCode(lastCode + 1)` on a UTF-16 code unit;
  prefixes ending in `￿` or a surrogate could compute an off range. Fine for
  lowercase ASCII/words; an edge case for exotic Unicode.
- Env values parsed with `parseInt`/`parseFloat` without validation; a malformed env
  (e.g. `CACHE_TTL_SECONDS=abc`) yields `NaN` and would only fail at the Redis call
  (caught) — worth guarding.
- `batch.flush` skips a run if a previous flush is still awaiting invalidation
  (`flushing` guard); the buffer can briefly exceed `BATCH_MAX_SIZE`. Self-corrects next
  tick; not harmful at demo scale.

**Performance / tech debt**
- `/metrics` calls `ring.distribution()` which does 10,000 md5 hashes per request — fine
  for an infrequently-hit endpoint, but it could be memoized.
- `invalidatePrefixesOf` is called per flushed query without de-duplicating shared
  prefixes across the batch → redundant Redis `DEL`s on large flushes. Could collect a
  prefix `Set` first.
- `better-sqlite3` is synchronous → queries block the event loop. Indexed reads are
  sub-ms (mitigated by cache), but a large bulk ingest (~1.5s for 333k rows) blocks the
  loop; acceptable as an admin/startup op.
- **No automated tests** — the `scripts/` are demos/benchmarks, not unit tests. The pure
  `ring.js` and `prefixUpperBound` are obvious candidates for unit coverage.

**Security / operational notes (acceptable for a local demo, would harden in prod)**
- No authentication or rate limiting on `/search` / `/suggest` (abuse/DoS surface).
- `/metrics` and `/cache/debug` expose internal topology/stats (info disclosure) — would
  be gated behind auth/network policy in production.
- No request-size/length cap on the `/search` query string.
- **Known, deliberate deviation:** SQLite is embedded, not a "separate database service"
  as the assignment text suggests; documented in `docs/DESIGN_CHOICES.md` (the distribution
  concern is intentionally placed in the cache tier).
- Trending is pinned to a single Redis node (ZUNIONSTORE can't span instances); if that
  node is down, trending is empty (graceful) — a single point for that one feature.

---

## 10. Setup / Run Instructions

**Docker (recommended):**
```bash
docker compose up --build      # starts app + redis-0/1/2; self-seeds 150k synthetic rows
# open http://localhost:3000
```

**Local (without Docker for the app):**
```bash
docker compose up -d redis-0 redis-1 redis-2   # (or three local redis-servers on 6379/6380/6381)
cd backend
npm install
npm run ingest                 # load dataset into SQLite (synthetic if no queries.tsv)
npm start                      # http://localhost:3000
```

**Load a real dataset (broad coverage):**
```bash
cd backend
node scripts/fetch_wordfreq.js  # Google Web Trillion Word Corpus, 333k words -> data/queries.tsv
npm run ingest
# For the running container: docker cp the TSV in, exec `node scripts/ingest.js`, then
# flush the three Redis nodes (see README "Loading a dataset into the Docker container").
```

**Verify / demo:**
```bash
node scripts/hashing_demo.js    # consistent-hashing key-movement vs mod-N
node scripts/bench.js           # latency + cache hit rate + speedup
curl "http://localhost:3000/suggest?q=foo"
curl "http://localhost:3000/metrics"
```
