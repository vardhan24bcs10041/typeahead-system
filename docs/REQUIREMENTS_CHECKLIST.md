# Requirements Checklist

Every requirement from the assignment PDF, verified against the build.
✅ done · ⚠️ needs a manual action by you.

## §2 Problem Statement
| # | Requirement | Status | Where |
|---|---|---|---|
| 1 | Show 10 suggestions sorted by search count | ✅ | `suggest.js` (LIMIT 10, ORDER BY count DESC) |
| 2 | UI for searching + displaying suggestions | ✅ | `frontend/` |
| 3 | Dummy search API returns "Searched" | ✅ | `POST /search` → `{"message":"Searched"}` |
| 4 | Search submission updates the data store | ✅ | buffered → batched UPSERT (`batch.js`) |
| 5 | Design query-count storage + caching for low latency | ✅ | SQLite + Redis cache-aside |
| 6 | Cache distributed via consistent hashing | ✅ | `cache/ring.js`, 3 Redis nodes |
| 7 | Trending searches | ✅ | `trending.js`, `/trending`, `rank=trending` |
| 8 | Batch writes | ✅ | `batch.js` |

## §3 Dataset
| Requirement | Status | Where |
|---|---|---|
| Open-source dataset of query→count | ✅ | Google Web Trillion Word Corpus (`fetch_wordfreq.js`); Wikipedia + synthetic also supported |
| ≥100,000 queries | ✅ | **333,333** real words loaded (also: 200k+ Wikipedia / 150k synthetic) |
| Counts included or aggregated | ✅ | real frequency counts; aggregated in `ingest.js` |
| Loading script + instructions | ✅ | `npm run ingest`, README "Dataset" |

## §4.1 Typeahead Suggestions
| Requirement | Status | Where |
|---|---|---|
| At most 10 suggestions | ✅ | `LIMIT 10` |
| Must start with prefix | ✅ | range-scan `>= prefix AND < prefix⁺` |
| Sorted by count desc | ✅ | `ORDER BY count DESC` |
| Handle empty / missing input | ✅ | returns `[]`, HTTP 200 |
| Handle mixed-case input | ✅ | normalize (lowercase) — verified `IPh`→`iph` |
| Handle no-match | ✅ | returns `[]` |
| UI debouncing | ✅ | 200ms debounce + 2-char trigger (`app.js`) |

## §4.2 Search Submission
| Requirement | Status | Where |
|---|---|---|
| Existing query → count increases | ✅ | UPSERT `count = count + …` (verified +5) |
| New query → inserted with initial count | ✅ | verified (`kshitij demo` → 1) |
| Returns `{"message":"Searched"}` | ✅ | `server.js` |
| Eventually reflected in suggestions/trending | ✅ | after batch flush (verified) |

## §5 API Expectations
| API | Status | Where |
|---|---|---|
| `GET /suggest?q=<prefix>` | ✅ | up to 10, sorted by count |
| `POST /search` | ✅ | returns "Searched", records query |
| `GET /cache/debug?prefix=<prefix>` | ✅ | shows owner node + hit/miss |

## §6 Data Storage & Caching
| Requirement | Status | Where |
|---|---|---|
| Maintain query-count reliably | ✅ | SQLite WAL, volume-persisted |
| Cache before primary store | ✅ | cache-aside in `cache.js` |
| Cache stores suggestion results for prefixes | ✅ | key `suggest:<prefix>:<rank>` |
| Cache expiry or invalidation | ✅ | TTL + invalidation on flush |
| Distributed across multiple logical nodes | ✅ | 3 Redis containers |
| Consistent hashing decides node ownership | ✅ | `ring.getNode()`; demoed 31% vs 67% |

