// Interleaved A/B bench driver (local only).
//
//   node tools/ab-bench.mjs --a <dirA> --b <dirB> --reps N --tagA r2 --tagB r3 \
//       [--rounds 3] [--workloads push,clone,read,write] [--out bench-results/ab.jsonl]
//
// Each rep starts a fresh server from each arm's directory (node
// --experimental-strip-types tools/serve.ts), waits for /healthz, runs the
// sealed benchmark via tools/run-bench.ts, kills the server, and appends one
// JSON line per arm: {tag, rep, perf}. Arm order alternates per rep so a slow
// drift of the shared CPU cannot masquerade as an arm effect. A fresh server
// per rep also means no state (repos, pack cache) leaks between reps.
//
// Usage note: run with cwd = the candidate repo root; --a/--b are directories
// containing tools/serve.ts + tools/run-bench.ts (the baseline worktree has
// them once they are committed there too — until then pass --a pointing at a
// directory that already has them, or copy the tools dir in).

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const TOKEN = 'shpat_localtest00000000000000000000000000000000';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
const dirA = arg('--a', '');
const dirB = arg('--b', '');
const reps = Number(arg('--reps', '3'));
const tagA = arg('--tagA', 'A');
const tagB = arg('--tagB', 'B');
const rounds = Number(arg('--rounds', '3'));
const workloads = arg('--workloads', '');
const out = arg('--out', 'bench-results/ab.jsonl');
if (!dirA || !dirB) {
  process.stderr.write('usage: ab-bench.mjs --a <dir> --b <dir> --reps N [--rounds N] [--workloads a,b] [--out file]\n');
  process.exit(2);
}
mkdirSync(dirname(out), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(port, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) return true;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  return false;
}

/** Start a server from `dir`; resolves {child, port} once it prints PORT. */
function startServer(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--experimental-strip-types', 'tools/serve.ts'], {
      cwd: dir,
      env: { ...process.env, LOCAL_TOKEN: TOKEN, LOCAL_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    let done = false;
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/PORT (\d+)/);
      if (m && !done) {
        done = true;
        child.stdout.off('data', onData);
        resolve({ child, port: Number(m[1]) });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (c) => process.stderr.write(`[server:${dir}] ${c}`));
    child.on('exit', (code) => {
      if (!done) reject(new Error(`server in ${dir} exited early code=${code} out=${buf}`));
    });
    setTimeout(() => { if (!done) reject(new Error(`server in ${dir} did not print PORT in time`)); }, 15000);
  });
}

async function runBenchOnce(dir, port) {
  return new Promise((resolve, reject) => {
    const args = ['--experimental-strip-types', 'tools/run-bench.ts', '--url', `http://127.0.0.1:${port}`, '--token', TOKEN, '--rounds', String(rounds)];
    if (workloads) args.push('--workloads', workloads);
    const child = spawn('node', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let outBuf = '';
    let errBuf = '';
    child.stdout.on('data', (c) => { outBuf += c; });
    child.stderr.on('data', (c) => { errBuf += c; process.stderr.write(c); });
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`run-bench exited ${code}: ${errBuf.slice(-500)}`));
      try {
        resolve(JSON.parse(outBuf.trim().split('\n').pop()));
      } catch (e) {
        reject(new Error(`run-bench output not JSON: ${outBuf.slice(-500)}`));
      }
    });
  });
}

async function oneArm(dir, tag, rep) {
  const { child, port } = await startServer(dir);
  try {
    if (!(await waitHealth(port))) throw new Error(`no /healthz from ${dir}:${port}`);
    const perf = await runBenchOnce(dir, port);
    const rec = { tag, rep, dir, perf };
    appendFileSync(out, `${JSON.stringify(rec)}\n`);
    const p50s = Object.fromEntries(perf.workloads.map((w) => [w.name, w.p50_ms]));
    const pts = perf.points_total;
    process.stdout.write(`rep ${rep} ${tag}: p50 ${JSON.stringify(p50s)} geomean_us ${perf.perf_p50_us} points ${pts}\n`);
    return rec;
  } finally {
    child.kill('SIGKILL');
  }
}

for (let rep = 1; rep <= reps; rep += 1) {
  const order = rep % 2 === 1 ? [[dirA, tagA], [dirB, tagB]] : [[dirB, tagB], [dirA, tagA]];
  for (const [dir, tag] of order) {
    try {
      await oneArm(dir, tag, rep);
    } catch (err) {
      process.stderr.write(`rep ${rep} ${tag} FAILED: ${err.message}\n`);
      appendFileSync(out, `${JSON.stringify({ tag, rep, dir, error: String(err.message ?? err) })}\n`);
    }
    await sleep(500);
  }
}
process.stdout.write(`done; results appended to ${out}\n`);
