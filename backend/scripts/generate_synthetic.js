// generate_synthetic.js — produce a realistic, reproducible >100k query dataset.
//
// The headline dataset is Wikipedia titles + view counts, but the app must also
// run with no internet. This generator guarantees at least 100k rows and is
// reproducible (a fixed PRNG seed gives identical data every run), so
// latency/cache numbers stay comparable across runs.
//
// Counts follow a Zipf / power-law distribution like real search popularity — a
// few queries searched enormously, with a long tail. Queries share head terms
// ("how to ...", "best ...", "iphone ...") so prefix search has varied top-10
// results to rank.

// --- deterministic PRNG (mulberry32): seeded => reproducible -----------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// "Head" terms = common ways searches begin. Earlier entries are more popular
// (they get a higher base weight), which seeds the Zipf distribution.
const HEADS = [
  'iphone', 'samsung galaxy', 'how to', 'best', 'cheap', 'buy', 'java', 'python',
  'javascript', 'react', 'node js', 'docker', 'kubernetes', 'linux', 'windows',
  'apple', 'google', 'amazon', 'netflix', 'youtube', 'top 10', 'new', 'used',
  'download', 'free', 'online', 'what is', 'why is', 'where to', 'when is',
  'laptop', 'gaming pc', 'wireless earbuds', 'smart watch', 'air conditioner',
  'refrigerator', 'washing machine', 'office chair', 'standing desk', 'monitor',
  'mechanical keyboard', 'coffee maker', 'running shoes', 'winter jacket',
  'system design', 'data structures', 'machine learning', 'deep learning',
  'web development', 'interview questions', 'resume template', 'cover letter',
  'flight to', 'hotels in', 'things to do in', 'weather in', 'map of',
  'restaurants near', 'movies', 'songs', 'recipe for', 'symptoms of',
];

// "Tail" terms = words/modifiers appended to a head.
const TAILS = [
  'pro', 'pro max', 'plus', 'ultra', 'mini', 'lite', 'review', 'reviews',
  '2024', '2025', 'price', 'specs', 'comparison', 'vs', 'alternative',
  'tutorial', 'for beginners', 'advanced', 'cheat sheet', 'examples',
  'explained', 'guide', 'tips', 'tricks', 'best practices', 'roadmap',
  'india', 'usa', 'uk', 'near me', 'today', 'this week', 'this weekend',
  'black', 'white', 'silver', 'blue', 'red', 'green', 'gold',
  'under 500', 'under 1000', 'budget', 'premium', 'professional',
  'with case', 'with warranty', 'refurbished', 'second hand', 'wholesale',
  'meaning', 'definition', 'history', 'benefits', 'side effects', 'dosage',
  'login', 'sign up', 'app', 'website', 'api', 'documentation', 'github',
  'course', 'certification', 'salary', 'jobs', 'companies', 'startups',
  'list', 'ranking', 'leaderboard', 'statistics', 'dataset', 'chart',
];

/**
 * Generate up to `target` distinct {query, count} rows.
 * @param {number} target  minimum distinct rows to emit (default 150000)
 * @param {number} seed    PRNG seed for reproducibility
 * @returns {{query: string, count: number}[]}
 */
export function generateSynthetic(target = 150000, seed = 1337) {
  const rng = mulberry32(seed);
  const rows = [];
  const seen = new Set();

  const push = (query, baseWeight) => {
    if (seen.has(query)) return;
    seen.add(query);
    // Zipf-ish count: popular heads/short queries get large counts, with random
    // jitter so equal-rank queries don't tie. Floor at 1 so nothing is zero.
    const jitter = 0.4 + rng() * 0.6; // 0.4 .. 1.0
    const count = Math.max(1, Math.round(baseWeight * jitter));
    rows.push({ query, count });
  };

  // 1) Single-head queries first ("iphone", "best", ...) — the most popular.
  HEADS.forEach((head, i) => {
    const baseWeight = Math.round(1_000_000 / (i + 1)); // classic 1/rank Zipf
    push(head, baseWeight);
  });

  // 2) head + tail combinations — the bulk and the long tail.
  for (let h = 0; h < HEADS.length && rows.length < target; h++) {
    const headWeight = 1_000_000 / (h + 1);
    for (let t = 0; t < TAILS.length && rows.length < target; t++) {
      const query = `${HEADS[h]} ${TAILS[t]}`;
      // Popularity decays with the tail's rank too (^0.8 = gentle decay).
      const baseWeight = headWeight / Math.pow(t + 2, 0.8);
      push(query, Math.round(baseWeight));
    }
  }

  // 3) head + tail + tail combinations to reach the target if needed.
  outer: for (let h = 0; h < HEADS.length; h++) {
    const headWeight = 1_000_000 / (h + 1);
    for (let t1 = 0; t1 < TAILS.length; t1++) {
      for (let t2 = 0; t2 < TAILS.length; t2++) {
        if (rows.length >= target) break outer;
        if (t1 === t2) continue;
        const query = `${HEADS[h]} ${TAILS[t1]} ${TAILS[t2]}`;
        const baseWeight = headWeight / (Math.pow(t1 + 2, 0.8) * Math.pow(t2 + 2, 0.6));
        push(query, Math.max(1, Math.round(baseWeight)));
      }
    }
  }

  return rows;
}

// --- standalone mode: write a TSV that ingest.js can load --------------------
// Run with:  node scripts/generate_synthetic.js [count] [outPath]
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

  const count = Number(process.argv[2]) || 150000;
  const outPath = process.argv[3] || path.join(__dirname, '..', 'data', 'queries.tsv');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const rows = generateSynthetic(count);
  const out = fs.createWriteStream(outPath);
  for (const r of rows) out.write(`${r.query}\t${r.count}\n`);
  out.end();
  out.on('finish', () =>
    console.log(`Wrote ${rows.length} synthetic queries -> ${outPath}`)
  );
}