## §7 Trending Searches
| Requirement | Status | Where |
|---|---|---|
| Basic: sort by overall count | ✅ | `rank=popular` (default) |
| Enhanced: recency-aware ranking | ✅ | `rank=trending`, `(1−α)·pop+α·recency` |
| Explain how recent searches tracked | ✅ | sliding-window buckets — DESIGN_CHOICES/VIVA |
| Explain how recency affects ranking | ✅ | normalized blend — VIVA_PREP |
| Avoid permanently over-ranking spikes | ✅ | window expiry — demoed (jumped #1 → decayed #8) |
| Cache update/invalidation on rank change | ✅ | mode-scoped keys + short trending TTL |
| Trade-offs explained | ✅ | DESIGN_CHOICES §6 |
| Same `/suggest` API supports both | ✅ | `rank` param |
| Demonstrate the difference | ✅ | live trace in chat / re-run with `rank=trending` |

## §8 Batch Writes
| Requirement | Status | Where |
|---|---|---|
| Collected in buffer/queue/log | ✅ | in-memory Map buffer (`batch.js`) |
| Repeated queries aggregated | ✅ | summed before UPSERT |
| Flush periodically or by size | ✅ | `BATCH_INTERVAL_MS` + `BATCH_MAX_SIZE` |
| Show write reduction | ✅ | 96% rows / 99.9% txns (PERFORMANCE.md, `/metrics`) |
| Discuss crash-before-flush trade-off | ✅ | DESIGN_CHOICES §7, graceful drain implemented |

## §9 UI
| Requirement | Status | Where |
|---|---|---|
| Search input box | ✅ | `index.html` |
| Suggestion dropdown updates as you type | ✅ | `app.js` |
| Submit on Enter or clicking a search button | ✅ | Enter + `#search-btn` (magnifier) + click suggestion |
| Display dummy search response | ✅ | response banner |
| Trending searches section | ✅ | trending panel |
| Loading and error states | ✅ | spinner + error/retry + empty states |
| Basic keyboard navigation | ✅ | ↑/↓/Enter/Esc |
| Clean and usable layout | ✅ | flat design via UI/UX skill |

## §10 Non-Functional
| Requirement | Status | Where |
|---|---|---|
| Easy to run locally | ✅ | `docker compose up --build` |
| Suggestions optimized for low latency | ✅ | cache-first; p95 7.3ms |
| Measure + report p95 latency | ✅ | PERFORMANCE.md, `/metrics` |
| Report cache hit rate + DB read/write counts | ✅ | `/metrics` (hitRate, dbReads, rowsWritten) |
| Logs/explanation of consistent-hashing behavior | ✅ | `hashing_demo.js`, `/cache/debug` |
| Modular, readable, documented code | ✅ | per-module files, commented throughout |

## §12 Deliverables
| Deliverable | Status | Where |
|---|---|---|
| GitHub repo / source | ⚠️ | code ready; **run `git init` + push** (see note) |
| README with setup | ✅ | `README.md` |
| Dataset source + loading | ✅ | README "Dataset" |
| Architecture diagram + explanation | ✅ | `docs/ARCHITECTURE.md` |
| API documentation | ✅ | `docs/API.md` |
| Screenshots / demo video | ⚠️ | **capture from http://localhost:3000** (manual) |
| Performance report | ✅ | `docs/PERFORMANCE.md` |
| Design choices & trade-offs | ✅ | `docs/DESIGN_CHOICES.md` |

## §13 Rubric coverage
| Component | Marks | Status |
|---|---|---|
| Basic implementation | 60 | ✅ ingestion, UI, suggest, search, count updates, distributed cache + consistent hashing |
| Trending searches | 20 | ✅ recency-aware ranking + windowing explanation |
| Batch writes | 20 | ✅ batching + write-reduction evidence + failure trade-off |

## Manual actions remaining (only these two)
1. **Screenshots / demo video** — open http://localhost:3000, capture the dropdown,
   trending panel, and a search; or record a short screen capture.
2. **Git** — this folder lives inside your home-dir git repo, so initialize a
   dedicated repo here before pushing:
   ```bash
   cd "c:/Users/VARDHAN/Documents/Codes/kshitij"
   git init && git add . && git commit -m "Search Typeahead System"
   # then add your GitHub remote and push
   ```
