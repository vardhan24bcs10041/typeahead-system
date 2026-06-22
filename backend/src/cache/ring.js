// ring.js — a consistent-hashing ring (Session 2 made real).
//
// WHY NOT hash(key) % N:
//   With N cache nodes, `hash(key) % N` spreads keys evenly — until N changes.
//   Add or remove ONE node and (N-1)/N of all keys remap to a different node,
//   flushing almost the whole cache and stampeding the DB.
//
// CONSISTENT HASHING:
//   Place nodes AND keys on a circular space [0, 2^32). A key is owned by the
//   first node found CLOCKWISE from the key. Adding/removing a node only moves
//   the keys in one arc (~1/N), leaving everyone else untouched.
//
// VIRTUAL NODES:
//   With only 3 physical nodes, 3 ring points give lumpy load. So each physical
//   node is placed at many points (`vnodes`, default 150). More points => the
//   load evens out and rebalancing on membership change stays smooth. The cost
//   is a little memory (vnodes * nodes ring entries).

import crypto from 'node:crypto';

// Map any string to a 32-bit unsigned position on the ring. md5 is overkill for
// crypto but gives a well-distributed, deterministic hash with zero deps.
function hash32(str) {
  return parseInt(crypto.createHash('md5').update(str).digest('hex').slice(0, 8), 16);
}

export class ConsistentHashRing {
  constructor(nodes = [], vnodes = 150) {
    this.vnodes = vnodes;
    this.ring = [];      // sorted [{ hash, node }] — the ring positions
    this.physical = [];  // physical node ids
    for (const n of nodes) this.addNode(n);
  }

  addNode(node) {
    if (this.physical.includes(node)) return;
    this.physical.push(node);
    for (let i = 0; i < this.vnodes; i++) {
      this.ring.push({ hash: hash32(`${node}#${i}`), node });
    }
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  removeNode(node) {
    this.ring = this.ring.filter((e) => e.node !== node);
    this.physical = this.physical.filter((n) => n !== node);
  }

  hash(key) { return hash32(key); }

  // Owning node = first vnode CLOCKWISE from the key's hash (binary search for
  // the first ring entry with hash >= key hash; wrap to index 0 if past the end).
  getNode(key) {
    if (this.ring.length === 0) return null;
    const h = hash32(key);
    let lo = 0, hi = this.ring.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ring[mid].hash < h) lo = mid + 1;
      else hi = mid;
    }
    return this.ring[lo % this.ring.length].node; // wrap around the circle
  }

  getPhysicalNodes() { return [...this.physical]; }

  // Demo/evidence helper: route many sample keys and count per node, so we can
  // SHOW the distribution is balanced (the "consistent-hashing behavior" log).
  distribution(sampleCount = 10000) {
    const counts = Object.fromEntries(this.physical.map((n) => [n, 0]));
    for (let i = 0; i < sampleCount; i++) counts[this.getNode(`suggest:sample:${i}`)]++;
    return counts;
  }
}
