// GraphQL surface (POST /api/graphql) for the forge.
//
// A small, self-contained GraphQL implementation for the fixed documents the
// suite sends: a tokenizer + parser for operations, variables, aliases,
// arguments (literals, variables, enums, lists, inline input objects),
// inline fragments and fragment spreads, plus a selection-aware executor
// over the Store. No dependencies beyond node stdlib (via store.ts).

import { Store, VIEWER, b64urlEncode, b64urlDecode, parseCommit } from './store.ts';
import type { Repo, Issue, PullRequest, Comment } from './store.ts';
import { jsonResp, errResp, requireAuth } from './http.ts';
import type { Req, Resp, Ctx } from './http.ts';

// ------------------------------------------------------------------ tokenizer
type TokKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';
interface Tok {
  kind: TokKind;
  value: string;
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      toks.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (c === '"') {
      let out = '';
      i += 1;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n) {
          const e = src[i + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'u' && i + 5 < n) {
            out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
            i += 4;
          } else out += e;
          i += 2;
        } else {
          out += src[i];
          i += 1;
        }
      }
      i += 1; // closing quote
      toks.push({ kind: 'string', value: out });
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '-' && i + 1 < n && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < n && src[j] >= '0' && src[j] <= '9') j += 1;
      let isFloat = false;
      if (src[j] === '.' && j + 1 < n && src[j + 1] >= '0' && src[j + 1] <= '9') {
        isFloat = true;
        j += 1;
        while (j < n && src[j] >= '0' && src[j] <= '9') j += 1;
      }
      if ((src[j] === 'e' || src[j] === 'E') && j + 1 < n) {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k += 1;
        if (k < n && src[k] >= '0' && src[k] <= '9') {
          isFloat = true;
          j = k;
          while (j < n && src[j] >= '0' && src[j] <= '9') j += 1;
        }
      }
      toks.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_') {
      let j = i;
      while (j < n && ((src[j] >= 'A' && src[j] <= 'Z') || (src[j] >= 'a' && src[j] <= 'z') || (src[j] >= '0' && src[j] <= '9') || src[j] === '_')) j += 1;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      toks.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    // Unknown character: skip it so one stray byte cannot kill the document.
    i += 1;
  }
  toks.push({ kind: 'eof', value: '' });
  return toks;
}

