// hashing_demo.js — evidence that consistent hashing minimizes key movement.
//
// Run:  node scripts/hashing_demo.js
// Shows the whole reason we use a ring instead of `hash(key) % N`: when a cache
// node leaves, consistent hashing moves only the keys that lived on THAT node
// (~1/N), while `hash % N` reshuffles almost everything (a full cache flush).

import crypto from 'node:crypto';
import { ConsistentHashRing } from '../src/cache/ring.js';

const N_KEYS = 10000;
const keys = Array.from({ length: N_KEYS }, (_, i) => `suggest:prefix${i}`);
const h = (s) => parseInt(crypto.createHash('md5').update(s).digest('hex').slice(0, 8), 16);

// ---- consistent hashing: 3 nodes -> remove 1 ----
const ring = new ConsistentHashRing(['redis-0', 'redis-1', 'redis-2'], 150);
const before = new Map(keys.map((k) => [k, ring.getNode(k)]));

const dist = {};
for (const k of keys) dist[before.get(k)] = (dist[before.get(k)] || 0) + 1;

ring.removeNode('redis-2');
let movedRing = 0;
for (const k of keys) if (ring.getNode(k) !== before.get(k)) movedRing++;

// ---- naive hash % N: 3 nodes -> 2 nodes ----
let movedMod = 0;
for (const k of keys) {
  const was = `n${h(k) % 3}`;
  const now = `n${h(k) % 2}`;
  if (was !== now) movedMod++;
}

console.log(`Distribution of ${N_KEYS} keys across 3 nodes (150 vnodes each):`);
for (const [node, c] of Object.entries(dist)) {
  console.log(`  ${node}: ${c} keys (${(c / N_KEYS * 100).toFixed(1)}%)`);
}
console.log(`\nRemove one node (3 -> 2). Keys forced to move:`);
console.log(`  consistent hashing : ${movedRing}/${N_KEYS} (${(movedRing / N_KEYS * 100).toFixed(1)}%)  ~ ideal 1/3`);
console.log(`  naive hash % N     : ${movedMod}/${N_KEYS} (${(movedMod / N_KEYS * 100).toFixed(1)}%)  <- cache stampede`);
