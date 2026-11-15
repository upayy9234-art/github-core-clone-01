// MCP (Model Context Protocol) surface: JSON-RPC 2.0 over Streamable HTTP.
//
// POST /mcp only (DELETE closes a session, best effort). Single JSON body
// responses, never SSE. All domain work goes through the shared Store, so
// MCP, REST, GraphQL and git always agree.

import { jsonResp, errResp, requireAuth, bearerToken, type Req, type Resp, type Ctx } from './http.ts';
import { Store, VIEWER, type Repo, type Issue, type PullRequest } from './store.ts';

// Keep bearerToken referenced (auth is enforced via requireAuth below, which
// uses it internally); the import is part of the module contract.
void bearerToken;
void Store;

const SUPPORTED_VERSIONS: string[] = ['2026-07-28', '2025-11-25'];
const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

// Fixed tool catalogue: same order, same content, every call.
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        private: { type: 'boolean' },
        owner: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        full_name: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'integer' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by owner, repository and issue number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        issue_number: { type: 'integer' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
] as const;

// ---------------------------------------------------------------- helpers
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasValue(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

/** Recover a request id from a raw (possibly malformed) body, per the spec. */
function recoverId(raw: Buffer): unknown {
  try {
    const text = raw.toString('utf8');
    const m = /"id"\s*:\s*(\d+|"[^"]*")/.exec(text);
    if (!m) return null;
    const cap = m[1];
    if (cap.startsWith('"')) return JSON.parse(cap) as unknown;
    const n = Number(cap);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function textResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function textError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArg(arg: string): Record<string, unknown> {
  return textError(`Missing required argument: ${arg}`);
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function asInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    if (Number.isInteger(n)) return n;
  }
  return undefined;
}

function asBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  if (typeof v === 'number') return v !== 0;
  return false;
}

/** Pick the first present synonym for a canonical argument name. */
function pickArg(args: Record<string, unknown>, names: string[]): unknown {
  for (const n of names) {
    if (hasValue(args[n])) return args[n];
  }
  return undefined;
}

const SYNONYMS: Record<string, string[]> = {
  name: ['name', 'repo', 'repository', 'repository_name', 'repo_name'],
  description: ['description', 'about', 'summary'],
  private: ['private', 'is_private'],
  owner: ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'],
  repo: ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'],
  title: ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'],
  body: ['body', 'issue_body', 'description', 'content', 'text', 'comment'],
  state: ['state', 'status'],
  head: ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch'],
  base: ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch'],
  pull_number: ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'],
  issue_number: ['issue_number', 'number', 'index', 'issue'],
  full_name: ['full_name', 'fullName', 'fullname'],
};

function canonicalArgs(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = pickArg(args, SYNONYMS[k] ?? [k]);
    if (v !== undefined) out[k] = v;
  }
  // full_name fallback for owner/repo.
  const full = asString(pickArg(args, SYNONYMS.full_name));
  if (full && full.includes('/')) {
    const [o, r] = full.split('/', 2);
    if (!hasValue(out.owner) && o) out.owner = o;
    if (!hasValue(out.repo) && r) out.repo = r;
  }
  return out;
}

function resolveRepo(ctx: Ctx, owner: unknown, repoName: unknown): Repo | undefined {
  const o = asString(owner);
  const r = asString(repoName);
  if (!o || !r) return undefined;
  return ctx.store.getRepo(o, r);
}

// ---------------------------------------------------------------- tools
const CANONICAL_TOOLS: Array<{ name: string; norm: string }> = [
  { name: 'create_repo', norm: 'createrepo' },
  { name: 'get_repo', norm: 'getrepo' },
  { name: 'create_issue', norm: 'createissue' },
  { name: 'list_issues', norm: 'listissues' },
  { name: 'create_pull_request', norm: 'createpullrequest' },
  { name: 'merge_pull_request', norm: 'mergepullrequest' },
  { name: 'get_issue', norm: 'getissue' },
];

function matchTool(rawName: string): string | null {
  const norm = normalizeName(rawName);
  if (!norm) return null;
  // Exact match first.
  for (const t of CANONICAL_TOOLS) {
    if (norm === t.norm) return t.name;
  }
  // Suffix match (e.g. 'githubcreateissue' ends with 'createissue'); prefer
  // the longest canonical name on a tie.
  let best: string | null = null;
  let bestLen = 0;
  for (const t of CANONICAL_TOOLS) {
    if (norm.endsWith(t.norm) && t.norm.length > bestLen) {
      best = t.name;
      bestLen = t.norm.length;
    }
  }
  return best;
}