// ------------------------------------------------------------------ AST
type ValueNode =
  | { k: 'var'; name: string }
  | { k: 'str'; v: string }
  | { k: 'num'; v: number }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'enum'; v: string }
  | { k: 'list'; items: ValueNode[] }
  | { k: 'obj'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldSel {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  sels: Selection[] | null;
}
interface FragSel {
  kind: 'frag';
  typeCond: string | null;
  name: string | null;
  sels: Selection[];
}
type Selection = FieldSel | FragSel;

interface Operation {
  opType: 'query' | 'mutation' | 'subscription';
  name: string | null;
  sels: Selection[];
}
interface FragmentDef {
  typeCond: string;
  sels: Selection[];
}
interface Document {
  ops: Operation[];
  frags: Map<string, FragmentDef>;
}

class ParseError extends Error {}

class Parser {
  toks: Tok[];
  i = 0;
  constructor(toks: Tok[]) {
    this.toks = toks;
  }
  peek(): Tok {
    return this.toks[this.i];
  }
  next(): Tok {
    const t = this.toks[this.i];
    if (this.i < this.toks.length - 1) this.i += 1;
    return t;
  }
  isPunct(v: string): boolean {
    const t = this.peek();
    return t.kind === 'punct' && t.value === v;
  }
  eatPunct(v: string): boolean {
    if (this.isPunct(v)) {
      this.next();
      return true;
    }
    return false;
  }
  expectPunct(v: string): void {
    if (!this.eatPunct(v)) throw new ParseError(`Expected '${v}' but found '${this.peek().value}'`);
  }
  expectName(what = 'name'): string {
    const t = this.next();
    if (t.kind !== 'name') throw new ParseError(`Expected ${what} but found '${t.value}'`);
    return t.value;
  }

  parseDocument(): Document {
    const ops: Operation[] = [];
    const frags = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName('fragment name');
        const onKw = this.expectName("'on'");
        if (onKw !== 'on') throw new ParseError(`Expected 'on' in fragment definition`);
        const typeCond = this.expectName('fragment type');
        this.skipDirectives();
        const sels = this.parseSelectionSet();
        frags.set(name, { typeCond, sels });
      } else {
        ops.push(this.parseOperation());
      }
    }
    if (ops.length === 0) throw new ParseError('Empty query document');
    return { ops, frags };
  }

  parseOperation(): Operation {
    let opType: Operation['opType'] = 'query';
    let name: string | null = null;
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '{') {
      return { opType: 'query', name: null, sels: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      opType = t.value as Operation['opType'];
      this.next();
      const nt = this.peek();
      if (nt.kind === 'name') name = this.next().value;
      if (this.isPunct('(')) this.parseVarDefs();
      this.skipDirectives();
      return { opType, name, sels: this.parseSelectionSet() };
    }
    throw new ParseError(`Unexpected token '${t.value}' at start of operation`);
  }

  parseVarDefs(): void {
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      if (this.peek().kind === 'eof') throw new ParseError('Unterminated variable definitions');
      this.expectPunct('$');
      this.expectName('variable name');
      this.expectPunct(':');
      this.parseType();
      if (this.isPunct('=')) {
        this.next();
        this.parseValue();
      }
    }
    this.expectPunct(')');
  }

  parseType(): void {
    // Type: Name | [Type] | Type! — consume tokens, value discarded.
    if (this.isPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('type name');
    }
    this.eatPunct('!');
  }

  skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName('directive name');
      if (this.isPunct('(')) this.parseArgs();
    }
  }

  parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const sels: Selection[] = [];
    while (!this.isPunct('}')) {
      if (this.peek().kind === 'eof') throw new ParseError('Unterminated selection set');
      sels.push(this.parseSelection());
    }
    this.expectPunct('}');
    return sels;
  }

  parseSelection(): Selection {
    if (this.peek().kind === 'spread') {
      this.next();
      const t = this.peek();
      if (t.kind === 'name' && t.value === 'on') {
        this.next();
        const typeCond = this.expectName('fragment type');
        this.skipDirectives();
        return { kind: 'frag', typeCond, name: null, sels: this.parseSelectionSet() };
      }
      if (t.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'frag', typeCond: null, name, sels: [] };
      }
      if (t.kind === 'punct' && t.value === '{') {
        return { kind: 'frag', typeCond: null, name: null, sels: this.parseSelectionSet() };
      }
      throw new ParseError('Unexpected token after ...');
    }
    const first = this.expectName('field name');
    let name = first;
    let alias: string | null = null;
    if (this.isPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName('field name');
    }
    let args: Array<{ name: string; value: ValueNode }> = [];
    if (this.isPunct('(')) args = this.parseArgs();
    this.skipDirectives();
    let sels: Selection[] | null = null;
    if (this.isPunct('{')) sels = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, sels };
  }

  parseArgs(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!this.isPunct(')')) {
      if (this.peek().kind === 'eof') throw new ParseError('Unterminated arguments');
      const name = this.expectName('argument name');
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { k: 'var', name: this.expectName('variable name') };
    }
    if (t.kind === 'string') return { k: 'str', v: t.value };
    if (t.kind === 'int' || t.kind === 'float') return { k: 'num', v: Number(t.value) };
    if (t.kind === 'punct' && t.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        if (this.peek().kind === 'eof') throw new ParseError('Unterminated list value');
        items.push(this.parseValue());
      }
      this.next();
      return { k: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        if (this.peek().kind === 'eof') throw new ParseError('Unterminated input object');
        const name = this.expectName('input field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { k: 'obj', fields };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { k: 'bool', v: true };
      if (t.value === 'false') return { k: 'bool', v: false };
      if (t.value === 'null') return { k: 'null' };
      return { k: 'enum', v: t.value };
    }
    throw new ParseError(`Unexpected value token '${t.value}'`);
  }
}

