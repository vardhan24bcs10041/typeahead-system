// bench.js — latency + cache-hit-rate benchmark for /suggest.
//
// Two measurements:
//   1) Realistic load: fire N requests over a ZIPF prefix mix (a few hot
//      prefixes dominate, like real traffic) and report client p50/p95/p99,
//      throughput, and the hit rate (read from each response's `cached` flag).
//   2) Cache speedup: alternately flush the cache and hit one prefix, to
//      isolate the SQLite (miss) path vs the Redis (hit) path latency.
//
// Run (with the app + Redis already up):
//   REDIS_NODES=localhost:6379,localhost:6380,localhost:6381 node scripts/bench.js
//
// Reads REDIS_NODES so it can FLUSHALL the same nodes the app uses.

import { allClients } from '../src/cache/redisClients.js';

const BASE = process.env.BENCH_BASE || 'http://localhost:3000';
const N = parseInt(process.env.BENCH_N || '5000', 10);
const CONC = parseInt(process.env.BENCH_CONC || '20', 10);
const RANK = process.env.BENCH_RANK || 'popular';

// A pool of real prefixes; Zipf weighting repeats the hot ones far more often.
const PREFIXES = ['ip','ja','ho','do','py','be','ne','li','sa','co','wi','ap','go','am','to','wh','la','mo','of','st','me','da','sy','fl','th','wa','ga','sm','us','in'];
function zipfMix() {
  const mix = [];
  PREFIXES.forEach((p, i) => {
    const weight = Math.max(1, Math.round(300 / (i + 1))); // 1/rank popularity
    for (let k = 0; k < weight; k++) mix.push(p);
  });
  return mix;
}
const MIX = zipfMix();

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * (s.length - 1)))].toFixed(3);
};

async function timedGet(prefix) {
  const t = performance.now();
  const res = await fetch(`${BASE}/suggest?q=${encodeURIComponent(prefix)}&rank=${RANK}`);
  const json = await res.json();
  return { ms: performance.now() - t, cached: !!json.cached };
}

async function flushCaches() {
  for (const c of allClients()) {
    try { await c.flushall(); } catch { /* node down */ }
  }
}

async function load(label) {
  const lat = [];
  let hits = 0;
  let idx = 0;
  const t0 = performance.now();
  const worker = async () => {
    while (idx < N) {
      const p = MIX[idx++ % MIX.length];
      const r = await timedGet(p);
      lat.push(r.ms);
      if (r.cached) hits++;
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  const wallSec = (performance.now() - t0) / 1000;
  console.log(`\n[${label}]  N=${N}  concurrency=${CONC}  rank=${RANK}`);
  console.log(`  client latency : p50=${pct(lat, 50)}ms  p95=${pct(lat, 95)}ms  p99=${pct(lat, 99)}ms`);
  console.log(`  throughput     : ${Math.round(N / wallSec)} req/s`);
  console.log(`  cache hit rate : ${(hits / N * 100).toFixed(1)}%`);
}

async function speedup() {
  const K = 200;
  const miss = [];
  const hit = [];
  for (let i = 0; i < K; i++) {
    await flushCaches();
    miss.push((await timedGet('ip')).ms); // first hit after flush = SQLite path
    hit.push((await timedGet('ip')).ms);  // second hit = Redis path
  }
  console.log(`\n[Cache speedup on 'ip', ${K} iterations]`);
  console.log(`  MISS (SQLite path): p50=${pct(miss, 50)}ms  p95=${pct(miss, 95)}ms`);
  console.log(`  HIT  (Redis path) : p50=${pct(hit, 50)}ms  p95=${pct(hit, 95)}ms`);
  console.log(`  p50 speedup       : ${(pct(miss, 50) / Math.max(pct(hit, 50), 0.001)).toFixed(1)}x`);
}

(async () => {
  await flushCaches();
  await load('Realistic Zipf load');
  await speedup();
  const m = await (await fetch(`${BASE}/metrics`)).json();
  console.log(`\nServer /metrics:`);
  console.log(`  cacheHitRate=${m.cacheHitRate}  dbReads=${m.dbReads}`);
  console.log(`  server-side suggest latency: p50=${m.p50LatencyMs}ms p95=${m.p95LatencyMs}ms p99=${m.p99LatencyMs}ms`);
  process.exit(0);
})();
