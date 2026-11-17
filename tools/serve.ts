// Local-only server launcher for benching (NOT part of the graded entry).
//
//   LOCAL_PORT=0 LOCAL_TOKEN=shpat_test node --experimental-strip-types tools/serve.ts
//
// Listens on an ephemeral port (or $LOCAL_PORT), prints `PORT <n>` on stdout
// once listening, and serves the forge from ./app.ts. The graded entry point
// is main.ts (MAKEFUN_ENV_URL lifecycle); this file exists so a bench driver
// can start/stop the server per repetition without the env.

import { createApp } from '../app.ts';

const token = process.env.LOCAL_TOKEN ?? 'shpat_localtest00000000000000000000000000000000';
const port = Number(process.env.LOCAL_PORT ?? 0);
const server = createApp(token);
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP address');
  process.stdout.write(`PORT ${address.port}\n`);
});
// Graceful shutdown so --cpu-prof flushes its .cpuprofile on exit.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
