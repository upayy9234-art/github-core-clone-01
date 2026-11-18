// Round-4 tests: the raw-TCP transport answers byte-identically to Node's
// http server for every request a well-behaved client sends, and handles the
// HTTP/1.1 framing the suite's clients rely on. Run with:
//   node --experimental-strip-types --test tests/round4.test.ts
//
// 1. Same request sequence on both transports -> same status, same body,
//    same content-type / content-length, non-empty x-github-request-id.
// 2. Pipelined requests on one socket answer in order.
// 3. Chunked request bodies, split bodies, Expect: 100-continue, HEAD,
//    Connection: close, and malformed requests behave like Node's parser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, type Socket } from 'node:net';
import { createApp } from '../app.ts';
import { createRawServer } from '../raw-server.ts';
import { VIEWER } from '../store.ts';

const TOKEN = 'shpat_round4test000000000000000000000000000000';
const OWNER = VIEWER.login;

type AnyServer = {
  listen(port: number, host: string, cb: () => void): void;
  address(): { port: number } | string | null;
  close(cb?: () => void): void;
};

async function start(server: AnyServer): Promise<{ port: number; stop: () => Promise<void> }> {
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') reject(new Error('no TCP address'));
      else resolve(address.port);
    });
  });
  return {
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        setTimeout(resolve, 2000).unref();
      }),
  };
}

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii'), data]);
}
const FLUSH = Buffer.from('0000', 'ascii');

/** One fetch against a port, returning the comparable facts. */
async function shot(port: number, path: string, init?: RequestInit) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  return {
    status: res.status,
    text,
    contentType: res.headers.get('content-type'),
    contentLength: res.headers.get('content-length'),
    requestId: res.headers.get('x-github-request-id'),
    connection: res.headers.get('connection'),
  };
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

/** The same state-changing sequence, run against one port; returns every response. */
async function sequence(port: number) {
  const out: Array<Awaited<ReturnType<typeof shot>>> = [];
  out.push(await shot(port, '/healthz'));
  out.push(await shot(port, '/nope'));
  out.push(await shot(port, '/api/v3/user'));
  out.push(
    await shot(port, '/api/v3/user/repos', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 't1' }),
    }),
  );
  out.push(
    await shot(port, `/api/v3/repos/${OWNER}/t1/issues`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ title: 'hello', body: 'world' }),
    }),
  );
  out.push(await shot(port, `/api/v3/repos/${OWNER}/t1/issues/1`, { headers: authHeaders() }));
  out.push(await shot(port, `/api/v3/repos/${OWNER}/t1/issues?state=all&per_page=100`, { headers: authHeaders() }));
  out.push(
    await shot(port, `/${OWNER}/t1.git/info/refs?service=git-upload-pack`, {
      headers: authHeaders({ 'git-protocol': 'version=2' }),
    }),
  );
  const lsRefsBody = Buffer.concat([
    pktLine('command=ls-refs\n'),
    pktLine('agent=round4-test/1.0\n'),
    FLUSH,
    pktLine('peel\n'),
    pktLine('symrefs\n'),
    FLUSH,
  ]);
  out.push(
    await shot(port, `/${OWNER}/t1.git/git-upload-pack`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2' }),
      body: lsRefsBody as unknown as BodyInit,
    }),
  );
  // A malformed JSON body must 400 on both transports.
  out.push(
    await shot(port, `/api/v3/repos/${OWNER}/t1/issues`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: '{not json',
    }),
  );
  return out;
}

test('raw TCP answers identically to node:http for the same sequence', async () => {
  const httpServer = createApp(TOKEN) as unknown as AnyServer;
  const rawServer = createRawServer(TOKEN) as unknown as AnyServer;
  const a = await start(httpServer);
  const b = await start(rawServer);
  try {
    const fromHttp = await sequence(a.port);
    const fromRaw = await sequence(b.port);
    assert.equal(fromRaw.length, fromHttp.length);
    for (let i = 0; i < fromHttp.length; i += 1) {
      const h = fromHttp[i];
      const r = fromRaw[i];
      assert.equal(r.status, h.status, `step ${i}: status`);
      assert.equal(r.text, h.text, `step ${i}: body`);
      assert.equal(r.contentType, h.contentType, `step ${i}: content-type`);
      assert.equal(r.contentLength, h.contentLength, `step ${i}: content-length`);
      assert.ok(r.requestId !== null && r.requestId !== '', `step ${i}: request id present`);
    }
  } finally {
    await a.stop();
    await b.stop();
  }
});

