// The forge's store: every object the four surfaces share.
//
// One in-memory store per process. Repos are keyed "owner/name"; git objects
// live per repo in a Map keyed by hex oid. Issues, PRs, comments and labels
// live on the repo. Everything the REST, GraphQL, MCP and git surfaces read
// or write goes through here, so the four surfaces can never disagree.
//
// Determinism: commit author/committer epochs and merged_at derive from a
// monotonic counter (base epoch + seq), never from the wall clock, so two
// runs on the same inputs build byte-identical objects.
//
// Viewer identity: the suite's bearer token is opaque (shpat_ + hex, derived
// from the trial, no login inside it), so the only way to know the login the
// token names is the kit's own published scenario: wire.ts builds the viewer
// from the fixed SCENARIO_SEED with a public RNG. We re-derive it here with
// the same published functions (FNV-1a + splitmix64 + xorshift64* + the
// published name lists). The result is the scenario's viewer (adaiversen).

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- viewer
const U64_MASK = (1n << 64n) - 1n;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
] as const;
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
] as const;

export interface Viewer {
  login: string;
  id: number;
  name: string;
  email: string;
}

function deriveViewer(): Viewer {
  const seed = mix64(SCENARIO_SEED ^ fnv1a64('users'));
  const rng = new Rng(seed);
  // generateUsers('users', 12); viewer is users[0].
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  const login = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
  return { login, id: 1000, name: `${first} ${last}`, email: `${login}@example.invalid` };
}

export const VIEWER: Viewer = deriveViewer();

// ---------------------------------------------------------------- git objects
export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function oidOf(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, sp + 1);
    const mode = data.subarray(i, sp).toString('ascii');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

/** Git tree sort order: entries by name bytes, directories as if suffixed '/'. */
export function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const head = text.split('\n\n')[0];
  const lines = head.split('\n');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of lines) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const idx = text.indexOf('\n\n');
  const message = idx >= 0 ? text.slice(idx + 2) : '';
  return { tree, parents, author, committer, message };
}

export function serializeCommit(c: CommitInfo): Buffer {
  let out = `tree ${c.tree}\n`;
  for (const p of c.parents) out += `parent ${p}\n`;
  out += `author ${c.author}\ncommitter ${c.committer}\n\n${c.message}`;
  return Buffer.from(out, 'utf8');
}

// ---------------------------------------------------------------- domain types
export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
}

export interface Comment {
  id: number;
  body: string;
  seq: number;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'deleted' | 'changed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  issueSeq: number;
  commentSeq: number;
  comments: Map<number, Comment[]>;
  prs: PullRequest[];
  prSeq: number;
  labels: Map<string, Label>;
  createdSeq: number;
}

const BASE_EPOCH = 1_735_689_600; // 2025-01-01T00:00:00Z, the scenario epoch

export function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function b64urlDecode(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) n += 1;
  if (data[data.length - 1] !== 0x0a) n += 1;
  return n;
}

