// REST v3 surface: /api/v3/* — see SPEC-rest.md.
// All routes require auth. All replies JSON. Errors {message}.

import { jsonResp, errResp, requireAuth, type Req, type Resp, type Ctx } from './http.ts';
import { VIEWER, parseCommit, serializeCommit, type Store, type Repo } from './store.ts';

type Body = Record<string, unknown>;

function bodyOf(req: Req): Body {
  if (req.json && typeof req.json === 'object' && !Array.isArray(req.json)) {
    return req.json as Body;
  }
  return {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function intParam(v: string | null, fallback: number): number {
  const n = v === null ? NaN : parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function labelNames(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') out.push(item);
    else if (item && typeof item === 'object' && typeof (item as Body).name === 'string') {
      out.push((item as Body).name as string);
    }
  }
  return out;
}

function paginate<T>(items: T[], req: Req): { page: T[]; link: string | null } {
  const perPage = intParam(req.query.get('per_page'), 30);
  const page = intParam(req.query.get('page'), 1);
  const total = items.length;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < total) {
    const host = typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : 'localhost';
    const base = `http://${host}${req.pathname}`;
    const last = Math.max(1, Math.ceil(total / perPage));
    const nextUrl = `${base}?per_page=${perPage}&page=${page + 1}`;
    const lastUrl = `${base}?per_page=${perPage}&page=${last}`;
    link = `<${nextUrl}>; rel="next", <${lastUrl}>; rel="last"`;
  }
  return { page: slice, link };
}

function linkHeaders(link: string | null): Record<string, string> {
  return link ? { link } : {};
}

export async function handleRest(req: Req, ctx: Ctx): Promise<Resp> {
  const store: Store = ctx.store;

  // Every /api/v3 route requires the bearer token.
  const auth = requireAuth(req, ctx);
  if (auth) return auth;

  // Malformed JSON body on any route with a body.
  if (req.jsonError && req.method !== 'GET' && req.method !== 'HEAD') {
    return errResp(400, 'Malformed JSON body');
  }

  const segments = req.segments; // ['api', 'v3', ...rest]
  const rest = segments.slice(2);
  const method = req.method;
  const body = bodyOf(req);

  // GET /api/v3/ (or /api/v3)
  if (rest.length === 0) {
    if (method !== 'GET') return errResp(404, 'Not Found');
    return jsonResp(200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return errResp(404, 'Not Found');
    return jsonResp(200, { installed_version: '1.0.0' });
  }

  // /api/v3/user...
  if (rest[0] === 'user') {
    if (rest.length === 1) {
      if (method !== 'GET') return errResp(404, 'Not Found');
      return jsonResp(200, {
        login: ctx.viewer.login,
        id: ctx.viewer.id,
        name: ctx.viewer.name,
        email: ctx.viewer.email,
        type: 'User',
      });
    }
    if (rest.length === 2 && rest[1] === 'repos') {
      if (method === 'POST') {
        const name = str(body.name);
        if (!name) return errResp(422, 'name is required');
        const repo = store.createRepo(name, str(body.description) ?? '', body.private === true);
        if (!repo) return errResp(422, `Repository '${name}' already exists`);
        return jsonResp(201, store.repoJson(repo));
      }
      if (method === 'GET') {
        const all = store.listRepos();
        const { page, link } = paginate(all, req);
        return jsonResp(200, page.map((r) => store.repoJson(r)), linkHeaders(link));
      }
      return errResp(404, 'Not Found');
    }
    return errResp(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (rest[0] === 'repos') {
    const owner = rest[1];
    const repoName = rest[2];
    if (!owner || !repoName) return errResp(404, 'Not Found');
    const repo: Repo | undefined = store.getRepo(owner, repoName);
    if (!repo) return errResp(404, 'Not Found');
    const sub = rest.slice(3);

    // /repos/{o}/{r}
    if (sub.length === 0) {
      if (method === 'GET') return jsonResp(200, store.repoJson(repo));
      if (method === 'PATCH') {
        const desc = str(body.description);
        if (desc !== undefined) repo.description = desc;
        return jsonResp(200, store.repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        return { status: 204, raw: Buffer.alloc(0) };
      }
      return errResp(404, 'Not Found');
    }

    // /repos/{o}/{r}/git/refs...
    if (sub[0] === 'git' && sub[1] === 'refs') {
      if (method === 'POST' && sub.length === 2) {
        const ref = str(body.ref);
        const sha = str(body.sha);
        if (!ref || !sha) return errResp(422, 'ref and sha are required');
        if (repo.refs.has(ref)) return errResp(422, 'Reference already exists');
        if (!store.hasObject(repo, sha)) return errResp(422, 'Invalid sha');
        repo.refs.set(ref, sha.toLowerCase());
        return jsonResp(201, { ref, object: { sha: sha.toLowerCase() } });
      }
      if (method === 'GET') {
        if (sub.length === 2) {
          // List all refs.
          const all = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha } }));
          return jsonResp(200, all);
        }
        const ref = `refs/${sub.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (!sha) return errResp(404, 'Not Found');
        return jsonResp(200, { ref, object: { sha } });
      }
      return errResp(404, 'Not Found');
    }

    // /repos/{o}/{r}/branches
    if (sub[0] === 'branches' && sub.length === 1) {
      if (method !== 'GET') return errResp(404, 'Not Found');
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }));
      return jsonResp(200, branches);
    }

    // /repos/{o}/{r}/commits
    if (sub[0] === 'commits' && sub.length === 1) {
      if (method !== 'GET') return errResp(404, 'Not Found');
      const shaParam = req.query.get('sha');
      const tip = shaParam
        ? (store.resolveRef(repo, shaParam) ?? (store.hasObject(repo, shaParam) ? shaParam.toLowerCase() : undefined))
        : store.resolveRef(repo, repo.defaultBranch);
      if (!tip) return errResp(404, 'Not Found');
      const out: Array<{ sha: string; commit: { message: string } }> = [];
      const seen = new Set<string>();
      const stack: string[] = [tip];
      while (stack.length > 0 && out.length < 100) {
        const oid = stack.pop() as string;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') continue;
        const info = parseCommit(obj.data);
        out.push({ sha: oid, commit: { message: info.message } });
        for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i]);
      }
      return jsonResp(200, out);
    }

    // /repos/{o}/{r}/contents/{path...}
    if (sub[0] === 'contents') {
      const pathParts = sub.slice(1);
      const path = pathParts.join('/');
      if (method === 'PUT') {
        const message = str(body.message) ?? `Update ${path}`;
        const contentB64 = str(body.content);
        if (contentB64 === undefined) return errResp(422, 'content is required');
        const branch = str(body.branch) ?? repo.defaultBranch;
        const givenSha = str(body.sha);
        const current = store.readFileAt(repo, branch, path);
        if (givenSha !== undefined) {
          if (!current) return errResp(404, 'Not Found');
          if (givenSha.toLowerCase() !== current.oid.toLowerCase()) {
            return errResp(409, 'sha does not match the current blob');
          }
        } else if (current) {
          return errResp(409, 'sha is required to update an existing file');
        }
        const content = Buffer.from(contentB64, 'base64');
        const result = store.commitFile(repo, branch, path, content, message);
        const status = current ? 200 : 201;
        return jsonResp(status, {
          content: {
            name: pathParts[pathParts.length - 1] ?? '',
            path,
            sha: result.blobSha,
            encoding: 'base64',
          },
          commit: { sha: result.commitSha },
        });
      }
      if (method === 'GET') {
        const refParam = req.query.get('ref') ?? repo.defaultBranch;
        const tip = store.resolveRef(repo, refParam);
        if (!tip) return errResp(404, 'Not Found');
        const commitObj = repo.objects.get(tip);
        if (!commitObj || commitObj.type !== 'commit') return errResp(404, 'Not Found');
        const treeOid = parseCommit(commitObj.data).tree;
        if (path === '') {
          const entries = store.listDirInTree(repo, treeOid, '');
          if (!entries) return errResp(404, 'Not Found');
          return jsonResp(200, entries.map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            name: e.name,
            path: e.name,
            sha: e.oid,
          })));
        }
        const file = store.readFileAt(repo, refParam, path);
        if (file) {
          return jsonResp(200, {
            type: 'file',
            encoding: 'base64',
            content: file.data.toString('base64'),
            sha: file.oid,
            size: file.data.length,
            name: pathParts[pathParts.length - 1],
            path,
          });
        }
        const entries = store.listDirInTree(repo, treeOid, path);
        if (entries) {
          return jsonResp(200, entries.map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            name: e.name,
            path: `${path}/${e.name}`,
            sha: e.oid,
          })));
        }
        return errResp(404, 'Not Found');
      }
      if (method === 'DELETE') {
        const branch = str(body.branch) ?? repo.defaultBranch;
        const tip = store.resolveRef(repo, branch);
        if (!tip) return errResp(404, 'Not Found');
        const current = store.readFileAt(repo, branch, path);
        if (!current) return errResp(404, 'Not Found');
        const givenSha = str(body.sha);
        if (givenSha !== undefined && givenSha.toLowerCase() !== current.oid.toLowerCase()) {
          return errResp(409, 'sha does not match the current blob');
        }
        const commitObj = repo.objects.get(tip);
        if (!commitObj || commitObj.type !== 'commit') return errResp(404, 'Not Found');
        const treeOid = parseCommit(commitObj.data).tree;
        const newTree = store.setPathInTree(repo, treeOid, path, null);
        store.commitSeq += 1;
        const epoch = 1735689600 + store.commitSeq;
        const ident = `${VIEWER.name} <${VIEWER.email}> ${epoch} +0000`;
        const message = str(body.message) ?? `Delete ${path}`;
        const commitData = serializeCommit({
          tree: newTree,
          parents: [tip],
          author: ident,
          committer: ident,
          message: message.endsWith('\n') ? message : `${message}\n`,
        });
        const commitSha = store.putObject(repo, 'commit', commitData);
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        return jsonResp(200, { commit: { sha: commitSha } });
      }
      return errResp(404, 'Not Found');
    }

    // /repos/{o}/{r}/labels
    if (sub[0] === 'labels' && sub.length === 1) {
      if (method !== 'POST') return errResp(404, 'Not Found');
      const name = str(body.name);
      if (!name) return errResp(422, 'name is required');
      const color = str(body.color) ?? 'ededed';
      const existing = repo.labels.get(name);
      if (existing) return jsonResp(201, { name: existing.name, color: existing.color });
      repo.labels.set(name, { name, color });
      return jsonResp(201, { name, color });
    }

    // /repos/{o}/{r}/issues...
    if (sub[0] === 'issues') {
      // /repos/{o}/{r}/issues
      if (sub.length === 1) {
        if (method === 'POST') {
          const title = str(body.title);
          if (!title) return errResp(422, 'title is required');
          const labels = labelNames(body.labels);
          const created = store.createIssue(repo, title, str(body.body) ?? '', labels);
          if ('error' in created) {
            return errResp(422, `Unknown label: ${created.label}`);
          }
          return jsonResp(201, store.issueJson(repo, created));
        }
        if (method === 'GET') {
          const state = req.query.get('state') ?? undefined;
          const sort = req.query.get('sort') ?? 'created';
          const direction = req.query.get('direction') ?? 'asc';
          const perPage = intParam(req.query.get('per_page'), 30);
          const list = store.listIssues(repo, { state, sort, direction }).slice(0, perPage);
          return jsonResp(200, list.map((i) => store.issueJson(repo, i)));
        }
        return errResp(404, 'Not Found');
      }
      const num = parseInt(sub[1], 10);
      if (!Number.isInteger(num)) return errResp(404, 'Not Found');
      // /repos/{o}/{r}/issues/{n}/comments
      if (sub.length === 3 && sub[2] === 'comments') {
        const issue = store.getIssue(repo, num);
        if (!issue) return errResp(404, 'Not Found');
        if (method === 'POST') {
          const commentBody = str(body.body);
          if (commentBody === undefined) return errResp(422, 'body is required');
          const comment = store.addComment(repo, num, commentBody);
          if (!comment) return errResp(404, 'Not Found');
          return jsonResp(201, store.commentJson(comment));
        }
        if (method === 'GET') {
          const list = repo.comments.get(num) ?? [];
          return jsonResp(200, list.map((c) => store.commentJson(c)));
        }
        return errResp(404, 'Not Found');
      }
      // /repos/{o}/{r}/issues/{n}
      if (sub.length === 2) {
        const issue = store.getIssue(repo, num);
        if (!issue) return errResp(404, 'Not Found');
        if (method === 'GET') return jsonResp(200, store.issueJson(repo, issue));
        if (method === 'PATCH') {
          const state = str(body.state);
          if (state === 'open' || state === 'closed') issue.state = state;
          return jsonResp(200, store.issueJson(repo, issue));
        }
        return errResp(404, 'Not Found');
      }
      return errResp(404, 'Not Found');
    }

    // /repos/{o}/{r}/pulls...
    if (sub[0] === 'pulls') {
      // /repos/{o}/{r}/pulls
      if (sub.length === 1) {
        if (method === 'POST') {
          const title = str(body.title);
          const head = str(body.head);
          const base = str(body.base);
          if (!title || !head || !base) return errResp(422, 'title, head and base are required');
          const created = store.createPR(repo, title, str(body.body) ?? '', head, base);
          if ('error' in created) {
            return errResp(422, 'head or base branch does not exist');
          }
          return jsonResp(201, store.prJson(repo, created));
        }
        if (method === 'GET') {
          const state = req.query.get('state') ?? undefined;
          const perPage = intParam(req.query.get('per_page'), 30);
          const list = store.listPRs(repo, state).slice(0, perPage);
          return jsonResp(200, list.map((p) => store.prJson(repo, p)));
        }
        return errResp(404, 'Not Found');
      }
      const num = parseInt(sub[1], 10);
      if (!Number.isInteger(num)) return errResp(404, 'Not Found');
      // /repos/{o}/{r}/pulls/{n}/files
      if (sub.length === 3 && sub[2] === 'files') {
        if (method !== 'GET') return errResp(404, 'Not Found');
        const pr = store.getPR(repo, num);
        if (!pr) return errResp(404, 'Not Found');
        const files = store.prFiles(repo, pr).map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        }));
        return jsonResp(200, files);
      }
      // /repos/{o}/{r}/pulls/{n}/merge
      if (sub.length === 3 && sub[2] === 'merge') {
        if (method !== 'PUT') return errResp(404, 'Not Found');
        const pr = store.getPR(repo, num);
        if (!pr) return errResp(404, 'Not Found');
        const result = store.mergePR(repo, pr);
        if ('error' in result) {
          return errResp(405, result.error === 'already' ? 'Pull request is already merged or closed' : 'Merge conflict');
        }
        return jsonResp(200, {
          merged: true,
          sha: result.sha,
          message: 'Pull request successfully merged',
        });
      }
      // /repos/{o}/{r}/pulls/{n}
      if (sub.length === 2) {
        if (method !== 'GET') return errResp(404, 'Not Found');
        const pr = store.getPR(repo, num);
        if (!pr) return errResp(404, 'Not Found');
        return jsonResp(200, store.prJson(repo, pr));
      }
      return errResp(404, 'Not Found');
    }

    return errResp(404, 'Not Found');
  }

  return errResp(404, 'Not Found');
}
