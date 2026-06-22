// cache.js — cache-aside layer with TWO ranking modes.
//
//   rank=popular  (default): top-10 by all-time count (M1 behavior).
//   rank=trending          : candidate-generation + recency re-ranking (M5).
//
// Each mode has its OWN cache key (`suggest:<prefix>:<rank>`) because the two
// rank differently. Trending entries use a shorter TTL since they change fast.
// Every Redis call is best-effort: a node outage degrades us to the DB.

import { ring } from './ringInstance.js';
import { clientForNode } from './redisClients.js';
import { normalize, getSuggestions, getTopByPrefix } from '../suggest.js';
import { getRecentScores } from '../trending.js';
import { metrics } from '../metrics.js';

const TTL_POPULAR = parseInt(process.env.CACHE_TTL_SECONDS || '60', 10);
const TTL_TRENDING = parseInt(process.env.CACHE_TTL_TRENDING_SECONDS || '10', 10);
const ALPHA = parseFloat(process.env.RECENCY_ALPHA || '0.5'); // recency weight [0..1]
const CANDIDATE_LIMIT = 50; // re-rank the top-50 popular matches by recency

const RANKS = ['popular', 'trending'];
const keyFor = (prefix, rank) => `suggest:${prefix}:${rank}`;
const normRank = (r) => (r === 'trending' ? 'trending' : 'popular');

/**
 * Cache-aside read in the requested ranking mode.
 */
export async function getSuggestionsCached(rawPrefix, rawRank = 'popular') {
  const prefix = normalize(rawPrefix);
  const rank = normRank(rawRank);
  if (prefix.length === 0) return { suggestions: [], cached: false, node: null, rank };

  const key = keyFor(prefix, rank);
  const node = ring.getNode(key);
  const client = clientForNode(node);

  // 1) try the cache
  try {
    const cached = await client.get(key);
    if (cached != null) {
      metrics.cacheHit();
      return { suggestions: JSON.parse(cached), cached: true, node, rank };
    }
  } catch {
    metrics.cacheError();
  }

  // 2) miss -> compute from the primary store (+ recency for trending)
  metrics.cacheMiss();
  const suggestions = rank === 'trending' ? await rankByRecency(prefix) : popularTop10(prefix);

  // 3) populate with a mode-specific TTL
  try {
    await client.set(key, JSON.stringify(suggestions), 'EX', rank === 'trending' ? TTL_TRENDING : TTL_POPULAR);
  } catch {
    /* best-effort */
  }
  return { suggestions, cached: false, node, rank };
}

function popularTop10(prefix) {
  const rows = getSuggestions(prefix);
  metrics.dbRead();
  return rows;
}

// Candidate generation (top-50 by count) + recency re-ranking.
//   score = (1-α)·(count/maxCount) + α·(recent/maxRecent)
// Both signals normalized within the candidate set; α tunes recency weight.
// With no recent activity, the recency term is 0 => falls back to popularity.
async function rankByRecency(prefix) {
  const candidates = getTopByPrefix(prefix, CANDIDATE_LIMIT);
  metrics.dbRead();
  if (candidates.length === 0) return [];

  const recent = await getRecentScores(candidates.map((c) => c.query));
  const maxCount = Math.max(...candidates.map((c) => c.count), 1);
  const maxRecent = Math.max(...candidates.map((c) => recent.get(c.query) || 0), 0);

  return candidates
    .map((c) => {
      const r = recent.get(c.query) || 0;
      const popN = c.count / maxCount;
      const recN = maxRecent > 0 ? r / maxRecent : 0;
      return { query: c.query, count: c.count, recent: r, score: +((1 - ALPHA) * popN + ALPHA * recN).toFixed(4) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

/**
 * Invalidate BOTH rank variants for every prefix of the searched query.
 */
export async function invalidatePrefixesOf(rawQuery) {
  const q = normalize(rawQuery);
  const tasks = [];
  for (let len = 1; len <= q.length; len++) {
    const prefix = q.slice(0, len);
    for (const rank of RANKS) {
      const key = keyFor(prefix, rank);
      tasks.push(Promise.resolve(clientForNode(ring.getNode(key)).del(key)).catch(() => {}));
    }
  }
  await Promise.all(tasks);
}

/**
 * /cache/debug payload: which node owns the (prefix, rank) key and hit/miss.
 */
export async function cacheDebug(rawPrefix, rawRank = 'popular') {
  const prefix = normalize(rawPrefix);
  const rank = normRank(rawRank);
  const key = keyFor(prefix, rank);
  const node = ring.getNode(key);
  let status = 'miss';
  try {
    status = (await clientForNode(node).exists(key)) ? 'hit' : 'miss';
  } catch {
    status = 'node-unreachable';
  }
  return { prefix, rank, key, keyHash: ring.hash(key), ownerNode: node, status, allNodes: ring.getPhysicalNodes() };
}

export { ring };
