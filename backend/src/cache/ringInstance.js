// ringInstance.js — the single consistent-hashing ring shared app-wide.
//
// Extracted into its own module so both cache.js and trending.js can import the
// SAME ring without a circular dependency (cache.js imports trending.js).

import { ConsistentHashRing } from './ring.js';
import { nodeIds } from './redisClients.js';

export const ring = new ConsistentHashRing(nodeIds, 150);
