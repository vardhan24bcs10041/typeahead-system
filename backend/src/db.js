// db.js — SQLite connection + schema.
//
// SQLite is our PRIMARY data store (system-of-record) for query -> count.
// It is embedded (a file), not a separate network service. We accept that
// trade-off deliberately: the *distribution* concern in this assignment lives
// in the cache tier (3 Redis nodes + consistent hashing), while SQLite is the
// single-node source of truth. In production you'd swap this for a networked /
// sharded SQL DB; the schema and access patterns stay identical.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// DB file location is configurable via env so Docker can point it at a mounted
// volume (data survives container restarts). Defaults to backend/data/.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'typeahead.db');

// Make sure the directory exists before SQLite tries to open the file.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// WAL = Write-Ahead Logging. Readers and the single writer no longer block each
// other (a reader sees a consistent snapshot while a write appends to the WAL).
// Viva tie-in: WAL is an append-first log — same family of idea as the LSM-tree
// (Sessions 10-11) and the Kafka commit log (Session 5). It also means our one
// SQLite writer won't stall the latency-critical /suggest reads.
db.pragma('journal_mode = WAL');
// NORMAL is the recommended durability/performance balance under WAL.
db.pragma('synchronous = NORMAL');

// One row per distinct, normalized query.
//   query  -> TEXT PRIMARY KEY => SQLite builds a B-tree index on `query`.
//             That index is exactly what turns a prefix search into a fast
//             range-scan (see suggest.js), and gives us clean UPSERT semantics
//             for the /search count increment (see search.js, Milestone 3).
//   count  -> all-time popularity (basic ranking signal).
//   last_searched_at -> unix ms of the most recent search; reserved for the
//             recency-aware trending ranking in Milestone 5.
db.exec(`
  CREATE TABLE IF NOT EXISTS queries (
    query            TEXT PRIMARY KEY,
    count            INTEGER NOT NULL,
    last_searched_at INTEGER NOT NULL DEFAULT 0
  );
`);

export default db;
export { DB_PATH };