function callTool(canonical: string, rawArgs: Record<string, unknown>, ctx: Ctx): Record<string, unknown> {
  const store = ctx.store;
  const viewerLogin = ctx.viewer?.login ?? VIEWER.login;

  if (canonical === 'create_repo') {
    const args = canonicalArgs(rawArgs, ['name', 'description', 'private', 'owner']);
    const name = asString(args.name);
    if (!name) return missingArg('name');
    const description = asString(args.description) ?? '';
    const repo = store.createRepo(name, description, asBool(args.private));
    if (!repo) return textError('Repository already exists');
    return textResult(store.repoJson(repo));
  }

  if (canonical === 'get_repo') {
    const args = canonicalArgs(rawArgs, ['owner', 'repo', 'full_name']);
    if (!hasValue(args.owner)) return missingArg('owner');
    if (!hasValue(args.repo)) return missingArg('repo');
    const repo = resolveRepo(ctx, args.owner, args.repo);
    if (!repo) return textError(`Repository not found: ${String(args.owner)}/${String(args.repo)}`);
    return textResult(store.repoJson(repo));
  }

  if (canonical === 'create_issue') {
    const args = canonicalArgs(rawArgs, ['owner', 'repo', 'title', 'body']);
    if (!hasValue(args.owner)) return missingArg('owner');
    if (!hasValue(args.repo)) return missingArg('repo');
    if (!hasValue(args.title)) return missingArg('title');
    const repo = resolveRepo(ctx, args.owner, args.repo);
    if (!repo) return textError(`Repository not found: ${String(args.owner)}/${String(args.repo)}`);
    const labels: string[] = Array.isArray(rawArgs.labels)
      ? (rawArgs.labels as unknown[]).filter((l): l is string => typeof l === 'string')
      : [];
    const issue = store.createIssue(repo, String(args.title), asString(args.body) ?? '', labels);
    if (isRecord(issue) && 'error' in issue) {
      return textError(`Bad label: ${String((issue as Record<string, unknown>).label ?? '')}`);
    }
    const iss = issue as Issue;
    return textResult({
      number: iss.number,
      id: store.issueGlobalId(repo, iss),
      title: iss.title,
      state: 'open',
      url: `https://github.com/${repo.owner}/${repo.name}/issues/${iss.number}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${iss.number}`,
    });
  }

  if (canonical === 'list_issues') {
    const args = canonicalArgs(rawArgs, ['owner', 'repo', 'state']);
    if (!hasValue(args.owner)) return missingArg('owner');
    if (!hasValue(args.repo)) return missingArg('repo');
    const repo = resolveRepo(ctx, args.owner, args.repo);
    if (!repo) return textError(`Repository not found: ${String(args.owner)}/${String(args.repo)}`);
    const state = asString(args.state);
    const issues = store.listIssues(repo, { state });
    return textResult(
      issues.map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        id: store.issueGlobalId(repo, i),
      })),
    );
  }

  if (canonical === 'create_pull_request') {
    const args = canonicalArgs(rawArgs, ['owner', 'repo', 'title', 'body', 'head', 'base']);
    if (!hasValue(args.owner)) return missingArg('owner');
    if (!hasValue(args.repo)) return missingArg('repo');
    if (!hasValue(args.title)) return missingArg('title');
    if (!hasValue(args.head)) return missingArg('head');
    if (!hasValue(args.base)) return missingArg('base');
    const repo = resolveRepo(ctx, args.owner, args.repo);
    if (!repo) return textError(`Repository not found: ${String(args.owner)}/${String(args.repo)}`);
    const pr = store.createPR(repo, String(args.title), asString(args.body) ?? '', String(args.head), String(args.base));
    if (isRecord(pr) && 'error' in pr) {
      return textError(`Missing branch: ${String(args.head)} or ${String(args.base)} does not exist`);
    }
    const p = pr as PullRequest;
    return textResult({
      number: p.number,
      id: store.prGlobalId(repo, p),
      title: p.title,
      state: 'open',
      head: { ref: p.headRef, sha: p.headSha },
      base: { ref: p.baseRef, sha: p.baseSha },
    });
  }

  if (canonical === 'merge_pull_request') {
    const args = canonicalArgs(rawArgs, ['owner', 'repo', 'pull_number']);
    if (!hasValue(args.owner)) return missingArg('owner');
    if (!hasValue(args.repo)) return missingArg('repo');
    const pullNumber = asInt(args.pull_number);
    if (pullNumber === undefined) return missingArg('pull_number');
    const repo = resolveRepo(ctx, args.owner, args.repo);
    if (!repo) return textError(`Repository not found: ${String(args.owner)}/${String(args.repo)}`);
    const pr = store.getPR(repo, pullNumber);
    if (!pr) return textError(`Pull request not found: #${pullNumber}`);
    const merged = store.mergePR(repo, pr);
    if (isRecord(merged) && 'error' in merged) {
      const err = String((merged as Record<string, unknown>).error ?? 'conflict');
      if (err === 'already') return textError('Pull request is already merged or closed');
      return textError(`Merge conflict: pull request #${pullNumber} cannot be merged cleanly`);
    }
    const sha = String((merged as Record<string, unknown>).sha ?? '');
    return textResult({ number: pr.number, merged: true, state: 'closed', sha, merge_commit_sha: sha });
  }

  if (canonical === 'get_issue') {
    const args = canonicalArgs(rawArgs, ['owner', 'repo', 'issue_number']);
    if (!hasValue(args.owner)) return missingArg('owner');
    if (!hasValue(args.repo)) return missingArg('repo');
    const issueNumber = asInt(args.issue_number);
    if (issueNumber === undefined) return missingArg('issue_number');
    const repo = resolveRepo(ctx, args.owner, args.repo);
    if (!repo) return textError(`Repository not found: ${String(args.owner)}/${String(args.repo)}`);
    const issue = store.getIssue(repo, issueNumber);
    if (!issue) return textError(`Issue not found: #${issueNumber}`);
    return textResult(store.issueJson(repo, issue));
  }

  // Unreachable: matchTool only returns canonical names above.
  return textError(`Unknown tool: ${canonical}`);
}

