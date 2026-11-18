// The forge's HTTP server: routing, the request-id header, and the JSON
// envelope. The four surfaces live in their own modules; this file only
// dispatches to them.
//
// Routing order matters: git smart HTTP first (/{owner}/{repo}.git/...),
// then /api/v3 (REST), /api/graphql, /mcp, /healthz, and a JSON 404 for
// everything else.
//
// Every reply is JSON and carries a non-empty X-GitHub-Request-Id. Auth is
// enforced per surface (all four surfaces require the bearer token except
// /healthz, which takes none).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { makeCtx, parseJsonBody, readReq, splitPath, type Ctx, type Handler, type IncomingHeaders, type Req, type Resp } from './http.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git.ts';

/** Monotonic per-process request ids: the suite only requires the header to be
 * non-empty, and a counter avoids a crypto random draw on every request. */
let requestSeq = 0;

export function nextRequestId(): string {
  return `req-${(++requestSeq).toString(36)}`;
}

const JSON_TYPE = 'application/json; charset=utf-8';

/** The serialised body of a Resp plus the headers that carry it: the one
 * place that knows how a Resp becomes bytes, shared by both transports
 * (node:http's createApp and the raw-TCP server). `headOnly` is for HEAD
 * requests: the headers still carry the would-be body's length, but no body
 * bytes are sent. */
export function serializeResp(resp: Resp, requestId: string, headOnly = false): { status: number; headers: Record<string, string>; body: Buffer } {
  const headers: Record<string, string> = {
    'x-github-request-id': requestId,
    ...(resp.headers ?? {}),
  };
  let body: Buffer;
  if (resp.raw !== undefined) {
    headers['content-type'] = resp.contentType ?? 'application/octet-stream';
    body = resp.raw;
  } else if (resp.jsonText !== undefined) {
    // Already-serialized JSON (Store.issueJsonText): send as-is.
    body = Buffer.from(`${resp.jsonText}\n`, 'utf8');
    headers['content-type'] = resp.contentType ?? JSON_TYPE;
  } else {
    // One Buffer.from instead of JSON.stringify + a separate Buffer.byteLength
    // scan: the byte length is the buffer's length.
    body = Buffer.from(`${JSON.stringify(resp.body ?? null)}\n`, 'utf8');
    headers['content-type'] = resp.contentType ?? JSON_TYPE;
  }
  headers['content-length'] = String(body.length);
  return { status: resp.status, headers, body: headOnly ? Buffer.alloc(0) : body };
}

/** Build a Req from a method, a request-target, headers and a fully-read
 * body: the transport-independent half of request handling. One target split
 * per request: pathname and query come from the same parse. */
export function buildReq(method: string, target: string, headers: IncomingHeaders, rawBody: Buffer): Req {
  const { pathname, query } = splitTarget(target);
  const { json, jsonError } = parseJsonBody(rawBody, headers['content-type']);
  return {
    method,
    pathname,
    segments: splitPath(pathname),
    query,
    headers,
    rawBody,
    json,
    jsonError,
  };
}

/** Split a request-target into pathname + query without a URL object.
 * The fast path applies to the plain targets every client sends (`/api/v3/...`,
 * no escapes, no dot segments, no backslashes, no fragment): for those the
 * pathname is the bytes before the first `?` and the query is the rest, which
 * is exactly what `new URL(target, base)` reports. Anything unusual falls
 * back to the URL parser, so dot-segment resolution, backslash handling and
 * invalid-byte encoding keep their old behaviour. */
export function splitTarget(rawUrl: string): { pathname: string; query: URLSearchParams } {
  const plain =
    rawUrl.startsWith('/') &&
    rawUrl.indexOf('%') === -1 &&
    rawUrl.indexOf('\\') === -1 &&
    rawUrl.indexOf('#') === -1 &&
    rawUrl.indexOf('/./') === -1 &&
    rawUrl.indexOf('/../') === -1 &&
    !rawUrl.endsWith('/.') &&
    !rawUrl.endsWith('/..') &&
    // The URL parser percent-encodes these in a path (space, controls,
    // non-ASCII, `"`, `<`, `>`, backtick, `{`, `}`); anything carrying one
    // takes the slow path so its pathname stays identical.
    !/[^!-~]|["<>`{}]/.test(rawUrl);
  if (plain) {
    const q = rawUrl.indexOf('?');
    if (q === -1) return { pathname: rawUrl, query: new URLSearchParams() };
    return { pathname: rawUrl.slice(0, q), query: new URLSearchParams(rawUrl.slice(q + 1)) };
  }
  try {
    const url = new URL(rawUrl, 'http://entry');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

export function createApp(token: string): Server {
  const ctx: Ctx = makeCtx(token);
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = nextRequestId();
      const method = req.method ?? 'GET';
      const { rawBody } = await readReq(req);
      const fullReq: Req = buildReq(method, req.url ?? '/', req.headers, rawBody);
      let resp: Resp;
      try {
        resp = await route(fullReq, ctx);
      } catch (err) {
        resp = { status: 500, body: { message: err instanceof Error ? err.message : 'Internal Server Error' } };
      }
      try {
        const { status, headers, body } = serializeResp(resp, requestId);
        res.writeHead(status, headers);
        res.end(body);
      } catch {
        // The socket is gone; nothing to do.
      }
    })();
  });
}

export async function route(req: Req, ctx: Ctx): Promise<Resp> {
  const { method, pathname, segments } = req;

  // The env's boot probe: 200 {"ok":true}, no auth.
  if (method === 'GET' && pathname === '/healthz') {
    return { status: 200, body: { ok: true } };
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 2 && segments[1].endsWith('.git')) {
    return handleGit(req, ctx);
  }

  // REST v3 under /api/v3.
  if (segments[0] === 'api' && segments[1] === 'v3') {
    return handleRest(req, ctx);
  }

  // GraphQL v4.
  if (segments[0] === 'api' && segments[1] === 'graphql') {
    return handleGraphql(req, ctx);
  }

  // MCP.
  if (segments[0] === 'mcp') {
    return handleMcp(req, ctx);
  }

  return { status: 404, body: { message: 'Not Found' } };
}

// Keep the Handler type referenced for the surface modules.
export type { Handler };
