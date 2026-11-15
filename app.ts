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
import { randomUUID } from 'node:crypto';
import { makeCtx, readReq, splitPath, type Ctx, type Handler, type Req, type Resp } from './http.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendResp(res: ServerResponse, resp: Resp, requestId: string): void {
  const headers: Record<string, string> = {
    'x-github-request-id': requestId,
    ...(resp.headers ?? {}),
  };
  if (resp.raw !== undefined) {
    headers['content-type'] = resp.contentType ?? 'application/octet-stream';
    headers['content-length'] = String(resp.raw.length);
    res.writeHead(resp.status, headers);
    res.end(resp.raw);
    return;
  }
  const text = `${JSON.stringify(resp.body ?? null)}\n`;
  headers['content-type'] = resp.contentType ?? JSON_TYPE;
  headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(resp.status, headers);
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function createApp(token: string): Server {
  const ctx: Ctx = makeCtx(token);
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = randomUUID();
      const pathname = pathOf(req);
      const method = req.method ?? 'GET';
      let query = new URLSearchParams();
      try {
        query = new URL(req.url ?? '/', 'http://entry').searchParams;
      } catch {
        query = new URLSearchParams();
      }
      const { rawBody, json, jsonError } = await readReq(req);
      const fullReq: Req = {
        method,
        pathname,
        segments: splitPath(pathname),
        query,
        headers: req.headers,
        rawBody,
        json,
        jsonError,
      };
      let resp: Resp;
      try {
        resp = await route(fullReq, ctx);
      } catch (err) {
        resp = { status: 500, body: { message: err instanceof Error ? err.message : 'Internal Server Error' } };
      }
      try {
        sendResp(res, resp, requestId);
      } catch {
        // The socket is gone; nothing to do.
      }
    })();
  });
}

async function route(req: Req, ctx: Ctx): Promise<Resp> {
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
