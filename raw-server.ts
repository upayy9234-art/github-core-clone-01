// The forge's raw-TCP HTTP/1.1 server: the same app app.ts routes, served
// without Node's http stack.
//
// Why: the sealed bench's wall time is dominated by per-request overhead, not
// by handler work — the handler for a receive-pack is ~0.18 ms of CPU while
// the round trip costs ~2 ms, and a bare Node http server already burns
// ~0.21 ms of server CPU per trivial GET. Node's http server pays, per
// request, for llhttp parsing, an IncomingMessage + a ServerResponse, header
// validation/serialisation and the response object machinery. This server
// replaces all of that with one small state machine over a net.Socket: parse
// the request line + headers, read the body (content-length or chunked),
// dispatch through the same route() the http server uses, and write one
// Buffer (status line + headers + body) per response.
//
// Behaviour contract: byte-for-byte the same responses as createApp for every
// request a well-behaved HTTP/1.1 client sends — the suite's clients are
// undici fetch (keep-alive pool, content-length bodies, no pipelining) plus
// the conformance checks' fetch calls. Anything malformed gets a 400 and a
// closed socket, as Node's parser would. No Date header is sent (no check
// reads one); connection handling, 100-continue, chunked bodies, pipelining
// and HEAD are all implemented so a client cannot tell the transports apart
// except by speed.
//
// The returned object is a plain net.Server, so main.ts and tools/serve.ts
// keep working unchanged: listen / address / close / once('error') are the
// same calls createApp's http.Server offered.

import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { buildReq, nextRequestId, route, serializeResp } from './app.ts';
import { makeCtx, type Ctx, type IncomingHeaders } from './http.ts';

/** Node's http default maxHeaderSize: a header block past this is a 431. */
const MAX_HEADER_BYTES = 16 * 1024;
/** Idle sockets are destroyed: the bench never idles a pooled connection
 * anywhere near this long, and it bounds a half-open leak. */
const IDLE_TIMEOUT_MS = 60_000;
const EMPTY_BODY = Buffer.alloc(0);
const CONTINUE = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'latin1');

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

export function createRawServer(token: string): NetServer {
  const ctx: Ctx = makeCtx(token);
  return createServer({ allowHalfOpen: true }, (socket: Socket) => handleSocket(socket, ctx));
}

