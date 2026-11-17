// Stats for A/B bench JSONL (local only).
//
//   node tools/stats.mjs [--in bench-results/ab.jsonl] [--a r2] [--b r3]
//
// Per workload (p50_ms across reps) and for the geomean of p50s: median per
// arm, median ratio, Mann-Whitney U two-sided p (normal approximation with
// tie correction), and a bootstrap 95% CI for (median_B - median_A) from
// 4000 resamples with a fixed seed. A candidate "wins" a workload only when
// p < 0.05 AND the CI excludes 0 — a single fast rep on this shared CPU
// proves nothing (identical code has scored local perf 154 vs 90 before).

import { readFileSync } from 'node:fs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
const file = arg('--in', 'bench-results/ab.jsonl');
const tagA = arg('--a', 'r2');
const tagB = arg('--b', 'r3');

const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const byTag = {};
for (const r of rows) {
  if (r.error || !r.perf) continue;
  (byTag[r.tag] ??= []).push(r.perf);
}
const A = byTag[tagA] ?? [];
const B = byTag[tagB] ?? [];
if (A.length === 0 || B.length === 0) {
  process.stderr.write(`need reps for both ${tagA} (have ${A.length}) and ${tagB} (have ${B.length}) in ${file}\n`);
  process.exit(2);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const geomean = (xs) => Math.exp(xs.reduce((acc, x) => acc + Math.log(x), 0) / xs.length);

// Mann-Whitney U, two-sided p via normal approximation (tie-corrected).
function mannWhitney(x, y) {
  const all = [...x.map((v) => [v, 0]), ...y.map((v) => [v, 1])].sort((a, b) => a[0] - b[0]);
  const ranks = new Array(all.length);
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[k] = avg;
    i = j + 1;
  }
  let r1 = 0;
  for (let i = 0; i < all.length; i += 1) if (all[i][1] === 0) r1 += ranks[i];
  const n1 = x.length;
  const n2 = y.length;
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const u = Math.min(u1, n1 * n2 - u1);
  const mu = (n1 * n2) / 2;
  // Tie correction for sigma.
  let tieSum = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j += 1;
    const t = j - i + 1;
    if (t > 1) tieSum += t * t * t - t;
    i = j + 1;
  }
  const n = n1 + n2;
  const sigma = Math.sqrt(((n1 * n2) / (n * (n - 1))) * ((n * n * n - n) / 12 - tieSum / 12));
  const z = sigma === 0 ? 0 : (u - mu + 0.5 * Math.sign(u - mu)) / sigma;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { u, p };
}
function normalCdf(z) {
  // Abramowitz-Stegun 7.1.26.
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989422804014327 * Math.exp(-(z * z) / 2);
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return 1 - d * poly;
}

// Seeded RNG (mulberry32) so the bootstrap CI is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function bootstrapMedianDiff(x, y, reps = 4000) {
  const rand = rng(0x6a09e667);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const diffs = [];
  for (let i = 0; i < reps; i += 1) {
    const xs = Array.from({ length: x.length }, () => pick(x));
    const ys = Array.from({ length: y.length }, () => pick(y));
    diffs.push(median(ys) - median(xs));
  }
  diffs.sort((a, b) => a - b);
  return [diffs[Math.floor(0.025 * reps)], diffs[Math.floor(0.975 * reps)]];
}

function pointsOf(p50Ms, tRef) {
  return Math.round(Math.min(50, Math.max(0, 25 - 12.5 * Math.log2(p50Ms / tRef))));
}
const T_REF = { push: 1640.82, clone: 266.941, read: 2759.715, write: 348.965 };

const names = ['push', 'clone', 'read', 'write'].filter((n) => A[0].workloads.some((w) => w.name === n));
console.log(`A=${tagA} n=${A.length}  B=${tagB} n=${B.length}   (p50_ms per workload; geomean in us)`);
console.log('workload | median A | median B | ratio B/A | MW p | bootstrap 95% CI of median diff (ms) | pts A->B');
let ptsA = 0;
let ptsB = 0;
for (const name of names) {
  const xs = A.map((p) => p.workloads.find((w) => w.name === name).p50_ms);
  const ys = B.map((p) => p.workloads.find((w) => w.name === name).p50_ms);
  const ma = median(xs);
  const mb = median(ys);
  const { p } = mannWhitney(xs, ys);
  const [lo, hi] = bootstrapMedianDiff(xs, ys);
  const pa = pointsOf(ma, T_REF[name]);
  const pb = pointsOf(mb, T_REF[name]);
  ptsA += pa; ptsB += pb;
  console.log(`${name.padEnd(8)} | ${ma.toFixed(1).padStart(8)} | ${mb.toFixed(1).padStart(8)} | ${(mb / ma).toFixed(3).padStart(7)} | ${p.toFixed(4).padStart(7)} | [${lo.toFixed(1)}, ${hi.toFixed(1)}] | ${pa} -> ${pb}`);
}
const geoA = A.map((p) => p.perf_p50_us);
const geoB = B.map((p) => p.perf_p50_us);
const { p: gp } = mannWhitney(geoA, geoB);
const [glo, ghi] = bootstrapMedianDiff(geoA, geoB);
console.log(`geomean_us | ${median(geoA).toFixed(0).padStart(8)} | ${median(geoB).toFixed(0).padStart(8)} | ${(median(geoB) / median(geoA)).toFixed(3).padStart(7)} | ${gp.toFixed(4).padStart(7)} | [${glo.toFixed(0)}, ${ghi.toFixed(0)}] us | perf ${ptsA} -> ${ptsB} (score ${800 + ptsA} -> ${800 + ptsB})`);
console.log(`raw ${tagA} geomean_us: [${geoA.join(', ')}]`);
console.log(`raw ${tagB} geomean_us: [${geoB.join(', ')}]`);
