// fetch_wordfreq.js — download a broad, real word-frequency dataset.
//
// Source: the Google Web Trillion Word Corpus unigram counts, published by
// Peter Norvig at https://norvig.com/ngrams/  (file: count_1w.txt).
// 333,333 English words with frequency counts — broad "all-round" coverage so
// any common word returns suggestions. The file is ALREADY "word<TAB>count",
// which is exactly the canonical TSV that ingest.js consumes.
//
// Usage:
//   node scripts/fetch_wordfreq.js
//   npm run ingest

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.WORDFREQ_URL || 'https://norvig.com/ngrams/count_1w.txt';
const outPath = path.join(__dirname, '..', 'data', 'queries.tsv');
fs.mkdirSync(path.dirname(outPath), { recursive: true });

console.log(`Downloading ${URL} ...`);
const res = await fetch(URL);
if (!res.ok) throw new Error(`HTTP ${res.status} for ${URL}`);

await new Promise((resolve, reject) => {
  const ws = fs.createWriteStream(outPath);
  Readable.fromWeb(res.body).pipe(ws).on('finish', resolve).on('error', reject);
});

const lines = fs.readFileSync(outPath, 'utf8').trimEnd().split('\n').length;
console.log(`Wrote ${lines} words -> ${outPath}`);
console.log('Now run:  npm run ingest   (or, for the Docker container, re-ingest into the volume)');