// ------------------------------------------------------------------ values
function resolveValue(vn: ValueNode, vars: Record<string, unknown>): unknown {
  switch (vn.k) {
    case 'var':
      return vars[vn.name];
    case 'str':
      return vn.v;
    case 'num':
      return vn.v;
    case 'bool':
      return vn.v;
    case 'null':
      return null;
    case 'enum':
      return vn.v;
    case 'list':
      return vn.items.map((it) => resolveValue(it, vars));
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const f of vn.fields) out[f.name] = resolveValue(f.value, vars);
      return out;
    }
  }
}

function argMap(field: FieldSel, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveValue(a.value, vars);
  return out;
}

// ------------------------------------------------------------------ internal nodes
// Executor nodes carry a `t` discriminant plus their payload. They are never
// serialized directly; the executor builds plain output objects from the
// query's selection sets.
type GNode = { t: string; [k: string]: unknown };

function repoNode(repo: Repo): GNode {
  return { t: 'Repository', repo };
}
function issueNode(repo: Repo, issue: Issue): GNode {
  return { t: 'Issue', repo, issue };
}
function prNode(repo: Repo, pr: PullRequest): GNode {
  return { t: 'PullRequest', repo, pr };
}
function userNode(login: string): GNode {
  return { t: 'User', login };
}

