# Viva Preparation — Question Bank

Answers you should be able to give in your own words. Tied to the syllabus.

---

## Data modeling & suggestions

**Q: How is query-count data stored?**
One SQLite table `queries(query PRIMARY KEY, count, last_searched_at)`. `query` as
TEXT PK gives an automatic B-tree index and clean UPSERT semantics.

**Q: How do you serve prefix suggestions fast?**
A prefix is a **range** on the sorted index: every string starting with `ip` lies in
`["ip", "iq")`. So `WHERE query >= 'ip' AND query < 'iq' ORDER BY count DESC LIMIT 10`
is an index range-scan (O(log n) seek + walk), not a full scan. Then it's cached.

**Q: Why is a 1-character prefix slow?**
It matches far more rows, so the `ORDER BY count` sort is bigger. That's both why the
cache matters and why the UI only queries at ≥2 characters.

**Q: Alternatives to the SQL range-scan?**
A trie with top-K completions per node (in-memory, the textbook answer), Redis
`ZRANGEBYLEX`, or FTS5. We used the index range-scan to keep store/cache separate and
avoid reinventing the index.

## Caching & consistent hashing (Session 2 & 3)

**Q: Why consistent hashing instead of `hash(key) % N`?**
With `mod N`, changing N remaps ~(N−1)/N of all keys → near-total cache flush + DB
stampede. Consistent hashing places nodes and keys on a ring; a key is owned by the
next node clockwise, so adding/removing a node moves only ~1/N of keys. **Measured:
removing 1 of 3 nodes moved 31% of keys (ring) vs 67% (`mod N`).**

**Q: What are virtual nodes?**
Each physical node is placed at many points (150) on the ring. With few physical nodes,
few points = lumpy load; many virtual points smooth the distribution and rebalancing.
Cost: a little memory. **Measured distribution: ~31–35% per node.**

**Q: Why 3 separate Redis containers and not Redis Cluster?**
So the consistent-hashing routing is *our* code and is inspectable via `/cache/debug`.
Redis Cluster hides routing behind CRC16 hash slots.

**Q: How does the cache stay correct? (eviction vs invalidation)**
TTL expiry (time-based eviction) bounds staleness; targeted **invalidation** deletes the
affected prefixes when counts change (at flush time). Blend of eventual + near-immediate.

**Q: What if a cache node dies?**
Every Redis call is best-effort; on failure we fall back to SQLite (graceful degradation).
`/cache/debug` reports `node-unreachable`.

## Trending / recency (Session 4)

**Q: How are recent searches tracked?**
Per-bucket Redis sorted sets (`trend:bucket:<id>`), one bucket per time slice, each with
a TTL so old buckets age out.

**Q: How does recency affect ranking?**
`/suggest?rank=trending` re-ranks the top-50 popular candidates by
`score = (1−α)·norm(count) + α·norm(recency)`. α tunes recency weight.

**Q: How do you avoid permanently over-ranking a short spike?**
The window is fixed: a query's recent contribution comes only from the last W buckets,
which expire. After the window passes, its boost is gone — demonstrated live (a query
jumped to #1 in trending, then decayed back to #8 after the window).

**Q: Why not exponential decay?**
It's a valid alternative, but the common increasing-weight implementation overflows
floats over long runtimes and the window semantics are fuzzier. Buckets are robust.

**Q: How is the cache handled when rankings change?**
Separate keys per mode (`:popular` / `:trending`); trending uses a short TTL because it
changes fast; both variants are invalidated for affected prefixes on flush.

## Batch writes (Session 5 / Kafka)

**Q: Why batch writes?**
To avoid a synchronous transaction (fsync + single-writer lock) per search. Searches are
buffered, repeated queries aggregated, and flushed together.

**Q: Show the write reduction.**
**2,025 searches → 3 flush transactions → 81 row-writes = 96% fewer row-writes, 99.9%
fewer transactions** (`/metrics`).

**Q: What happens if the app crashes before a flush?**
Buffered counts (up to one flush window) are lost — the search was already acked, so it's
silent, bounded loss. We mitigate with a graceful-shutdown drain (SIGTERM/SIGINT). The
production fix is a durable log (WAL / Redis list / Kafka) the buffer can replay from.

**Q: What consistency does this give?**
Eventual: a count is visible after the next flush. The `/search` response shows
committed + pending so the user sees the increment immediately.

## Non-functional

**Q: Latency numbers?**
Server-side `/suggest`: p50 3.3ms, p95 7.3ms, p99 26ms. Cache hit ~1.9ms vs miss ~5ms
(2.6× on local SQLite); the bigger win is the cache absorbing ~92% of reads.

**Q: Why p95, not average?**
Averages hide the slow tail; users feel the worst requests. p95/p99 are the standard
latency SLOs.

**Q: Why SQLite WAL relates to the syllabus?**
WAL is a write-ahead log — same append-first family as the LSM-tree (Sessions 10–11) and
the Kafka commit log (Session 5).
