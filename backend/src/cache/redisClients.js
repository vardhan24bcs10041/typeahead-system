// redisClients.js — one Redis connection per logical cache node.
//
// These are three independent standalone Redis servers (not Redis Cluster); we
// route between them ourselves with the consistent-hashing ring. A node id is
// its "host:port" address string.

import Redis from 'ioredis';

// REDIS_NODES (Docker):  "redis-0:6379,redis-1:6379,redis-2:6379"
// default (local dev):   three localhost ports
const spec =
  process.env.REDIS_NODES || 'localhost:6379,localhost:6380,localhost:6381';
const addresses = spec.split(',').map((s) => s.trim()).filter(Boolean);

const clients = new Map();
export const nodeIds = [];

for (const addr of addresses) {
  const [host, portStr] = addr.split(':');
  const client = new Redis({
    host,
    port: Number(portStr) || 6379,
    // Fail fast instead of hanging if a node is down, so the cache layer can
    // gracefully fall back to the DB (a cache outage must not take us offline).
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  client.on('error', () => {}); // swallow connection noise; callers handle failures
  clients.set(addr, client);
  nodeIds.push(addr);
}

export function clientForNode(node) {
  return clients.get(node);
}

export function allClients() {
  return [...clients.values()];
}
