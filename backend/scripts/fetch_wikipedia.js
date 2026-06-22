// fetch_wikipedia.js — download a real Wikimedia "pageviews" dump and convert it
// to the canonical queries.tsv ("<title>\t<views>") that ingest.js consumes.
//
// This is the HEADLINE dataset path (Wikipedia titles + view counts). It is
// OPTIONAL for running the demo — ingest.js falls back to synthetic data — but
// it's how you produce the real >100k dataset for the submission.
//
// Pageviews dump format (whitespace-separated):
//   <domain_code> <page_title> <view_count> <total_response_bytes>
// We keep English Wikipedia ('en'), drop namespaced/junk pages, aggregate
// title -> sum(views), and write the top-N by views.
//
// Usage:
//   node scripts/fetch_wikipedia.js [YYYY] [MM] [DD] [HH] [topN]
//   node scripts/fetch_wikipedia.js 2024 01 15 12 200000
// Browse available dumps: https://dumps.wikimedia.org/other/pageviews/

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [, , year = '2024', month = '01', day = '15', hour = '12', topN = '200000'] = process.argv;
const TOP_N = Number(topN);

const url =
  `https://dumps.wikimedia.org/other/pageviews/${year}/${year}-${month}/` +
  `pageviews-${year}${month}${day}-${hour}0000.gz`;

const outPath = path.join(__dirname, '..', 'data', 'queries.tsv');
fs.mkdirSync(path.dirname(outPath), { recursive: true });

// Skip Wikipedia administrative / non-article titles — they aren't "queries".
const JUNK = /^(Main_Page$|Special:|Talk:|User:|Wikipedia:|File:|Template:|Category:|Portal:|Help:|Draft:)/;

async function main() {
  console.log(`Downloading ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} for ${url}\n` +
        'Pick a valid date/hour from https://dumps.wikimedia.org/other/pageviews/'
    );
  }

  // Stream: HTTP body -> gunzip -> line reader. We never hold the whole file.
  const gunzip = zlib.createGunzip();
  const rl = readline.createInterface({
    input: Readable.fromWeb(res.body).pipe(gunzip),
    crlfDelay: Infinity,
  });

  const counts = new Map();
  let scanned = 0;
  for await (const line of rl) {
    scanned++;
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    const [domain, title, views] = parts;
    if (domain !== 'en') continue;          // English Wikipedia only
    if (JUNK.test(title)) continue;          // drop admin pages
    const v = parseInt(views, 10);
    if (!Number.isFinite(v) || v <= 0) continue;
    counts.set(title, (counts.get(title) || 0) + v);
  }
  console.log(`Scanned ${scanned} lines -> ${counts.size} English article titles`);

  // Keep the top-N by views (descending) — that's our >100k seed.
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N);
  const out = fs.createWriteStream(outPath);
  for (const [title, v] of top) out.write(`${title}\t${v}\n`);
  out.end();
  out.on('finish', () => {
    console.log(`Wrote ${top.length} queries -> ${outPath}`);
    console.log('Now run:  npm run ingest');
  });
}

main().catch((err) => {
  console.error('fetch_wikipedia failed:', err.message);
  process.exit(1);
});
