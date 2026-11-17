// CPU-profile the server during one sealed bench run (local only).
//
//   node tools/cpu-profile.mjs --dir <serverDir> [--rounds 3] [--workloads push,clone,read,write] [--out bench-results/profile]
//
// Starts the server with --cpu-prof, runs the sealed benchmark once, kills
// the server, then aggregates the .cpuprofile samples by (script, function)
// and prints the top self-time functions. This answers "where does server
// CPU actually go per workload" instead of guessing.

import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN = 'shpat_localtest00000000000000000000000000000000';
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
const dir = arg('--dir', process.cwd());
const rounds = arg('--rounds', '3');
const workloads = arg('--workloads', '');
const outDir = arg('--out', 'bench-results/profile');
mkdirSync(outDir, { recursive: true });
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

const child = spawn('node', ['--cpu-prof', '--cpu-prof-dir', outDir, '--experimental-strip-types', 'tools/serve.ts'], {
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
  child.stderr.on('data', (c) => process.stderr.write(`[server] ${c}`));
  setTimeout(() => reject(new Error('no PORT printed')), 15000);
});
if (!(await waitHealth(port))) throw new Error('no /healthz');
const benchArgs = ['--experimental-strip-types', 'tools/run-bench.ts', '--url', `http://127.0.0.1:${port}`, '--token', TOKEN, '--rounds', rounds];
if (workloads) benchArgs.push('--workloads', workloads);
await new Promise((resolve, reject) => {
  const b = spawn('node', benchArgs, { cwd: dir, stdio: 'inherit' });
  b.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`bench exited ${code}`))));
});
child.kill('SIGTERM');
await new Promise((r) => child.on('exit', r));
await sleep(500);

// Parse the newest .cpuprofile in outDir.
const files = readdirSync(outDir).filter((f) => f.endsWith('.cpuprofile')).map((f) => join(outDir, f));
if (files.length === 0) { process.stderr.write('no .cpuprofile written\n'); process.exit(1); }
const prof = JSON.parse(readFileSync(files.sort().pop(), 'utf8'));
const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
const counts = new Map();
for (const id of prof.samples) {
  const node = nodes.get(id);
  if (!node) continue;
  const fn = node.callFrame.functionName || '(anonymous)';
  const url = node.callFrame.url.split('/').slice(-2).join('/');
  const key = `${url} :: ${fn}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
const total = prof.samples.length;
console.log(`\nCPU profile: ${total} samples (${(total * 1).toFixed(0)} ms @ ~1ms/sample) — top self-time:`);
for (const [key, n] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
  console.log(`${((n / total) * 100).toFixed(1).padStart(5)}%  ${n}  ${key}`);
}
