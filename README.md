# Search Typeahead System

A search-as-you-type suggestion system (like Google/Amazon search) built for the
SST-2028 **HLD101** assignment. It serves prefix suggestions ranked by popularity
**and** recency, backed by a **distributed Redis cache routed with consistent
hashing**, a SQLite primary store, and **batched write-behind** for search counts.

> **Stack:** Express (Node.js) · SQLite (WAL) · Redis ×3 (consistent hashing) ·
> plain HTML/CSS/JS frontend · Docker Compose.

---

## Quick start (Docker — recommended)

```bash
docker compose up --build
```

Then open **http://localhost:3000**. That's it — the app self-seeds a 150k-row
synthetic dataset on first boot, so it works with no internet.

Services started: `app` (API + UI) and `redis-0` / `redis-1` / `redis-2`
(three independent cache nodes).

## Quick start (local, without Docker)

```bash
# 1) three Redis nodes (via Docker, or three local redis-servers on 6379/6380/6381)
docker compose up -d redis-0 redis-1 redis-2

# 2) backend
cd backend
npm install
npm run ingest        # load dataset into SQLite (synthetic if no dataset file)
npm start             # http://localhost:3000
```

---

## Dataset

The system loads any `query<TAB>count` TSV (`DATASET_PATH`). Three sources are supported:

- **Default — word frequency (broadest, recommended):** 333,333 English words with
  real frequency counts — the **Google Web Trillion Word Corpus** unigram list
  (Peter Norvig, <https://norvig.com/ngrams/>). Any common word returns suggestions.
  ```bash
  cd backend
  node scripts/fetch_wordfreq.js   # -> backend/data/queries.tsv (333,333 words)
  npm run ingest                   # load into SQLite
  ```
- **Wikipedia titles + views (multi-word, topic-rich):**
  ```bash
  node scripts/fetch_wikipedia.js 2024 01 15 12 200000   # YYYY MM DD HH topN
  npm run ingest
  ```
- **Synthetic offline fallback:** if no `queries.tsv` exists, ingestion auto-generates
  **150,000** reproducible Zipf-distributed rows (`scripts/generate_synthetic.js`), so
  the app always runs with no internet.

### Loading a dataset into the Docker container
The container has its own volume DB. To (re)load real data into the running stack:
```bash
node backend/scripts/fetch_wordfreq.js
docker cp backend/data/queries.tsv kshitij-app-1:/tmp/queries.tsv
docker compose exec -e DATASET_PATH=/tmp/queries.tsv app node scripts/ingest.js
docker exec kshitij-redis-0-1 redis-cli flushall   # repeat for redis-1, redis-2
```
Canonical format: `"<query>\t<count>"` per line.

---

## API (summary)

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/suggest?q=<prefix>&rank=<popular\|trending>` | Up to 10 prefix matches, sorted by count (or recency) |
| POST | `/search` `{ "query": "..." }` | Record a search (buffered); returns `{ "message": "Searched" }` |
| GET | `/cache/debug?prefix=<p>` | Which cache node owns the prefix + hit/miss |
| GET | `/trending` | Top recency-weighted queries (sliding window) |
| GET | `/metrics` | Cache hit rate, DB counts, batch write-reduction, p95 latency |
| GET | `/health` | Liveness |

Full details: [docs/API.md](docs/API.md).

---

## How it works (1-minute tour)

- **Suggestions** are a prefix **range-scan** on SQLite's `query` index
  (`WHERE query >= 'ip' AND query < 'iq'`), top-10 by count — served **cache-first**.
- **The cache** is 3 Redis nodes; a **consistent-hashing ring** (150 virtual nodes
  each) decides which node owns each prefix key. Entries have a **TTL** and are
  **invalidated** when counts change.
- **Trending** tracks recent searches in a **sliding window** of time buckets and
  blends recency with all-time popularity (`score = (1−α)·pop + α·recency`).
- **Search writes** are **buffered and flushed in aggregated batches** (96% fewer
  row-writes), not written synchronously per request.

Architecture diagram + reasoning: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Useful scripts (`backend/`)

| Command | What it does |
|---|---|
| `npm start` | Run the API + UI server |
| `npm run ingest` | (Re)load the dataset into SQLite |
| `npm run generate` | Write a synthetic `queries.tsv` |
| `node scripts/hashing_demo.js` | Show consistent-hashing key-movement vs `mod-N` |
| `node scripts/bench.js` | Benchmark latency + cache hit rate + speedup |

---

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — diagram + component design
- [docs/API.md](docs/API.md) — full API reference
- [docs/DESIGN_CHOICES.md](docs/DESIGN_CHOICES.md) — decisions & trade-offs
- [docs/PERFORMANCE.md](docs/PERFORMANCE.md) — measured latency / hit rate / write reduction
- [docs/VIVA_PREP.md](docs/VIVA_PREP.md) — viva question bank with answers
- [docs/REQUIREMENTS_CHECKLIST.md](docs/REQUIREMENTS_CHECKLIST.md) — every requirement, verified

---

## Troubleshooting

- **`invalid ELF header` in Docker** — stale host `node_modules` leaked into the
  image. The `.dockerignore` prevents this; rebuild with `docker compose build --no-cache app`.
- **Cache shows `node-unreachable`** — a Redis node is down; the app still works
  (it falls back to SQLite). Bring nodes up with `docker compose up -d redis-0 redis-1 redis-2`.
- **Port 3000 in use** — stop other instances or set `PORT`.