/** Read from a raw socket until `done(accumulated)` is true or it times out. */
function readUntil(socket: Socket, done: (buf: Buffer) => boolean, timeoutMs = 5000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let acc = Buffer.alloc(0);
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`timed out waiting; got ${JSON.stringify(acc.toString('latin1'))}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      acc = Buffer.concat([acc, chunk]);
      if (done(acc) && !settled) {
        settled = true;
        cleanup();
        resolve(acc);
      }
    };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(acc);
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
  });
}

function countResponses(buf: Buffer): number {
  return buf.toString('latin1').split('HTTP/1.1 ').length - 1;
}

test('raw TCP: pipelined requests answer in order on one socket', async () => {
  const rawServer = createRawServer(TOKEN) as unknown as AnyServer;
  const s = await start(rawServer);
  try {
    const socket = connect(s.port, '127.0.0.1');
    socket.write('GET /healthz HTTP/1.1\r\nhost: x\r\n\r\nGET /nope HTTP/1.1\r\nhost: x\r\n\r\n');
    const res = await readUntil(socket, (b) => countResponses(b) >= 2);
    const text = res.toString('latin1');
    assert.match(text, /HTTP\/1\.1 200 OK/);
    assert.match(text, /HTTP\/1\.1 404 Not Found/);
    assert.ok(text.indexOf('200 OK') < text.indexOf('404 Not Found'), 'responses in order');
    socket.destroy();
  } finally {
    await s.stop();
  }
});

test('raw TCP: chunked body, split body, 100-continue, HEAD, close, malformed', async () => {
  const rawServer = createRawServer(TOKEN) as unknown as AnyServer;
  const s = await start(rawServer);
  try {
    // Chunked POST creates the issue.
    {
      const socket = connect(s.port, '127.0.0.1');
      const body = JSON.stringify({ title: 'chunked', body: 'b' });
      const chunks = `POST /api/v3/repos/${OWNER}/t1/issues HTTP/1.1\r\nhost: x\r\nauthorization: Bearer ${TOKEN}\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`;
      // No repo t1 on this fresh server: expect 404, but the chunked framing must parse.
      socket.write(chunks);
      const res = await readUntil(socket, (b) => countResponses(b) >= 1);
      assert.match(res.toString('latin1'), /HTTP\/1\.1 404 Not Found/);
      socket.destroy();
    }
    // Body split across two writes.
    {
      const socket = connect(s.port, '127.0.0.1');
      const body = JSON.stringify({ name: 'split' });
      socket.write(
        `POST /api/v3/user/repos HTTP/1.1\r\nhost: x\r\nauthorization: Bearer ${TOKEN}\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body.slice(0, 8)}`,
      );
      await new Promise((r) => setTimeout(r, 50));
      socket.write(body.slice(8));
      const res = await readUntil(socket, (b) => countResponses(b) >= 1);
      assert.match(res.toString('latin1'), /HTTP\/1\.1 201 Created/);
      socket.destroy();
    }
    // Expect: 100-continue.
    {
      const socket = connect(s.port, '127.0.0.1');
      const body = JSON.stringify({ title: 'cont', body: 'b' });
      socket.write(
        `POST /api/v3/repos/${OWNER}/split/issues HTTP/1.1\r\nhost: x\r\nauthorization: Bearer ${TOKEN}\r\ncontent-type: application/json\r\nexpect: 100-continue\r\ncontent-length: ${body.length}\r\n\r\n`,
      );
      const interim = await readUntil(socket, (b) => b.toString('latin1').includes('100 Continue'));
      assert.match(interim.toString('latin1'), /HTTP\/1\.1 100 Continue/);
      socket.write(body);
      const res = await readUntil(socket, (b) => countResponses(b) >= 1);
      assert.match(res.toString('latin1'), /HTTP\/1\.1 201 Created/);
      socket.destroy();
    }
    // HEAD: the route only matches GET, so HEAD /healthz is a 404 exactly
    // like on node:http — but the headers still carry the would-be body's
    // length and no body bytes are sent.
    {
      const socket = connect(s.port, '127.0.0.1');
      socket.write('HEAD /healthz HTTP/1.1\r\nhost: x\r\n\r\n');
      const res = await readUntil(socket, (b) => b.toString('latin1').includes('\r\n\r\n'));
      const text = res.toString('latin1');
      assert.match(text, /HTTP\/1\.1 404 Not Found/);
      assert.match(text, /content-length: 24/);
      assert.equal(text.split('\r\n\r\n')[1] ?? '', '');
      socket.destroy();
    }
    // Connection: close.
    {
      const socket = connect(s.port, '127.0.0.1');
      socket.write('GET /healthz HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n');
      const res = await readUntil(socket, (b) => countResponses(b) >= 1);
      assert.match(res.toString('latin1'), /connection: close/);
      socket.destroy();
    }
    // Malformed request line -> 400 and the socket closes.
    {
      const socket = connect(s.port, '127.0.0.1');
      socket.write('GARBAGE\r\n\r\n');
      const res = await readUntil(socket, (b) => b.toString('latin1').includes('400'));
      assert.match(res.toString('latin1'), /HTTP\/1\.1 400 Bad Request/);
      socket.destroy();
    }
  } finally {
    await s.stop();
  }
});
