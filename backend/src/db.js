// db.js — SQLite connection + schema.
//
// SQLite is the primary store (source of truth) for query -> count. It is
// embedded rather than a separate network service; the distribution concern
// lives in the cache tier (3 Redis nodes + consistent hashing). Swapping in a
// networked/sharded SQL DB later wouldn't change the schema or access patterns.

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

// WAL (Write-Ahead Logging): readers and the single writer don't block each
// other, so the SQLite writer never stalls the latency-critical /suggest reads.
db.pragma('journal_mode = WAL');
// NORMAL is the recommended durability/performance balance under WAL.
db.pragma('synchronous = NORMAL');

// One row per distinct, normalized query.
//   query  -> TEXT PRIMARY KEY; the B-tree index on `query` turns a prefix
//             search into a range scan and gives clean UPSERT semantics for the
//             count increment.
//   count  -> all-time popularity (ranking signal).
//   last_searched_at -> unix ms of the most recent search; secondary recency signal.
db.exec(`
  CREATE TABLE IF NOT EXISTS queries (
    query            TEXT PRIMARY KEY,
    count            INTEGER NOT NULL,
    last_searched_at INTEGER NOT NULL DEFAULT 0
  );
`);

export default db;
export { DB_PATH };
