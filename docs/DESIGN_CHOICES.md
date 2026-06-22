# Design Choices & Trade-offs

Every major decision, the alternatives considered, and why we chose what we did.

---

## 1. SQLite as the primary store
**Choice:** embedded SQLite in WAL mode.
**Alternatives:** PostgreSQL/MySQL (networked SQL), MongoDB (NoSQL), Redis-only.
**Why:** simplest "easy to run locally" store; SQL gives a B-tree index that makes
prefix search a range-scan; WAL lets readers proceed during the single writer.
**Trade-off / known deviation:** the assignment says "database as a separate
service," but SQLite is embedded, not a separate container. We accept this
deliberately: the *distribution* concern lives in the cache tier (3 Redis nodes +
consistent hashing); SQLite is a single-node system-of-record on a Docker volume.
Swapping to a networked/sharded SQL DB later is a small change — schema and access
patterns are identical. SQLite's single-writer lock also *strengthens* the case for
batch writes.

## 2. Prefix search = index range-scan
**Choice:** `WHERE query >= :prefix AND query < :prefix⁺ ORDER BY count DESC LIMIT 10`.
**Alternatives:** in-memory **trie** with top-K per node; Redis `ZRANGEBYLEX`;
SQLite FTS5 full-text.
**Why:** uses the existing PK index, keeps store/cache cleanly separated, trivially
explainable. A trie is the "textbook" answer but is in-memory and reinvents the index.
**Trade-off:** the `ORDER BY count` must sort all prefix matches; short/hot prefixes
match many rows → bigger sort. This is exactly what the cache absorbs, and why the
≥2-char rule (fewer matches) helps.

## 3. Cache-aside over 3 Redis nodes
**Choice:** look-aside cache; app checks Redis, loads SQLite on miss, populates Redis.
**Alternatives:** read-through, write-through, write-behind caching.
**Why:** simplest pattern with an explicit store/cache boundary; standard for read-heavy
suggestion workloads.
**Trade-off:** the app owns cache population and invalidation logic (more app code) vs.
a library doing it implicitly.

## 4. Consistent hashing (self-written ring), not Redis Cluster
**Choice:** our own ring with 150 virtual nodes per physical node.
**Alternatives:** `hash(key) % N`; Redis Cluster (CRC16 hash slots).
**Why:** the assignment requires us to *own and expose* the routing (`/cache/debug`);
Redis Cluster hides it. `mod N` reshuffles ~all keys when membership changes.
**Trade-off:** virtual nodes cost a little memory (ring entries) for even load and
minimal key movement. Measured: removing 1 of 3 nodes moves **31%** of keys (ring) vs
**67%** (`mod N`).

## 5. TTL + targeted invalidation
**Choice:** every cache entry has a TTL; on a count change we also delete the affected
prefixes.
**Alternatives:** pure TTL (simple, staleness window); pure invalidation (fresh, more ops).
**Why:** blend = bounded worst-case staleness (TTL) + near-immediate correctness for
changed data (invalidation). Maps to eviction (TTL) and invalidation from Session 3/4.
**Trade-off:** invalidation adds cache deletes; we moved popular-cache invalidation to
**flush time** so it isn't paid per search.

## 6. Recency: sliding-window buckets + normalized blend
**Choice:** per-bucket sorted sets with TTLs; rank = `(1−α)·norm(pop) + α·norm(recency)`.
**Alternatives:** exponential decay (increasing-weight trick); pure recency.
**Why:** buckets are intuitive and **can't permanently over-rank** a spike (it ages out
of the window); decay never reaches zero and the increasing-weight trick overflows over
long runtimes. Normalized blend with a tunable `α` is easy to explain and tune.
**Trade-off:** `ZUNIONSTORE` over W buckets per recompute (bounded; cache absorbs it);
candidate-generation re-ranks only the top-50 popular matches, so a truly obscure query
must first be a candidate to surface (a documented limitation).

## 7. Batch (write-behind) search counts
**Choice:** in-memory buffer, aggregated, flushed by time **or** size.
**Alternatives:** synchronous write-through per search (what M3 did).
**Why:** avoids a transaction + fsync + writer-lock per search; aggregation collapses
repeated queries (e.g. 1000× "java" → one `+1000`). Measured **96%** fewer row-writes,
**99.9%** fewer transactions.
**Trade-off (failure mode):** a search is acked before it's durable. A hard crash loses
up to one flush window of buffered counts. Mitigations: graceful-shutdown drain
(implemented) for normal restarts; the production fix is a **durable log** (WAL / Redis
list / Kafka) so the buffer survives a crash and replays — durability vs latency/complexity.
This makes counts **eventually consistent** (Session 4).

## 8. Frontend: debounce + 2-char trigger + race guard
**Choice:** 200ms debounce, no call under 2 chars, `AbortController` + request-id guard.
**Alternatives:** throttle; call on every keystroke.
**Why:** debounce ("wait for a pause") fits search-as-you-type; the 2-char gate cuts
load and avoids the most expensive (largest) queries; the race guard stops a slow earlier
response from overwriting a newer one.
**Trade-off:** debounce adds up to 200ms perceived latency before suggestions appear —
a deliberate latency-vs-load balance.

## Consistency summary
- **Reads:** cache-aside; staleness bounded by TTL, corrected by invalidation → eventual.
- **Writes:** batched → counts eventually consistent (bounded by flush interval).
- **Trending:** windowed; intentionally approximate and time-bounded.