// ------------------------------------------------------------------ schema tables
const ALLOWED: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'author', 'comments', 'labels'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'url', 'author', 'createdAt'],
  User: ['login', 'id', 'name', 'url'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes', 'status'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  Ref: ['name', 'prefix', 'target'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  Comment: ['id', 'body', 'author', 'url', 'createdAt'],
  LabelConnection: ['nodes', 'pageInfo', 'totalCount'],
  Label: ['name', 'color', 'id'],
  CommentConnection: ['nodes', 'pageInfo', 'totalCount'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Schema: ['queryType', 'mutationType', 'subscriptionType', 'types', 'directives', 'description'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
  __InputValue: ['name', 'description', 'type'],
};

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'author', 'comments', 'labels'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'url', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt'],
  User: ['login', 'id', 'name', 'url'],
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ------------------------------------------------------------------ cursors
function makeCursor(repoId: number, seq: number): string {
  return b64urlEncode(`cursor:${repoId}:${seq}`);
}

function parseCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  const decoded = b64urlDecode(cursor);
  if (decoded !== null) {
    if (decoded.startsWith('cursor:')) {
      const n = Number(decoded.split(':')[2]);
      return Number.isInteger(n) ? n : null;
    }
    if (/^\d+$/.test(decoded)) return Number(decoded);
  }
  if (/^\d+$/.test(cursor)) return Number(cursor);
  return null;
}

// ------------------------------------------------------------------ mergeable
function computeMergeable(store: Store, repo: Repo, pr: PullRequest): string {
  const headObj = repo.objects.get(pr.headSha);
  const baseObj = repo.objects.get(pr.baseSha);
  const tipOid = store.resolveRef(repo, pr.baseRef);
  if (!headObj || !baseObj || !tipOid) return 'UNKNOWN';
  const tipObj = repo.objects.get(tipOid);
  if (!tipObj || tipObj.type !== 'commit') return 'UNKNOWN';
  const headTree = parseCommit(headObj.data).tree;
  const baseTree = parseCommit(baseObj.data).tree;
  const tipTree = parseCommit(tipObj.data).tree;
  const changes = store.prFiles(repo, pr);
  for (const change of changes) {
    const atBase = store.readFileInTree(repo, baseTree, change.filename);
    const atHead = store.readFileInTree(repo, headTree, change.filename);
    const atTip = store.readFileInTree(repo, tipTree, change.filename);
    const baseOid = atBase?.oid ?? null;
    const headOid = atHead?.oid ?? null;
    const tipOid2 = atTip?.oid ?? null;
    if (tipOid2 !== baseOid && tipOid2 !== headOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

// ------------------------------------------------------------------ executor
class Executor {
  store: Store;
  ctx: Ctx;
  vars: Record<string, unknown>;
  errors: Array<{ message: string }>;
  frags: Map<string, FragmentDef>;

  constructor(store: Store, ctx: Ctx, vars: Record<string, unknown>, frags: Map<string, FragmentDef>) {
    this.store = store;
    this.ctx = ctx;
    this.vars = vars;
    this.errors = [];
    this.frags = frags;
  }

  execute(node: GNode | null, sels: Selection[]): Record<string, unknown> | null {
    if (node === null) return null;
    const out: Record<string, unknown> = {};
    for (const sel of sels) {
      if (sel.kind === 'frag') {
        if (sel.name !== null) {
          const def = this.frags.get(sel.name);
          if (!def) {
            this.errors.push({ message: `Unknown fragment "${sel.name}".` });
            continue;
          }
          if (def.typeCond && def.typeCond !== node.t) continue;
          const sub = this.execute(node, def.sels);
          if (sub) Object.assign(out, sub);
          continue;
        }
        if (sel.typeCond && sel.typeCond !== node.t) continue;
        const sub = this.execute(node, sel.sels);
        if (sub) Object.assign(out, sub);
        continue;
      }
      const key = sel.alias ?? sel.name;
      const allowed = ALLOWED[node.t] ?? [];
      if (!allowed.includes(sel.name)) {
        this.errors.push({ message: `Cannot query field "${sel.name}" on type "${node.t}".` });
        out[key] = null;
        continue;
      }
      const value = this.resolveField(node, sel);
      out[key] = this.materialize(value, sel.sels);
    }
    return out;
  }

  materialize(value: unknown, sels: Selection[] | null): unknown {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) {
      if (sels === null) return value;
      return value.map((v) => {
        if (v !== null && typeof v === 'object' && 't' in (v as Record<string, unknown>)) {
          return this.execute(v as GNode, sels);
        }
        return v;
      });
    }
    if (typeof value === 'object' && 't' in (value as Record<string, unknown>)) {
      if (sels === null) return null;
      return this.execute(value as GNode, sels);
    }
    return value;
  }

  resolveField(node: GNode, field: FieldSel): unknown {
    const args = argMap(field, this.vars);
    const store = this.store;
    switch (node.t) {
      case 'Query': {
        switch (field.name) {
          case 'viewer':
            return userNode(this.ctx.viewer.login);
          case 'repository': {
            const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
            return repo ? repoNode(repo) : null;
          }
          case 'node': {
            const resolved = store.resolveGlobalId(String(args.id ?? ''));
            if (!resolved) return null;
            if (resolved.kind === 'repo') return repoNode(resolved.repo);
            return null;
          }
          case '__type': {
            const name = String(args.name ?? '');
            return {
              t: '__Type',
              name,
              fields: TYPE_FIELDS[name] ?? [],
              enumValues: TYPE_ENUM_VALUES[name] ?? [],
            } as GNode;
          }
          case '__schema':
            return { t: '__Schema' } as GNode;
          default:
            return null;
        }
      }
      case 'Mutation': {
        switch (field.name) {
          case 'createIssue': {
            const input = (args.input ?? {}) as Record<string, unknown>;
            const resolved = store.resolveGlobalId(String(input.repositoryId ?? ''));
            if (!resolved || resolved.kind !== 'repo') {
              this.errors.push({ message: 'repository does not exist' });
              return null;
            }
            const labels = Array.isArray(input.labels) ? (input.labels as string[]) : [];
            const created = store.createIssue(resolved.repo, String(input.title ?? ''), String(input.body ?? ''), labels);
            if ('error' in created) {
              this.errors.push({ message: 'label does not exist' });
              return null;
            }
            return { t: 'CreateIssuePayload', issue: issueNode(resolved.repo, created), clientMutationId: input.clientMutationId ?? null } as GNode;
          }
          case 'closeIssue': {
            const input = (args.input ?? {}) as Record<string, unknown>;
            const resolved = store.resolveGlobalId(String(input.issueId ?? ''));
            if (!resolved || resolved.kind !== 'issue') {
              this.errors.push({ message: 'issue does not exist' });
              return null;
            }
            const issue = store.getIssue(resolved.repo, resolved.number);
            if (!issue) {
              this.errors.push({ message: 'issue does not exist' });
              return null;
            }
            issue.state = 'closed';
            // The REST JSON cache names the old state: drop it so a later
            // GET rebuilds from the new one (same rule as the REST PATCH).
            issue.jsonCache = null;
            return { t: 'CloseIssuePayload', issue: issueNode(resolved.repo, issue), clientMutationId: input.clientMutationId ?? null } as GNode;
          }
          case 'createPullRequest': {
            const input = (args.input ?? {}) as Record<string, unknown>;
            const resolved = store.resolveGlobalId(String(input.repositoryId ?? ''));
            if (!resolved || resolved.kind !== 'repo') {
              this.errors.push({ message: 'repository does not exist' });
              return null;
            }
            const created = store.createPR(
              resolved.repo,
              String(input.title ?? ''),
              String(input.body ?? ''),
              String(input.headRefName ?? ''),
              String(input.baseRefName ?? ''),
            );
            if ('error' in created) {
              this.errors.push({ message: 'branch does not exist' });
              return null;
            }
            return { t: 'CreatePullRequestPayload', pullRequest: prNode(resolved.repo, created), clientMutationId: input.clientMutationId ?? null } as GNode;
          }
          case 'mergePullRequest': {
            const input = (args.input ?? {}) as Record<string, unknown>;
            const resolved = store.resolveGlobalId(String(input.pullRequestId ?? ''));
            if (!resolved || resolved.kind !== 'pr') {
              this.errors.push({ message: 'pull request does not exist' });
              return null;
            }
            const pr = store.getPR(resolved.repo, resolved.number);
            if (!pr) {
              this.errors.push({ message: 'pull request does not exist' });
              return null;
            }
            const result = store.mergePR(resolved.repo, pr);
            if ('error' in result) {
              if (result.error === 'conflict') {
                this.errors.push({ message: 'merge conflict' });
              } else {
                this.errors.push({ message: 'pull request is already closed' });
              }
              return { t: 'MergePullRequestPayload', pullRequest: prNode(resolved.repo, pr), clientMutationId: input.clientMutationId ?? null } as GNode;
            }
            return { t: 'MergePullRequestPayload', pullRequest: prNode(resolved.repo, pr), clientMutationId: input.clientMutationId ?? null } as GNode;
          }
          case 'addComment': {
            const input = (args.input ?? {}) as Record<string, unknown>;
            const resolved = store.resolveGlobalId(String(input.subjectId ?? ''));
            if (!resolved || resolved.kind !== 'issue') {
              this.errors.push({ message: 'subject does not exist' });
              return null;
            }
            const comment = store.addComment(resolved.repo, resolved.number, String(input.body ?? ''));
            if (!comment) {
              this.errors.push({ message: 'issue does not exist' });
              return null;
            }
            const commentNode: GNode = { t: 'Comment', repo: resolved.repo, comment };
            return {
              t: 'AddCommentPayload',
              commentEdge: { t: 'CommentEdge', node: commentNode, cursor: makeCursor(resolved.repo.id, comment.id) } as GNode,
              clientMutationId: input.clientMutationId ?? null,
            } as GNode;
          }
          default:
            return null;
        }
      }
      case 'Repository': {
        const repo = node.repo as Repo;
        switch (field.name) {
          case 'id':
            return store.repoGlobalId(repo);
          case 'databaseId':
            return repo.id;
          case 'name':
            return repo.name;
          case 'nameWithOwner':
            return `${repo.owner}/${repo.name}`;
          case 'owner':
            return userNode(repo.owner);
          case 'defaultBranchRef': {
            const tip = store.resolveRef(repo, repo.defaultBranch);
            return tip ? ({ t: 'Ref', name: repo.defaultBranch } as GNode) : null;
          }
          case 'viewerPermission':
            return 'ADMIN';
          case 'hasIssuesEnabled':
            return true;
          case 'description':
            return repo.description;
          case 'url':
            return `https://github.com/${repo.owner}/${repo.name}`;
          case 'createdAt':
            return '2025-01-01T00:00:00.000Z';
          case 'issue': {
            const issue = store.getIssue(repo, Number(args.number));
            return issue ? issueNode(repo, issue) : null;
          }
          case 'issues': {
            const states = Array.isArray(args.states) ? (args.states as string[]) : [];
            const wanted = new Set(states.map((s) => String(s).toLowerCase()));
            let list = [...repo.issues];
            if (wanted.size > 0) list = list.filter((i) => wanted.has(i.state));
            const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
            const dir = String(orderBy.direction ?? 'DESC').toUpperCase() === 'ASC' ? 1 : -1;
            list.sort((a, b) => (a.seq - b.seq) * dir || (a.number - b.number) * dir);
            const afterSeq = parseCursor(args.after);
            if (afterSeq !== null) {
              const idx = list.findIndex((i) => i.seq === afterSeq);
              if (idx >= 0) list = list.slice(idx + 1);
            }
            const first = typeof args.first === 'number' ? Math.min(Math.max(args.first, 0), 100) : 30;
            const page = list.slice(0, first);
            const hasNextPage = list.length > first;
            const endCursor = page.length > 0 ? makeCursor(repo.id, page[page.length - 1].seq) : null;
            return {
              t: 'IssueConnection',
              nodes: page.map((i) => issueNode(repo, i)),
              hasNextPage,
              endCursor,
            } as GNode;
          }
          case 'pullRequests': {
            const first = typeof args.first === 'number' ? Math.min(Math.max(args.first, 0), 100) : 30;
            const list = [...repo.prs].sort((a, b) => b.seq - a.seq).slice(0, first);
            return {
              t: 'PullRequestConnection',
              nodes: list.map((p) => prNode(repo, p)),
              hasNextPage: repo.prs.length > first,
              endCursor: list.length > 0 ? makeCursor(repo.id, list[list.length - 1].seq) : null,
            } as GNode;
          }
          case 'pullRequest': {
            const pr = store.getPR(repo, Number(args.number));
            return pr ? prNode(repo, pr) : null;
          }
          default:
            return null;
        }
      }
      case 'Issue': {
        const repo = node.repo as Repo;
        const issue = node.issue as Issue;
        switch (field.name) {
          case 'id':
            return store.issueGlobalId(repo, issue);
          case 'number':
            return issue.number;
          case 'title':
            return issue.title;
          case 'state':
            return issue.state === 'open' ? 'OPEN' : 'CLOSED';
          case 'body':
            return issue.body;
          case 'url':
            return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
          case 'createdAt':
            return '2025-01-01T00:00:00.000Z';
          case 'author':
            return userNode(this.ctx.viewer.login);
          case 'comments': {
            const list = repo.comments.get(issue.number) ?? [];
            return {
              t: 'CommentConnection',
              nodes: list.map((c: Comment) => ({ t: 'Comment', repo, comment: c } as GNode)),
              hasNextPage: false,
              endCursor: null,
            } as GNode;
          }
          case 'labels':
            return {
              t: 'LabelConnection',
              nodes: issue.labels.map((name) => ({ t: 'Label', name, color: repo.labels.get(name)?.color ?? 'ededed' } as GNode)),
              hasNextPage: false,
              endCursor: null,
            } as GNode;
          default:
            return null;
        }
      }
      case 'PullRequest': {
        const repo = node.repo as Repo;
        const pr = node.pr as PullRequest;
        switch (field.name) {
          case 'id':
            return store.prGlobalId(repo, pr);
          case 'number':
            return pr.number;
          case 'title':
            return pr.title;
          case 'body':
            return pr.body;
          case 'state':
            return pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
          case 'merged':
            return pr.merged;
          case 'headRefName':
            return pr.headRef;
          case 'baseRefName':
            return pr.baseRef;
          case 'mergeable':
            return computeMergeable(store, repo, pr);
          case 'files': {
            const first = typeof args.first === 'number' ? Math.min(Math.max(args.first, 0), 100) : 30;
            const files = store.prFiles(repo, pr).slice(0, first);
            return {
              t: 'PullRequestChangedFileConnection',
              nodes: files.map((f) => ({ t: 'PullRequestChangedFile', path: f.filename, additions: f.additions, deletions: f.deletions, changes: f.changes, status: f.status } as GNode)),
              hasNextPage: false,
              endCursor: null,
            } as GNode;
          }
          case 'url':
            return `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`;
          case 'author':
            return userNode(this.ctx.viewer.login);
          case 'createdAt':
            return '2025-01-01T00:00:00.000Z';
          default:
            return null;
        }
      }
      case 'User': {
        switch (field.name) {
          case 'login':
            return String(node.login ?? '');
          case 'id':
            return b64urlEncode(`user:${VIEWER.id}`);
          case 'name':
            return VIEWER.name;
          case 'url':
            return `https://github.com/${String(node.login ?? '')}`;
          default:
            return null;
        }
      }
      case 'IssueConnection':
      case 'PullRequestConnection':
      case 'PullRequestChangedFileConnection':
      case 'CommentConnection':
      case 'LabelConnection': {
        switch (field.name) {
          case 'nodes':
            return (node.nodes as GNode[]) ?? [];
          case 'pageInfo':
            return { t: 'PageInfo', hasNextPage: node.hasNextPage ?? false, endCursor: node.endCursor ?? null } as GNode;
          case 'totalCount':
            return ((node.nodes as GNode[]) ?? []).length;
          default:
            return null;
        }
      }
      case 'PageInfo': {
        switch (field.name) {
          case 'hasNextPage':
            return node.hasNextPage ?? false;
          case 'hasPreviousPage':
            return false;
          case 'endCursor':
            return node.endCursor ?? null;
          case 'startCursor':
            return null;
          default:
            return null;
        }
      }
      case 'Ref': {
        switch (field.name) {
          case 'name':
            return String(node.name ?? '');
          case 'prefix':
            return 'refs/heads/';
          case 'target':
            return null;
          default:
            return null;
        }
      }
      case 'PullRequestChangedFile': {
        switch (field.name) {
          case 'path':
            return String(node.path ?? '');
          case 'additions':
            return node.additions ?? 0;
          case 'deletions':
            return node.deletions ?? 0;
          case 'changes':
            return node.changes ?? 0;
          case 'status':
            return String(node.status ?? 'changed').toUpperCase();
          default:
            return null;
        }
      }
      case 'CreateIssuePayload':
      case 'CloseIssuePayload': {
        if (field.name === 'issue') return (node.issue as GNode) ?? null;
        if (field.name === 'clientMutationId') return node.clientMutationId ?? null;
        return null;
      }
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload': {
        if (field.name === 'pullRequest') return (node.pullRequest as GNode) ?? null;
        if (field.name === 'clientMutationId') return node.clientMutationId ?? null;
        return null;
      }
      case 'AddCommentPayload': {
        if (field.name === 'commentEdge') return (node.commentEdge as GNode) ?? null;
        if (field.name === 'clientMutationId') return node.clientMutationId ?? null;
        return null;
      }
      case 'CommentEdge': {
        if (field.name === 'node') return (node.node as GNode) ?? null;
        if (field.name === 'cursor') return String(node.cursor ?? '');
        return null;
      }
      case 'Comment': {
        const comment = node.comment as Comment;
        switch (field.name) {
          case 'id':
            return store.commentGlobalId(node.repo as Repo, comment);
          case 'body':
            return comment.body;
          case 'author':
            return userNode(this.ctx.viewer.login);
          case 'url':
            return '';
          case 'createdAt':
            return '2025-01-01T00:00:00.000Z';
          default:
            return null;
        }
      }
      case 'Label': {
        switch (field.name) {
          case 'name':
            return String(node.name ?? '');
          case 'color':
            return String(node.color ?? 'ededed');
          case 'id':
            return b64urlEncode(`label:${String(node.name ?? '')}`);
          default:
            return null;
        }
      }
      case '__Type': {
        switch (field.name) {
          case 'name':
            return String(node.name ?? '');
          case 'kind': {
            const name = String(node.name ?? '');
            return TYPE_ENUM_VALUES[name] !== undefined && TYPE_FIELDS[name] === undefined ? 'ENUM' : 'OBJECT';
          }
          case 'fields':
            return ((node.fields as string[]) ?? []).map((n) => ({ t: '__Field', name: n } as GNode));
          case 'enumValues':
            return ((node.enumValues as string[]) ?? []).map((n) => ({ t: '__EnumValue', name: n } as GNode));
          case 'description':
            return null;
          default:
            return null;
        }
      }
      case '__Schema': {
        switch (field.name) {
          case 'queryType':
            return { t: '__Type', name: 'Query', fields: TYPE_FIELDS.Query ?? [], enumValues: [] } as GNode;
          case 'mutationType':
            return { t: '__Type', name: 'Mutation', fields: TYPE_FIELDS.Mutation ?? [], enumValues: [] } as GNode;
          case 'subscriptionType':
            return null;
          case 'types':
            return [];
          case 'directives':
            return [];
          case 'description':
            return null;
          default:
            return null;
        }
      }
      case '__Field': {
        switch (field.name) {
          case 'name':
            return String(node.name ?? '');
          case 'description':
            return null;
          case 'args':
            return [];
          case 'type':
            return { t: '__Type', name: 'String', fields: [], enumValues: [] } as GNode;
          default:
            return null;
        }
      }
      case '__EnumValue': {
        switch (field.name) {
          case 'name':
            return String(node.name ?? '');
          case 'description':
            return null;
          default:
            return null;
        }
      }
      case '__InputValue': {
        switch (field.name) {
          case 'name':
            return String(node.name ?? '');
          case 'description':
            return null;
          case 'type':
            return { t: '__Type', name: 'String', fields: [], enumValues: [] } as GNode;
          default:
            return null;
        }
      }
      default:
        return null;
    }
  }
}

// ------------------------------------------------------------------ handler
interface GraphqlOp {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function executeOperation(op: GraphqlOp, ctx: Ctx): Record<string, unknown> {
  try {
    if (!op || typeof op !== 'object' || typeof op.query !== 'string') {
      return { data: null, errors: [{ message: 'query must be a string' }] };
    }
    const varsRaw = op.variables;
    const vars: Record<string, unknown> =
      varsRaw !== null && typeof varsRaw === 'object' && !Array.isArray(varsRaw)
        ? (varsRaw as Record<string, unknown>)
        : {};
    let doc: Document;
    try {
      doc = new Parser(tokenize(op.query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Failed to parse query' }] };
    }
    let operation: Operation | undefined;
    if (typeof op.operationName === 'string' && op.operationName !== '') {
      operation = doc.ops.find((o) => o.name === op.operationName);
      if (!operation) {
        return { data: null, errors: [{ message: `Unknown operation named "${op.operationName}".` }] };
      }
    } else {
      operation = doc.ops[0];
    }
    if (!operation) {
      return { data: null, errors: [{ message: 'No operation found in query document' }] };
    }
    if (operation.opType === 'subscription') {
      return { data: null, errors: [{ message: 'Subscriptions are not supported.' }] };
    }
    const executor = new Executor(ctx.store, ctx, vars, doc.frags);
    const root: GNode = { t: operation.opType === 'mutation' ? 'Mutation' : 'Query' };
    const data = executor.execute(root, operation.sels);
    if (executor.errors.length > 0) {
      return { data: null, errors: executor.errors };
    }
    return { data };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Internal error' }] };
  }
}

export async function handleGraphql(req: Req, ctx: Ctx): Promise<Resp> {
  if (req.method !== 'POST') {
    return errResp(404, 'Not Found');
  }
  const auth = requireAuth(req, ctx);
  if (auth) return auth;
  if (req.jsonError || req.json === undefined) {
    return errResp(400, 'Invalid JSON body');
  }
  const body = req.json;
  if (Array.isArray(body)) {
    const out = body.map((op) => executeOperation(op as GraphqlOp, ctx));
    return jsonResp(200, out);
  }
  if (body !== null && typeof body === 'object') {
    return jsonResp(200, executeOperation(body as GraphqlOp, ctx));
  }
  return errResp(400, 'Invalid JSON body');
}
