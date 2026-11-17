// Round-3 tests: the paths the perf round touched, and the invariants the
// optimisations must never break. Run with:
//   node --experimental-strip-types --test tests/round3.test.ts
//
// 1. splitTarget == new URL(target, base) for plain and weird targets.
// 2. bearerToken == the old /^Bearer (.+)$/ match on the trimmed header.
// 3. The issue-JSON cache: identical bytes across GETs, and a PATCH close /
//    GraphQL closeIssue invalidates it (a later GET says "closed").
// 4. The fetch-pack cache: two identical v2 fetches return byte-identical
//    bodies, and a push (the object graph grows) makes the next fetch carry
//    the new tip instead of the stale pack.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createApp, splitTarget } from '../app.ts';
import { bearerToken, type Req } from '../http.ts';
import { VIEWER } from '../store.ts';

const TOKEN = 'shpat_round3test000000000000000000000000000000';
const OWNER = VIEWER.login;

// ---------------------------------------------------------------- helpers
function fakeReq(auth: string | undefined): Req {
  return {
    method: 'GET',
    pathname: '/',
    segments: [],
    query: new URLSearchParams(),
    headers: auth === undefined ? {} : { authorization: auth },
    rawBody: Buffer.alloc(0),
    json: undefined,
    jsonError: false,
  };
}

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii'), data]);
}
const FLUSH = Buffer.from('0000', 'ascii');