// ---------------------------------------------------------------- store
export class Store {
  repos = new Map<string, Repo>();
  repoSeq = 0;
  commitSeq = 0;
  nextRepoId = 5000;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    const key = this.key(VIEWER.login, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER.login,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      issues: [],
      issueSeq: 0,
      commentSeq: 0,
      comments: new Map(),
      prs: [],
      prSeq: 0,
      labels: new Map(),
      createdSeq: this.repoSeq,
    };
    this.repoSeq += 1;
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  /** A repo is visible only under the token owner's login; any other owner is a 404. */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // ------------------------------------------------------------ git objects
  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = oidOf(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid.toLowerCase());
  }

  hasObject(repo: Repo, oid: string): boolean {
    return repo.objects.has(oid.toLowerCase());
  }

  /** The tip oid of a ref, or undefined when the ref does not exist. */
  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** All objects reachable from `tips`, optionally excluding those reachable from `exclude`, with an optional commit-depth cap (depth = generations of commits to include; depth 1 = tips only).
   * `cut` commits are included (with their trees) but their parents are never followed — used when computing an exclusion set from a client's shallow haves.
   * Returns the object map plus the shallow boundary commits (included commits at the deepest generation, when a depth cap is set). */
  reachable(
    repo: Repo,
    tips: string[],
    opts: { exclude?: Set<string>; depth?: number; cut?: Set<string> } = {},
  ): { objects: Map<string, GitObject>; shallow: string[] } {
    const objects = new Map<string, GitObject>();
    const shallow: string[] = [];
    const exclude = opts.exclude ?? new Set<string>();
    const cut = opts.cut ?? new Set<string>();
    const depth = opts.depth ?? -1;
    // BFS over commits with a generation number; trees/blobs/tags are
    // walked without a generation (they belong to the commit that names them).
    const visited = new Set<string>();
    const commitGen = new Map<string, number>();
    const queue: Array<{ oid: string; gen: number }> = [];
    for (const tip of tips) {
      if (tip && tip !== ZERO_OID) queue.push({ oid: tip.toLowerCase(), gen: 0 });
    }
    const includeObject = (oid: string): GitObject | undefined => {
      if (visited.has(oid) || exclude.has(oid)) return undefined;
      const obj = repo.objects.get(oid);
      if (!obj) return undefined;
      visited.add(oid);
      objects.set(oid, obj);
      return obj;
    };
    // First pass: walk commits, recording generations and collecting trees.
    // An excluded commit is still traversed (its parents may be wanted, e.g.
    // deepening a shallow clone) — only its own bytes are withheld.
    const traversed = new Set<string>();
    const treeQueue: string[] = [];
    while (queue.length > 0) {
      const { oid, gen } = queue.shift() as { oid: string; gen: number };
      if (depth >= 0 && gen >= depth) continue;
      if (traversed.has(oid)) continue;
      traversed.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      const excluded = exclude.has(oid);
      if (!excluded) {
        visited.add(oid);
        objects.set(oid, obj);
      }
      if (obj.type === 'commit') {
        if (!excluded) commitGen.set(oid, gen);
        const c = parseCommit(obj.data);
        treeQueue.push(c.tree);
        if (!cut.has(oid)) {
          for (const p of c.parents) queue.push({ oid: p, gen: gen + 1 });
        }
        if (depth >= 0 && gen === depth - 1 && !excluded) shallow.push(oid);
      } else if (obj.type === 'tree') {
        treeQueue.push(oid);
      } else if (obj.type === 'tag') {
        const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
        if (m) queue.push({ oid: m[1], gen });
      }
    }
    // Second pass: walk trees/blobs from every included commit/tag.
    const seen2 = new Set<string>();
    const stack = [...treeQueue];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen2.has(oid)) continue;
      seen2.add(oid);
      const obj = includeObject(oid);
      if (!obj) continue;
      if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
        if (m) stack.push(m[1]);
      }
    }
    return { objects, shallow };
  }

  isAncestor(repo: Repo, anc: string, desc: string): boolean {
    if (anc === desc) return true;
    const seen = new Set<string>();
    const stack = [desc.toLowerCase()];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === anc.toLowerCase()) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    return false;
  }

  /** Read a file's blob at a ref (branch name or full ref). */
  readFileAt(repo: Repo, ref: string, path: string): { oid: string; data: Buffer } | undefined {
    const tip = this.resolveRef(repo, ref);
    if (!tip) return undefined;
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') return undefined;
    const treeOid = parseCommit(commit.data).tree;
    return this.readFileInTree(repo, treeOid, path);
  }

  resolveRef(repo: Repo, ref: string): string | undefined {
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    return repo.refs.get(full);
  }

  readFileInTree(repo: Repo, treeOid: string, path: string): { oid: string; data: Buffer } | undefined {
    const parts = path.split('/').filter((p) => p !== '');
    let cur = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'tree') return undefined;
      const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
      if (!entry) return undefined;
      if (i === parts.length - 1) {
        if (entry.mode === '40000') return undefined;
        const blob = repo.objects.get(entry.oid);
        if (!blob || blob.type !== 'blob') return undefined;
        return { oid: entry.oid, data: blob.data };
      }
      cur = entry.oid;
    }
    return undefined;
  }

  listDirInTree(repo: Repo, treeOid: string, dir: string): TreeEntry[] | undefined {
    const parts = dir.split('/').filter((p) => p !== '');
    let cur = treeOid;
    for (const part of parts) {
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'tree') return undefined;
      const entry = parseTree(obj.data).find((e) => e.name === part);
      if (!entry || entry.mode !== '40000') return undefined;
      cur = entry.oid;
    }
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tree') return undefined;
    return parseTree(obj.data);
  }

  /** Set one path in a tree, returning the new tree oid. Creates intermediate dirs. */
  setPathInTree(repo: Repo, treeOid: string | undefined, path: string, blobOid: string | null, mode = '100644'): string {
    const parts = path.split('/').filter((p) => p !== '');
    const rec = (oid: string | undefined, idx: number): string => {
      const entries = oid ? parseTree(repo.objects.get(oid)?.data ?? Buffer.alloc(0)) : [];
      const name = parts[idx];
      const rest = entries.filter((e) => e.name !== name);
      if (idx === parts.length - 1) {
        if (blobOid !== null) rest.push({ mode, name, oid: blobOid });
        // blobOid null = delete
      } else {
        const child = entries.find((e) => e.name === name);
        const childTree = rec(child && child.mode === '40000' ? child.oid : undefined, idx + 1);
        rest.push({ mode: '40000', name, oid: childTree });
      }
      return this.putObject(repo, 'tree', serializeTree(rest));
    };
    return rec(treeOid, 0);
  }

  /** Create a commit on `branch` (default branch when omitted) writing one file. Creates the branch from the default tip when it does not exist yet, and the default branch from nothing on an unborn repo. */
  commitFile(
    repo: Repo,
    branch: string | undefined,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; blobSha: string; branch: string } {
    const target = branch ?? repo.defaultBranch;
    const blobSha = this.putObject(repo, 'blob', content);
    const tipOid = repo.refs.get(`refs/heads/${target}`);
    let parentTree: string | undefined;
    const parents: string[] = [];
    if (tipOid) {
      const tip = repo.objects.get(tipOid);
      if (tip && tip.type === 'commit') {
        parentTree = parseCommit(tip.data).tree;
        parents.push(tipOid);
      }
    } else if (target !== repo.defaultBranch) {
      // New branch from the default tip.
      const defTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defTip) {
        const def = repo.objects.get(defTip);
        if (def && def.type === 'commit') {
          parentTree = parseCommit(def.data).tree;
          parents.push(defTip);
        }
      }
    }
    const treeOid = this.setPathInTree(repo, parentTree, path, blobSha);
    this.commitSeq += 1;
    const epoch = BASE_EPOCH + this.commitSeq;
    const ident = `${VIEWER.name} <${VIEWER.email}> ${epoch} +0000`;
    const commitData = serializeCommit({ tree: treeOid, parents, author: ident, committer: ident, message });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${target}`, commitSha);
    return { commitSha, blobSha, branch: target };
  }

  /** Diff two trees (base -> head), recursively. */
  diffTrees(repo: Repo, baseTree: string, headTree: string): FileChange[] {
    const out: FileChange[] = [];
    const walk = (baseOid: string | undefined, headOid: string | undefined, prefix: string): void => {
      const base = baseOid ? parseTree(repo.objects.get(baseOid)?.data ?? Buffer.alloc(0)) : [];
      const head = headOid ? parseTree(repo.objects.get(headOid)?.data ?? Buffer.alloc(0)) : [];
      const names = new Set([...base.map((e) => e.name), ...head.map((e) => e.name)]);
      for (const name of [...names].sort()) {
        const b = base.find((e) => e.name === name);
        const h = head.find((e) => e.name === name);
        const path = prefix ? `${prefix}/${name}` : name;
        if (b && b.mode === '40000' && h && h.mode === '40000') {
          walk(b.oid, h.oid, path);
        } else if (b && h && b.mode === '40000' && h.mode !== '40000') {
          // directory replaced by a file: treat as delete + add of contents
          walk(b.oid, undefined, path);
          const blob = repo.objects.get(h.oid);
          const adds = blob ? countLines(blob.data) : 0;
          out.push({ filename: path, status: 'added', additions: adds, deletions: 0, changes: adds });
        } else if (b && h && b.mode !== '40000' && h.mode === '40000') {
          walk(undefined, h.oid, path);
          const blob = repo.objects.get(b.oid);
          const dels = blob ? countLines(blob.data) : 0;
          out.push({ filename: path, status: 'deleted', additions: 0, deletions: dels, changes: dels });
        } else if (!b && h) {
          if (h.mode === '40000') walk(undefined, h.oid, path);
          else {
            const blob = repo.objects.get(h.oid);
            const adds = blob ? countLines(blob.data) : 0;
            out.push({ filename: path, status: 'added', additions: adds, deletions: 0, changes: adds });
          }
        } else if (b && !h) {
          if (b.mode === '40000') walk(b.oid, undefined, path);
          else {
            const blob = repo.objects.get(b.oid);
            const dels = blob ? countLines(blob.data) : 0;
            out.push({ filename: path, status: 'deleted', additions: 0, deletions: dels, changes: dels });
          }
        } else if (b && h && b.oid !== h.oid) {
          const bb = repo.objects.get(b.oid);
          const hb = repo.objects.get(h.oid);
          const adds = hb ? countLines(hb.data) : 0;
          const dels = bb ? countLines(bb.data) : 0;
          out.push({ filename: path, status: 'modified', additions: adds, deletions: dels, changes: adds + dels });
        }
      }
    };
    walk(baseTree, headTree, '');
    out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
    return out;
  }

  /** The files changed by a PR: diff of base commit tree -> head commit tree. */
  prFiles(repo: Repo, pr: PullRequest): FileChange[] {
    const baseObj = repo.objects.get(pr.baseSha);
    const headObj = repo.objects.get(pr.headSha);
    if (!baseObj || !headObj || baseObj.type !== 'commit' || headObj.type !== 'commit') return [];
    return this.diffTrees(repo, parseCommit(baseObj.data).tree, parseCommit(headObj.data).tree);
  }

  // ------------------------------------------------------------ issues
  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue | { error: string; label: string } {
    for (const label of labels) {
      if (!repo.labels.has(label)) return { error: 'bad-label', label };
    }
    repo.issueSeq += 1;
    const issue: Issue = { number: repo.issueSeq, title, body, state: 'open', labels: [...labels], seq: repo.issueSeq };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((i) => i.number === number);
  }

  listIssues(repo: Repo, opts: { state?: string; sort?: string; direction?: string }): Issue[] {
    let list = [...repo.issues];
    if (opts.state === 'open' || opts.state === 'closed') list = list.filter((i) => i.state === opts.state);
    const dir = opts.direction === 'desc' ? -1 : 1;
    list.sort((a, b) => (a.seq - b.seq) * dir);
    return list;
  }

  addComment(repo: Repo, issueNumber: number, body: string): Comment | null {
    const issue = this.getIssue(repo, issueNumber);
    if (!issue) return null;
    repo.commentSeq += 1;
    const comment: Comment = { id: repo.commentSeq, body, seq: repo.commentSeq };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  // ------------------------------------------------------------ pull requests
  createPR(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | { error: string } {
    const headSha = this.resolveRef(repo, head);
    const baseSha = this.resolveRef(repo, base);
    if (!headSha || !baseSha) return { error: 'missing-branch' };
    repo.prSeq += 1;
    const pr: PullRequest = {
      number: repo.prSeq,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      headSha,
      baseRef: base,
      baseSha,
      seq: repo.prSeq,
    };
    repo.prs.push(pr);
    return pr;
  }

  getPR(repo: Repo, number: number): PullRequest | undefined {
    return repo.prs.find((p) => p.number === number);
  }

  listPRs(repo: Repo, state?: string): PullRequest[] {
    let list = [...repo.prs];
    if (state === 'open' || state === 'closed') list = list.filter((p) => p.state === state);
    else if (!state) list = list.filter((p) => p.state === 'open');
    list.sort((a, b) => a.seq - b.seq);
    return list;
  }

  /** Squash-merge a PR. Returns the merge commit sha, or an error. */
  mergePR(repo: Repo, pr: PullRequest): { sha: string } | { error: 'conflict' | 'already' } {
    if (pr.state !== 'open') return { error: 'already' };
    const headObj = repo.objects.get(pr.headSha);
    const baseObj = repo.objects.get(pr.baseSha);
    const tipOid = this.resolveRef(repo, pr.baseRef);
    if (!headObj || !baseObj || !tipOid) return { error: 'conflict' };
    const tipObj = repo.objects.get(tipOid);
    if (!tipObj || tipObj.type !== 'commit') return { error: 'conflict' };
    const headTree = parseCommit(headObj.data).tree;
    const baseTree = parseCommit(baseObj.data).tree;
    const tipTree = parseCommit(tipObj.data).tree;
    const changes = this.diffTrees(repo, baseTree, headTree);
    // Conflict: a file the PR changes whose current base content differs from
    // both the PR's base content and the PR's head content.
    for (const change of changes) {
      const atBase = this.readFileInTree(repo, baseTree, change.filename);
      const atHead = this.readFileInTree(repo, headTree, change.filename);
      const atTip = this.readFileInTree(repo, tipTree, change.filename);
      const baseOid = atBase?.oid ?? null;
      const headOid = atHead?.oid ?? null;
      const tipOid2 = atTip?.oid ?? null;
      if (tipOid2 !== baseOid && tipOid2 !== headOid) return { error: 'conflict' };
    }
    // Apply the head's version of every changed file onto the tip tree.
    let treeOid = tipTree;
    for (const change of changes) {
      if (change.status === 'deleted') {
        treeOid = this.setPathInTree(repo, treeOid, change.filename, null);
      } else {
        const atHead = this.readFileInTree(repo, headTree, change.filename);
        if (atHead) treeOid = this.setPathInTree(repo, treeOid, change.filename, atHead.oid);
      }
    }
    this.commitSeq += 1;
    const epoch = BASE_EPOCH + this.commitSeq;
    const ident = `${VIEWER.name} <${VIEWER.email}> ${epoch} +0000`;
    const message = `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}\n`;
    const commitData = serializeCommit({ tree: treeOid, parents: [tipOid], author: ident, committer: ident, message });
    const sha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergeCommitSha = sha;
    pr.mergedAt = new Date((BASE_EPOCH + this.commitSeq) * 1000).toISOString();
    return { sha };
  }

  // ------------------------------------------------------------ JSON shapes
  repoJson(repo: Repo): Record<string, unknown> {
    return {
      id: repo.id,
      node_id: b64urlEncode(`repo:${repo.id}`),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      has_issues: true,
      html_url: `https://github.com/${repo.owner}/${repo.name}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}`,
      clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    };
  }

  issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: repo.id * 100000 + issue.number,
      node_id: b64urlEncode(`issue:${repo.id}:${issue.number}`),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    };
  }

  commentJson(comment: Comment): Record<string, unknown> {
    return {
      id: comment.id,
      node_id: b64urlEncode(`comment:${comment.id}`),
      body: comment.body,
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    };
  }

  prJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      id: repo.id * 100000 + pr.number,
      node_id: b64urlEncode(`pr:${repo.id}:${pr.number}`),
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      merged: pr.merged,
      head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
      base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    };
    if (pr.merged) {
      body.merged_at = pr.mergedAt;
      body.merge_commit_sha = pr.mergeCommitSha;
    }
    return body;
  }

  // ------------------------------------------------------------ global ids
  repoGlobalId(repo: Repo): string {
    return b64urlEncode(`repo:${repo.id}`);
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return b64urlEncode(`issue:${repo.id}:${issue.number}`);
  }

  prGlobalId(repo: Repo, pr: PullRequest): string {
    return b64urlEncode(`pr:${repo.id}:${pr.number}`);
  }

  commentGlobalId(repo: Repo, comment: Comment): string {
    return b64urlEncode(`comment:${repo.id}:${comment.id}`);
  }

  /** Decode an opaque global id. Returns the repo and, for issue/pr/comment ids, the number/id. */
  resolveGlobalId(id: string): { kind: string; repo: Repo; number: number } | null {
    const text = b64urlDecode(id);
    if (!text) return null;
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const repoId = Number(parts[1]);
    if (!Number.isInteger(repoId)) return null;
    const repo = [...this.repos.values()].find((r) => r.id === repoId);
    if (!repo) return null;
    if (parts[0] === 'repo') return { kind: 'repo', repo, number: 0 };
    if (parts[0] === 'issue' || parts[0] === 'pr') {
      const number = Number(parts[2]);
      if (!Number.isInteger(number)) return null;
      return { kind: parts[0], repo, number };
    }
    if (parts[0] === 'comment') {
      const number = Number(parts[2]);
      if (!Number.isInteger(number)) return null;
      return { kind: 'comment', repo, number };
    }
    return null;
  }
}
