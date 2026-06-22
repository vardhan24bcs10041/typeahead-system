// ingest.js — load the query->count dataset into SQLite.
//
// Source precedence:
//   1. A TSV file ("<query>\t<count>" per line) at $DATASET_PATH or
//      backend/data/queries.tsv — the canonical intermediate format that the
//      fetch scripts (fetch_wikipedia.js / fetch_wordfreq.js) produce.
//   2. If no file is present, generate a reproducible synthetic dataset so the
//      system always works offline.
//
// This is a full (re)load: it clears the table, then bulk-inserts the aggregated
// rows inside a single transaction (fast, and avoids a fsync per row). Runtime
// /search increments build on top of this seed.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import db from '../src/db.js';
import { normalize } from '../src/suggest.js';
import { generateSynthetic } from './generate_synthetic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATASET_PATH = process.env.DATASET_PATH || path.join(__dirname, '..', 'data', 'queries.tsv');

// Aggregate (query -> summed count). Normalization can merge rows that differ
// only by case/whitespace (e.g. Wikipedia "Apple" + "apple"), so we sum them.
async function loadFromFile(filePath) {
  const counts = new Map();
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });
  let lines = 0;
  for await (const line of rl) {
    if (!line) continue;
    const tab = line.lastIndexOf('\t');
    if (tab === -1) continue;
    // Wikipedia titles use '_' for spaces; turn them into normal query text.
    const query = normalize(line.slice(0, tab).replace(/_/g, ' '));
    const count = parseInt(line.slice(tab + 1), 10);
    if (!query || !Number.isFinite(count) || count <= 0) continue;
    counts.set(query, (counts.get(query) || 0) + count);
    lines++;
  }
  console.log(`Read ${lines} lines -> ${counts.size} distinct queries from ${filePath}`);
  return counts;
}

function loadFromSynthetic() {
  console.log('No dataset file found — generating reproducible synthetic data...');
  const counts = new Map();
  for (const { query, count } of generateSynthetic()) {
    const q = normalize(query);
    counts.set(q, (counts.get(q) || 0) + count);
  }
  console.log(`Generated ${counts.size} distinct synthetic queries`);
  return counts;
}

function bulkLoad(counts) {
  db.exec('DELETE FROM queries;'); // full reload
  const insert = db.prepare(
    'INSERT INTO queries (query, count, last_searched_at) VALUES (?, ?, 0)'
  );
  // better-sqlite3 transaction: all inserts commit together (one fsync), which
  // is what makes loading 100k+ rows take ~a second instead of minutes.
  const insertAll = db.transaction((entries) => {
    for (const [query, count] of entries) insert.run(query, count);
  });
  const start = process.hrtime.bigint();
  insertAll(counts.entries());
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(`Inserted ${counts.size} rows in ${ms.toFixed(0)} ms`);
}

async function main() {
  const counts = fs.existsSync(DATASET_PATH)
    ? await loadFromFile(DATASET_PATH)
    : loadFromSynthetic();

  if (counts.size < 100000) {
    console.warn(
      `WARNING: only ${counts.size} distinct queries (<100k required). ` +
        'Use a larger dataset or the synthetic generator.'
    );
  }
  bulkLoad(counts);

  const total = db.prepare('SELECT COUNT(*) AS n FROM queries').get().n;
  const top = db.prepare('SELECT query, count FROM queries ORDER BY count DESC LIMIT 5').all();
  console.log(`\nDONE. Rows in DB: ${total}`);
  console.log('Top 5 by count:');
  for (const r of top) console.log(`  ${r.count}\t${r.query}`);
}

main().catch((err) => {
  console.error('Ingest failed:', err);
  process.exit(1);
});
