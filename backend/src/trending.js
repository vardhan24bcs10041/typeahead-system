// trending.js — recency tracking via a sliding window of time buckets.
//
// Each search increments the query in the current time bucket (a Redis sorted
// set). Buckets carry a TTL and self-delete once they age out of the window, so
// a short-lived spike can't stay ranked forever — it leaves the window.
//
// Trending is a weighted union of the last W buckets (newer buckets weigh more).
//
// All trending keys live on one node: ZUNIONSTORE can't span Redis instances,
// so the ring assigns the whole trending keyspace to a node via a fixed key.

import { ring } from './cache/ringInstance.js';
import { clientForNode } from './cache/redisClients.js';

const BUCKET_MS = parseInt(process.env.TREND_BUCKET_MS || '30000', 10);      // 30s buckets
const WINDOW_BUCKETS = parseInt(process.env.TREND_WINDOW_BUCKETS || '10', 10); // ~5 min window
const BUCKET_SECONDS = Math.ceil(BUCKET_MS / 1000);
const BUCKET_TTL = BUCKET_SECONDS * (WINDOW_BUCKETS + 2); // outlive the window, then expire

// The whole trending dataset is pinned to the node the ring assigns this key.
function trendClient() {
  return clientForNode(ring.getNode('trending:global'));
}
const curBucket = (now) => Math.floor(now / BUCKET_MS);
const bucketKey = (b) => `trend:bucket:${b}`;

/** Record one search into the current time bucket. */
export async function recordRecent(query, now = Date.now()) {
  try {
    const c = trendClient();
    const key = bucketKey(curBucket(now));
    await c.zincrby(key, 1, query);
    await c.expire(key, BUCKET_TTL); // refresh TTL so an active bucket survives the window
  } catch {
    /* best-effort */
  }
}

// Window = last W buckets; newer buckets get a higher weight (recency gradient).
function windowSpec(now) {
  const cur = curBucket(now);
  const keys = [];
  const weights = [];
  for (let i = 0; i < WINDOW_BUCKETS; i++) {
    keys.push(bucketKey(cur - i));
    weights.push((WINDOW_BUCKETS - i) / WINDOW_BUCKETS); // i=0 (now) => 1.0, oldest => 1/W
  }
  return { keys, weights };
}

// Merge the window into a temp ZSET (reused within the current bucket).
async function mergeWindow(c, now) {
  const dest = `trend:merged:${curBucket(now)}`;
  const { keys, weights } = windowSpec(now);
  await c.zunionstore(dest, keys.length, ...keys, 'WEIGHTS', ...weights);
  await c.expire(dest, BUCKET_SECONDS);
  return dest;
}

/** Top-N trending queries in the current window. */
export async function getTrending(limit = 10, now = Date.now()) {
  try {
    const c = trendClient();
    const dest = await mergeWindow(c, now);
    const flat = await c.zrevrange(dest, 0, limit - 1, 'WITHSCORES');
    const out = [];
    for (let i = 0; i < flat.length; i += 2) {
      out.push({ query: flat[i], score: +(+flat[i + 1]).toFixed(2) });
    }
    return out;
  } catch {
    return [];
  }
}

/** Windowed recency score for a set of candidate queries (for re-ranking). */
export async function getRecentScores(queries, now = Date.now()) {
  const scores = new Map();
  if (!queries.length) return scores;
  try {
    const c = trendClient();
    const dest = await mergeWindow(c, now);
    const pipe = c.pipeline();
    for (const q of queries) pipe.zscore(dest, q);
    const res = await pipe.exec();
    queries.forEach((q, i) => {
      const v = res[i]?.[1];
      if (v != null) scores.set(q, +v);
    });
  } catch {
    /* best-effort */
  }
  return scores;
}