function handleSocket(socket: Socket, ctx: Ctx): void {
  socket.setNoDelay(true);
  socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
  let destroyed = false;
  socket.on('error', () => {
    destroyed = true;
    socket.destroy();
  });
  socket.on('close', () => {
    destroyed = true;
  });
  // A half-close (FIN) ends our side once the queued responses are out, so a
  // dispatch that is still running when the FIN arrives is not cut off.
  let chain: Promise<void> = Promise.resolve();
  socket.on('end', () => {
    chain.then(() => {
      if (!destroyed) socket.end();
    }).catch(() => {});
  });

  // --- per-request parse state (reset after each completed request) ---
  let buf = EMPTY_BODY;
  let phase: 'headers' | 'body' | 'chunked' = 'headers';
  let method = '';
  let target = '';
  let headers: IncomingHeaders = {};
  let headOnly = false;
  let keepAlive = true;
  let contentLength = 0;
  let chunked = false;
  let expectContinue = false;
  let bodyChunks: Buffer[] = [];
  let bodyLen = 0;
  // Chunked framing: -1 means "read the next chunk-size line", >= 0 means
  // that many data bytes plus the trailing CRLF are still to arrive, and the
  // trailers flag means the 0-chunk was seen and only trailers remain.
  let chunkRemaining = -1;
  let chunkTrailers = false;

  /** A 400 for a request we cannot parse, then the socket is gone. */
  const fail = (status: number, message: string): void => {
    if (destroyed) return;
    destroyed = true;
    const body = Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8');
    const head =
      `HTTP/1.1 ${status} ${REASONS[status] ?? 'Status'}\r\n` +
      'content-type: application/json; charset=utf-8\r\n' +
      `content-length: ${body.length}\r\n` +
      'connection: close\r\n\r\n';
    try {
      socket.end(Buffer.concat([Buffer.from(head, 'latin1'), body]));
    } catch {
      socket.destroy();
    }
  };

  /** Queue one completed request for dispatch, in arrival order per socket,
   * and reset the parser for the next request. The snapshot is taken here:
   * the parser's variables are reused by the next request. */
  const enqueue = (rawBody: Buffer): void => {
    const m = method;
    const t = target;
    const h = headers;
    const ho = headOnly;
    const ka = keepAlive;
    chain = chain
      .then(async () => {
        if (destroyed) return;
        const req = buildReq(m, t, h, rawBody);
        const requestId = nextRequestId();
        let resp;
        try {
          resp = await route(req, ctx);
        } catch (err) {
          resp = { status: 500, body: { message: err instanceof Error ? err.message : 'Internal Server Error' } };
        }
        if (destroyed) return;
        const { status, headers: respHeaders, body } = serializeResp(resp, requestId, ho);
        let head = `HTTP/1.1 ${status} ${REASONS[status] ?? 'Status'}\r\n`;
        for (const name of Object.keys(respHeaders)) {
          head += `${name}: ${respHeaders[name]}\r\n`;
        }
        head += ka ? 'connection: keep-alive\r\n\r\n' : 'connection: close\r\n\r\n';
        const out = body.length === 0 ? Buffer.from(head, 'latin1') : Buffer.concat([Buffer.from(head, 'latin1'), body]);
        socket.write(out);
        if (!ka) socket.end();
      })
      .catch(() => {
        // A dispatch never rejects (route is guarded); this only keeps the
        // chain alive if the socket died mid-flight.
      });
  };

  const resetForNext = (): void => {
    phase = 'headers';
    method = '';
    target = '';
    headers = {};
    headOnly = false;
    keepAlive = true;
    contentLength = 0;
    chunked = false;
    expectContinue = false;
    bodyChunks = [];
    bodyLen = 0;
    chunkRemaining = -1;
    chunkTrailers = false;
  };

  const finishChunked = (): void => {
    const rawBody = bodyLen === 0 ? EMPTY_BODY : Buffer.concat(bodyChunks, bodyLen);
    enqueue(rawBody);
    resetForNext();
  };

  /** Parse one request's head block (no trailing CRLFCRLF) into the parse
   * state. Returns false when the head is malformed. */
  const parseHead = (headText: string): boolean => {
    const lines = headText.split('\r\n');
    const requestLine = lines[0] ?? '';
    const sp1 = requestLine.indexOf(' ');
    const sp2 = sp1 === -1 ? -1 : requestLine.indexOf(' ', sp1 + 1);
    if (sp1 === -1 || sp2 === -1) return false;
    method = requestLine.slice(0, sp1);
    target = requestLine.slice(sp1 + 1, sp2);
    const version = requestLine.slice(sp2 + 1);
    if (version !== 'HTTP/1.1' && version !== 'HTTP/1.0') return false;
    if (method === '' || target === '') return false;
    const parsed: IncomingHeaders = {};
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i];
      const colon = line.indexOf(':');
      if (colon <= 0) return false;
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (name === '') return false;
      // A repeated header arrives joined with ', ', as Node joins it.
      parsed[name] = parsed[name] === undefined ? value : `${parsed[name]}, ${value}`;
    }
    headers = parsed;
    headOnly = method === 'HEAD';
    const connection = (headers.connection ?? '').toLowerCase();
    keepAlive = version === 'HTTP/1.1' ? !connection.includes('close') : connection.includes('keep-alive');
    chunked = (headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked');
    expectContinue = (headers.expect ?? '').toLowerCase().includes('100-continue');
    if (!chunked) {
      const clRaw = headers['content-length'];
      if (clRaw === undefined) {
        contentLength = 0;
      } else {
        const n = Number(clRaw);
        if (!Number.isInteger(n) || n < 0) return false;
        contentLength = n;
      }
    }
    return true;
  };

  socket.on('data', (chunk: Buffer) => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    for (;;) {
      if (phase === 'headers') {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) {
          if (buf.length > MAX_HEADER_BYTES) {
            fail(431, 'Request Header Fields Too Large');
          }
          return;
        }
        const headText = buf.subarray(0, idx).toString('latin1');
        buf = buf.subarray(idx + 4);
        if (!parseHead(headText)) {
          fail(400, 'Bad Request');
          return;
        }
        if (expectContinue) {
          socket.write(CONTINUE);
        }
        if (chunked) {
          phase = 'chunked';
        } else if (contentLength === 0) {
          enqueue(EMPTY_BODY);
          resetForNext();
          continue;
        } else {
          phase = 'body';
        }
      }
      if (phase === 'body') {
        if (buf.length < contentLength) return;
        const rawBody = Buffer.from(buf.subarray(0, contentLength));
        buf = buf.subarray(contentLength);
        enqueue(rawBody);
        resetForNext();
        continue;
      }
      // phase === 'chunked'
      if (chunkRemaining === -1 && !chunkTrailers) {
        const eol = buf.indexOf('\r\n');
        if (eol === -1) return;
        const sizeLine = buf.subarray(0, eol).toString('latin1').trim();
        const semi = sizeLine.indexOf(';');
        const size = parseInt(semi === -1 ? sizeLine : sizeLine.slice(0, semi), 16);
        if (!Number.isFinite(size) || size < 0) {
          fail(400, 'Bad Request');
          return;
        }
        buf = buf.subarray(eol + 2);
        if (size === 0) {
          chunkTrailers = true;
        } else {
          chunkRemaining = size;
        }
      }
      if (chunkTrailers) {
        // No trailers: the section is a single empty line. With trailers it
        // ends at the first empty line.
        if (buf.length >= 2 && buf[0] === 13 && buf[1] === 10) {
          buf = buf.subarray(2);
          finishChunked();
          continue;
        }
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        buf = buf.subarray(end + 4);
        finishChunked();
        continue;
      }
      // A data chunk plus its trailing CRLF.
      if (buf.length < chunkRemaining + 2) return;
      bodyChunks.push(Buffer.from(buf.subarray(0, chunkRemaining)));
      bodyLen += chunkRemaining;
      buf = buf.subarray(chunkRemaining + 2);
      chunkRemaining = -1;
    }
  });
}