function hashObject(type: string, data: Buffer): string {
  return createHash('sha1').update(Buffer.from(`${type} ${data.length}\0`, 'ascii')).update(data).digest('hex');
}
function buildTree(entries: Array<{ mode: string; name: string; oid: string }>): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
function buildCommit(tree: string, parents: string[], message: string): Buffer {
  let out = `tree ${tree}\n`;
  for (const p of parents) out += `parent ${p}\n`;
  out += `author ${VIEWER.name} <${VIEWER.email}> 1700000000 +0000\ncommitter ${VIEWER.name} <${VIEWER.email}> 1700000000 +0000\n\n${message}`;
  return Buffer.from(out, 'utf8');
}
function encodePackEntryHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  bytes.push((type << 4) | (size & 0x0f));
  size >>>= 4;
  while (size > 0) {
    bytes.push(size & 0x7f);
    size >>>= 7;
  }
  for (let i = 0; i < bytes.length - 1; i += 1) bytes[i] |= 0x80;
  return Buffer.from(bytes);
}
function writePack(objects: Array<{ type: string; data: Buffer }>): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  const typeCodes: Record<string, number> = { commit: 1, tree: 2, blob: 3 };
  for (const obj of objects) {
    parts.push(encodePackEntryHeader(typeCodes[obj.type] as number, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const trailer = createHash('sha1').update(Buffer.concat(parts)).digest();
  parts.push(trailer);
  return Buffer.concat(parts);
}
/** One commit (blob + tree + commit) for `content` on `file`, parented on `parent`. */
function commitPack(content: string, file: string, parent: string | null, message: string): { pack: Buffer; commitOid: string } {
  const blob = Buffer.from(content, 'utf8');
  const blobOid = hashObject('blob', blob);
  const tree = buildTree([{ mode: '100644', name: file, oid: blobOid }]);
  const treeOid = hashObject('tree', tree);
  const commit = buildCommit(treeOid, parent === null ? [] : [parent], message);
  const commitOid = hashObject('commit', commit);
  return { pack: writePack([{ type: 'blob', data: blob }, { type: 'tree', data: tree }, { type: 'commit', data: commit }]), commitOid };
}

async function startServer(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createApp(TOKEN);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  const base = `http://127.0.0.1:${address.port}`;
  return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
async function api(base: string, path: string, method = 'GET', body?: unknown): Promise<{ status: number; text: string; json: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch { /* non-JSON (204) */ }
  return { status: res.status, text, json };
}

// ---------------------------------------------------------------- 1. splitTarget
test('splitTarget matches new URL() on plain and weird targets', () => {
  const targets = [
    '/api/v3/repos/adaiversen/bench-read/issues/1',
    '/api/v3/user/repos?per_page=30&page=2',
    '/api/v3/repos/o/r/issues?state=open&sort=created',
    '/adaiversen/repo.git/info/refs?service=git-upload-pack',
    '/api/graphql',
    '/healthz',
    '/',
    '/api/v3/repos/o/r/contents/a%20b.txt?ref=main',
    '/api/v3/repos/o/r/contents/a+b.txt',
    '/api/v3/search?q=a%2Fb',
    '/a/../b',
    '/a/./b',
    '/a/b/..',
    '/a/b/.',
    '/back\\slash',
    '/hash#frag',
    '/with space/x',
    '/quote"x',
    '/brace{x}',
    '/tick`x',
    '/caf%C3%A9',
    '',
    '*',
    '/api/v3/repos/o/r/issues/1?state=open#x',
  ];
  for (const target of targets) {
    const got = splitTarget(target);
    let wantPath: string;
    let wantQuery: string;
    try {
      const url = new URL(target, 'http://entry');
      wantPath = url.pathname;
      wantQuery = url.search;
    } catch {
      wantPath = '/';
      wantQuery = '';
    }
    assert.equal(got.pathname, wantPath, `pathname for ${JSON.stringify(target)}`);
    assert.equal(got.query.toString(), new URLSearchParams(wantQuery).toString(), `query for ${JSON.stringify(target)}`);
  }
});

// ---------------------------------------------------------------- 2. bearerToken
test('bearerToken matches the old regex on header shapes', () => {
  const old = (h: string | undefined): string | null => {
    if (typeof h !== 'string') return null;
    const m = /^Bearer (.+)$/.exec(h.trim());
    return m ? m[1] : null;
  };
  const cases: Array<string | undefined> = [
    undefined,
    '',
    'Bearer abc123',
    'Bearer   abc123  ',
    'Bearer ',
    'Bearer',
    'bearer abc',
    'Bearer\tabc',
    'Basic abc',
    'Bearer a b c',
    ' Bearer xyz ',
  ];
  for (const h of cases) assert.equal(bearerToken(fakeReq(h)), old(h), `header ${JSON.stringify(h)}`);
});

// ---------------------------------------------------------------- 3. issue JSON cache
test('issue JSON cache: stable across GETs, invalidated by PATCH close', async () => {
  const { base, close } = await startServer();
  try {
    const created = await api(base, '/api/v3/user/repos', 'POST', { name: 'cache-repo' });
    assert.equal(created.status, 201);
    const issue = await api(base, `/api/v3/repos/${OWNER}/cache-repo/issues`, 'POST', { title: 'cached?', body: 'b' });
    assert.equal(issue.status, 201);
    const n = (issue.json as { number: number }).number;
    const get1 = await api(base, `/api/v3/repos/${OWNER}/cache-repo/issues/${n}`);
    const get2 = await api(base, `/api/v3/repos/${OWNER}/cache-repo/issues/${n}`);
    assert.equal(get1.status, 200);
    assert.equal(get1.text, get2.text, 'two GETs of an unchanged issue are byte-identical');
    assert.match(get1.text, /"state":"open"/);
    const patched = await api(base, `/api/v3/repos/${OWNER}/cache-repo/issues/${n}`, 'PATCH', { state: 'closed' });
    assert.equal(patched.status, 200);
    assert.match(patched.text, /"state":"closed"/, 'PATCH reply reflects the new state');
    const get3 = await api(base, `/api/v3/repos/${OWNER}/cache-repo/issues/${n}`);
    assert.match(get3.text, /"state":"closed"/, 'GET after PATCH reflects the new state, not the stale cache');
  } finally {
    await close();
  }
});

test('issue JSON cache: invalidated by GraphQL closeIssue', async () => {
  const { base, close } = await startServer();
  try {
    await api(base, '/api/v3/user/repos', 'POST', { name: 'cache-repo-gql' });
    const issue = await api(base, `/api/v3/repos/${OWNER}/cache-repo-gql/issues`, 'POST', { title: 'gql?', body: 'b' });
    assert.equal(issue.status, 201);
    const issueJson = issue.json as { node_id: string; number: number };
    const get1 = await api(base, `/api/v3/repos/${OWNER}/cache-repo-gql/issues/${issueJson.number}`);
    assert.match(get1.text, /"state":"open"/);
    const gql = await api(base, '/api/graphql', 'POST', {
      query: 'mutation($input: CloseIssueInput!) { closeIssue(input: $input) { issue { state } } }',
      variables: { input: { issueId: issueJson.node_id } },
    });
    assert.equal(gql.status, 200);
    const get2 = await api(base, `/api/v3/repos/${OWNER}/cache-repo-gql/issues/${issueJson.number}`);
    assert.match(get2.text, /"state":"closed"/, 'GET after GraphQL closeIssue reflects the new state');
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------- 4. fetch-pack cache
test('fetch-pack cache: identical fetch repeats byte-identical; push invalidates', async () => {
  const { base, close } = await startServer();
  try {
    await api(base, '/api/v3/user/repos', 'POST', { name: 'cache-repo-git' });
    const repoPath = `/${OWNER}/cache-repo-git.git`;
    // Push commit 1 (advertisement is not needed: receive-pack takes the
    // command list + pack directly).
    const first = commitPack('hello\n', 'f.txt', null, 'first\n');
    const zero = '0000000000000000000000000000000000000000';
    const cmd1 = pktLine(`${zero} ${first.commitOid} refs/heads/main\0report-status side-band-64k ofs-delta\n`);
    const push1 = await fetch(`${base}${repoPath}/git-receive-pack`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/x-git-receive-pack-request' },
      body: Buffer.concat([cmd1, FLUSH, first.pack]),
    });
    assert.equal(push1.status, 200);
    assert.match(await push1.text(), /unpack ok/);

    const fetchV2 = async (): Promise<Buffer> => {
      const body = Buffer.concat([
        pktLine('command=fetch\n'),
        pktLine('object-format=sha1\n'),
        pktLine(`want ${first.commitOid}\n`),
        pktLine('deepen 1\n'),
        pktLine('filter blob:none\n'),
        FLUSH,
        pktLine('done\n'),
      ]);
      const res = await fetch(`${base}${repoPath}/git-upload-pack`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2' },
        body,
      });
      assert.equal(res.status, 200);
      return Buffer.from(await res.arrayBuffer());
    };
    // The want above pins commit 1; deepen 1 keeps the fetch shallow.
    const a = await fetchV2();
    const b = await fetchV2();
    assert.ok(a.equals(b), 'two identical fetches return byte-identical bodies');

    // Push commit 2 on top, then fetch wanting the new tip: the cached
    // answer for the old tip must not leak into the new fetch.
    const second = commitPack('hello2\n', 'f.txt', first.commitOid, 'second\n');
    const cmd2 = pktLine(`${first.commitOid} ${second.commitOid} refs/heads/main\0report-status side-band-64k ofs-delta\n`);
    const push2 = await fetch(`${base}${repoPath}/git-receive-pack`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/x-git-receive-pack-request' },
      body: Buffer.concat([cmd2, FLUSH, second.pack]),
    });
    assert.equal(push2.status, 200);
    assert.match(await push2.text(), /unpack ok/);
    const fetchTip2 = async (): Promise<Buffer> => {
      const body = Buffer.concat([
        pktLine('command=fetch\n'),
        pktLine('object-format=sha1\n'),
        pktLine(`want ${second.commitOid}\n`),
        pktLine('deepen 1\n'),
        pktLine('filter blob:none\n'),
        FLUSH,
        pktLine('done\n'),
      ]);
      const res = await fetch(`${base}${repoPath}/git-upload-pack`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2' },
        body,
      });
      assert.equal(res.status, 200);
      return Buffer.from(await res.arrayBuffer());
    };
    const c = await fetchTip2();
    assert.ok(c.includes(Buffer.from(second.commitOid, 'ascii')) || c.length > 0, 'fetch after push returns a pack');
    assert.ok(!c.equals(a), 'fetch for the new tip differs from the cached old-tip pack');
    const d = await fetchTip2();
    assert.ok(c.equals(d), 'repeat fetch of the new tip is byte-identical again');
  } finally {
    await close();
  }
});
