// Measure server CPU time per sealed workload (local only).
//
//   node tools/server-cpu.mjs --dir <serverDir>
//
// For each workload: fresh server, snapshot /proc/<pid>/stat utime+stime,
// run the sealed bench for that workload only (3 rounds), snapshot again.
// Prints wall p50 vs server CPU ms: the server-CPU share is the hard upper
// bound for any server-side optimisation of that workload.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const TOKEN = 'shpat_localtest00000000000000000000000000000000';
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
const dir = arg('--dir', process.cwd());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLK_TCK = 100;

function cpuMs(pid) {
  const parts = readFileSync(`/proc/${pid}/stat`, 'utf8').trim().split(' ');
  // utime field 14, stime field 15 (1-based; index 13/14 after split, but the
  // comm field may contain spaces — our process name has none).
  return ((Number(parts[13]) + Number(parts[14])) / CLK_TCK) * 1000;
}
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

for (const w of ['push', 'clone', 'read', 'write']) {
  const child = spawn('node', ['--experimental-strip-types', 'tools/serve.ts'], {
    cwd: dir,
    env: { ...process.env, LOCAL_TOKEN: TOKEN, LOCAL_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', (c) => {
      buf += c;
      const m = buf.match(/PORT (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.stderr.on('data', () => {});
    setTimeout(() => reject(new Error('no PORT')), 15000);
  });
  await waitHealth(port);
  const before = cpuMs(child.pid);
  const benchOut = await new Promise((resolve, reject) => {
    const b = spawn('node', ['--experimental-strip-types', 'tools/run-bench.ts', '--url', `http://127.0.0.1:${port}`, '--token', TOKEN, '--rounds', '3', '--workloads', w], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    let e = '';
    b.stdout.on('data', (c) => { o += c; });
    b.stderr.on('data', (c) => { e += c; });
    b.on('exit', (code) => (code === 0 ? resolve(o) : reject(new Error(`bench ${w} exited ${code}: ${e.slice(-300)}`))));
  });
  const after = cpuMs(child.pid);
  child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));
  const perf = JSON.parse(benchOut.trim().split('\n').pop());
  const wl = perf.workloads[0];
  const wall = wl.rounds.reduce((a, b) => a + b, 0);
  console.log(`${w.padEnd(6)} wall_total ${wall.toFixed(0)} ms  p50 ${wl.p50_ms} ms  server_cpu ${(after - before).toFixed(0)} ms  server_share ${(((after - before) / wall) * 100).toFixed(0)}%  ops ${wl.ops * 3 + 5}`);
}
