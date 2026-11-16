// Shared HTTP plumbing for the forge's handlers.
//
// A handler receives a parsed Req and a Ctx and returns a Resp. app.ts owns
// the server, the routing table and the auth gate; the surface modules
// (rest.ts, graphql.ts, mcp.ts, git.ts) only implement their own routes.

import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { Store, VIEWER, type Viewer } from './store.ts';

export interface Ctx {
  store: Store;
  viewer: Viewer;
  /** The bearer token the suite presents (MAKEFUN_SHOP_TOKEN), or '' when unset. */
  token: string;
}

export function makeCtx(token: string): Ctx {
  return { store: new Store(), viewer: VIEWER, token };
}

export interface Req {
  method: string;
  pathname: string;
  segments: string[];
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  rawBody: Buffer;
  /** Parsed JSON body when the body is non-empty JSON; undefined when empty. */
  json: unknown;
  /** True when a non-empty body failed to parse as JSON. */
  jsonError: boolean;
}

export interface Resp {
  status: number;
  body?: unknown;
  raw?: Buffer;
  contentType?: string;
  headers?: Record<string, string>;
}

export type Handler = (req: Req, ctx: Ctx) => Promise<Resp>;

export function jsonResp(status: number, body: unknown, headers: Record<string, string> = {}): Resp {
  return { status, body, headers };
}

export function errResp(status: number, message: string): Resp {
  return { status, body: { message } };
}

/** The bearer token the request carries, or null. */
export function bearerToken(req: Req): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer (.+)$/.exec(h.trim());
  return m ? m[1] : null;
}

/** True when the request carries the suite's token (any non-empty bearer when no token is configured). */
export function authed(req: Req, ctx: Ctx): boolean {
  const t = bearerToken(req);
  if (t === null || t === '') return false;
  if (ctx.token !== '') return t === ctx.token;
  return true;
}

export function requireAuth(req: Req, ctx: Ctx): Resp | null {
  return authed(req, ctx) ? null : errResp(401, 'Requires authentication');
}

/** Parse the request body. Resolves once the body is fully read. JSON is only
 * attempted when the content type says JSON (or is absent): the git surfaces
 * post binary packfiles, and parsing those as JSON only ever throws. Every
 * JSON sender in the suite (REST, GraphQL, MCP, and the malformed-body check)
 * sends `application/json`, so the 400 for a malformed JSON body is unchanged. */
export function readReq(req: IncomingMessage): Promise<{ rawBody: Buffer; json: unknown; jsonError: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rawBody = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks);
      if (rawBody.length === 0) return resolve({ rawBody, json: undefined, jsonError: false });
      const ct = req.headers['content-type'];
      const tryJson = typeof ct !== 'string' || ct === '' || ct.includes('json');
      if (!tryJson) return resolve({ rawBody, json: undefined, jsonError: false });
      try {
        return resolve({ rawBody, json: JSON.parse(rawBody.toString('utf8')), jsonError: false });
      } catch {
        return resolve({ rawBody, json: undefined, jsonError: true });
      }
    });
    req.on('error', () => resolve({ rawBody: Buffer.alloc(0), json: undefined, jsonError: true }));
  });
}

export function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((s) => s !== '').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}