// ---------------------------------------------------------------- dispatch
function handleRpcObject(body: Record<string, unknown>, ctx: Ctx): Resp {
  const hasId = Object.prototype.hasOwnProperty.call(body, 'id') && body.id !== null && body.id !== undefined;
  const id: unknown = hasId ? body.id : null;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = isRecord(body.params) ? body.params : {};

  // Notifications (no id) never get a JSON-RPC result.
  if (!hasId) {
    return jsonResp(202, {});
  }

  try {
    if (method === 'server/discover') {
      return jsonResp(200, rpcResult(id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      }));
    }

    if (method === 'initialize') {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
      if (offered !== undefined && !SUPPORTED_VERSIONS.includes(offered)) {
        return jsonResp(200, rpcError(id, -32022, `Unsupported protocol version: ${offered}`, {
          supported: [...SUPPORTED_VERSIONS],
          supportedVersions: [...SUPPORTED_VERSIONS],
        }));
      }
      const protocolVersion = offered ?? SUPPORTED_VERSIONS[0];
      return jsonResp(200, rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      }));
    }

    if (method === 'notifications/initialized') {
      return jsonResp(202, {});
    }

    if (method === 'ping') {
      return jsonResp(200, rpcResult(id, {}));
    }

    if (method === 'tools/list') {
      return jsonResp(200, rpcResult(id, { tools: TOOLS }));
    }

    if (method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const canonical = name ? matchTool(name) : null;
      if (!canonical) {
        return jsonResp(200, rpcError(id, -32602, `Unknown tool: ${name}`));
      }
      const result = callTool(canonical, args, ctx);
      return jsonResp(200, rpcResult(id, result));
    }

    if (method.startsWith('notifications/')) {
      return jsonResp(202, {});
    }

    return jsonResp(200, rpcError(id, -32601, 'Method not found'));
  } catch (err) {
    return jsonResp(200, rpcError(id, -32603, err instanceof Error ? err.message : 'Internal error'));
  }
}

export async function handleMcp(req: Req, ctx: Ctx): Promise<Resp> {
  // Session close: best effort, no auth required.
  if (req.method === 'DELETE') {
    return jsonResp(200, { ok: true });
  }
  if (req.method !== 'POST') {
    return errResp(404, 'Not Found');
  }

  // Parse-error check first: body must be JSON and an object or array.
  if (req.jsonError || req.json === undefined || req.json === null || typeof req.json !== 'object') {
    return jsonResp(400, {
      jsonrpc: '2.0',
      id: recoverId(req.rawBody),
      error: { code: -32700, message: 'Parse error' },
    });
  }

  // Auth: every POST requires the bearer token.
  const auth = requireAuth(req, ctx);
  if (auth) return auth;

  // Batch array: answer each element, skip notifications.
  if (Array.isArray(req.json)) {
    if (req.json.length === 0) {
      return jsonResp(400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
    }
    const responses: unknown[] = [];
    for (const el of req.json) {
      if (!isRecord(el)) {
        responses.push(rpcError(null, -32600, 'Invalid Request'));
        continue;
      }
      const resp = handleRpcObject(el, ctx);
      if (resp.status !== 202) responses.push(resp.body);
    }
    return jsonResp(200, responses);
  }

  return handleRpcObject(req.json as Record<string, unknown>, ctx);
}
