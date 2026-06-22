// seed.js — make `docker-compose up` self-sufficient.
//
// On startup, if the queries table is empty (fresh volume, no dataset file),
// generate the reproducible synthetic dataset so the app always has data.
// If you ran `npm run ingest` (e.g. with the real Wikipedia file), the table is
// already populated and this is a no-op.

import db from './db.js';
import { generateSynthetic } from '../scripts/generate_synthetic.js';

export function seedIfEmpty() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM queries').get();
  if (n > 0) return n;

  const insert = db.prepare(
    'INSERT OR IGNORE INTO queries (query, count, last_searched_at) VALUES (?, ?, 0)'
  );
  const insertAll = db.transaction((rows) => {
    for (const r of rows) insert.run(r.query, r.count);
  });
  insertAll(generateSynthetic());

  return db.prepare('SELECT COUNT(*) AS n FROM queries').get().n;
}
