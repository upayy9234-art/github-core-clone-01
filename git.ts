// Git smart HTTP: upload-pack (protocol v2 + v0 fallback), receive-pack
// (v0), packfile read/write, pkt-line framing.
//
// Implemented from the kit's checks-git.ts / git-client.ts (see SPEC-git.md).
// Plain (no-delta) packs are what we send; the reader also resolves
// OFS_DELTA / REF_DELTA entries (thin packs) so a delta pack never breaks us.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  ZERO_OID,
  parseCommit,
  parseTree,
  type GitObject,
  type ObjType,
  type Repo,
} from './store.ts';
import { errResp, requireAuth, type Ctx, type Handler, type Req, type Resp } from './http.ts';

// ---------------------------------------------------------------- pkt-lines
const PKT_MAX = 65520;

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'end';
  data: Buffer;
}

/** Parse a pkt-line stream. With `stopAtFlush`, returns just past the first flush packet (a pack may follow it, as in receive-pack). Otherwise parses to the end of the buffer. Throws on malformed input. */
function parsePktLines(buf: Buffer, opts: { stopAtFlush?: boolean } = {}): { packets: Pkt[]; end: number } {
  const packets: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const lenHex = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) throw new Error('not a pkt-line');
    const len = parseInt(lenHex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', data: Buffer.alloc(0) });
      i += 4;
      if (opts.stopAtFlush) return { packets, end: i };
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', data: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end', data: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (len > PKT_MAX || i + len > buf.length) throw new Error('pkt-line truncated or too long');
    packets.push({ kind: 'data', data: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { packets, end: i };
}

function pktText(p: Pkt): string {
  return p.data.toString('utf8');
}

// ---------------------------------------------------------------- packfiles
const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

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

/** Whether this Node's inflateSync reports the consumed input length: with
 * `{ info: true }` it returns `{ buffer, engine }` and `engine.bytesWritten`
 * is exactly how many input bytes the zlib stream consumed. Probed once at
 * load; the binary search below is the fallback for a Node without it. */
const INFLATE_INFO_OK: boolean = (() => {
  try {
    const probe = inflateSync(deflateSync(Buffer.from('perf-probe')), { info: true }) as unknown as {
      engine?: { bytesWritten?: unknown };
    };
    return typeof probe?.engine?.bytesWritten === 'number';
  } catch {
    return false;
  }
})();

/** Inflate the zlib stream starting at `offset`; returns the data and the offset just past the stream. */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  if (INFLATE_INFO_OK) {
    // One inflate instead of a binary search of ~log2(n) inflates: the engine
    // reports exactly how many input bytes the stream consumed, and trailing
    // bytes (the next entry, the pack trailer) are tolerated.
    const { buffer, engine } = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number; close?: () => void };
    };
    const next = offset + engine.bytesWritten;
    try {
      engine.close?.();
    } catch {
      // The handle is already spent; nothing to close.
    }
    return { data: buffer, next };
  }
  let lo = offset;
  let hi = buf.length;
  let ans = -1;
  let ansData: Buffer | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const out = inflateSync(buf.subarray(offset, mid));
      ans = mid;
      ansData = out;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (ans < 0 || ansData === null) throw new Error('bad zlib stream in pack');
  return { data: ansData, next: ans };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readDeltaVarint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[i];
      i += 1;
      v |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return v;
  };
  const srcSize = readDeltaVarint();
  const tgtSize = readDeltaVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  let outLen = 0;
  while (i < delta.length) {
    const op = delta[i];
    i += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          offset |= delta[i] << (bit * 8);
          i += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          size |= delta[i] << (bit * 8);
          i += 1;
        }
      }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      parts.push(delta.subarray(i, i + op));
      outLen += op;
      i += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (outLen !== tgtSize) throw new Error('delta target size mismatch');
  return Buffer.concat(parts, outLen);
}

export interface ParsedPack {
  objects: Array<{ oid: string; type: ObjType; data: Buffer }>;
}

/** Parse a packfile (plain entries and deltas). `resolveBase` supplies objects for thin packs. */
function readPack(buf: Buffer, resolveBase?: (oid: string) => GitObject | undefined): ParsedPack {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = buf.readUInt32BE(8);
  interface RawEntry {
    offset: number;
    type: number;
    data: Buffer;
    baseOid?: string;
    baseOffset?: number;
  }
  const raw: RawEntry[] = [];
  let i = 12;
  for (let n = 0; n < count; n += 1) {
    const entryOffset = i;
    const typeNum = (buf[i] >> 4) & 0x07;
    let size = buf[i] & 0x0f;
    let shift = 4;
    while (buf[i] & 0x80) {
      i += 1;
      size |= (buf[i] & 0x7f) << shift;
      shift += 7;
    }
    i += 1;
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeNum === 6) {
      // OFS_DELTA: git's offset encoding (value+1)<<7 per continuation byte.
      let b = buf[i];
      i += 1;
      let value = b & 0x7f;
      while (b & 0x80) {
        b = buf[i];
        i += 1;
        value = ((value + 1) << 7) | (b & 0x7f);
      }
      baseOffset = entryOffset - value;
    } else if (typeNum === 7) {
      baseOid = buf.subarray(i, i + 20).toString('hex');
      i += 20;
    }
    const inf = inflateAt(buf, i);
    i = inf.next;
    void size;
    raw.push({ offset: entryOffset, type: typeNum, data: inf.data, baseOid, baseOffset });
  }
  // Resolve in pack order: a delta's base always precedes it (OFS) or is
  // already in the repo / earlier in the pack (REF).
  const objects: Array<{ oid: string; type: ObjType; data: Buffer }> = [];
  const byOffset = new Map<number, { type: ObjType; data: Buffer }>();
  const byOid = new Map<string, { type: ObjType; data: Buffer }>();
  const resolveEntry = (entry: RawEntry, depth: number): { type: ObjType; data: Buffer } => {
    if (depth > 64) throw new Error('delta chain too deep');
    if (entry.type >= 1 && entry.type <= 4) {
      return { type: CODE_TYPES[entry.type], data: entry.data };
    }
    let base: { type: ObjType; data: Buffer } | undefined;
    if (entry.type === 6 && entry.baseOffset !== undefined) {
      base = byOffset.get(entry.baseOffset);
      if (!base) throw new Error('ofs-delta base not found');
    } else if (entry.type === 7 && entry.baseOid) {
      base = byOid.get(entry.baseOid);
      if (!base && resolveBase) {
        const ext = resolveBase(entry.baseOid);
        if (ext) base = ext;
      }
      if (!base) throw new Error('ref-delta base not found');
    } else {
      throw new Error('unknown pack entry type');
    }
    return { type: base.type, data: applyDelta(base.data, entry.data) };
  };
  for (const entry of raw) {
    const r = resolveEntry(entry, 0);
    const head = Buffer.from(`${r.type} ${r.data.length}\0`, 'ascii');
    const oid = createHash('sha1').update(head).update(r.data).digest('hex');
    byOffset.set(entry.offset, r);
    byOid.set(oid, r);
    objects.push({ oid, type: r.type, data: r.data });
  }
  return { objects };
}

/** Build a plain (no-delta) pack from objects, in deterministic order. */
function writePack(objects: Map<string, GitObject>): Buffer {
  const sorted = [...objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const [, obj] of sorted) {
    const typeNum = TYPE_CODES[obj.type];
    parts.push(encodePackEntryHeader(typeNum, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const trailer = createHash('sha1').update(Buffer.concat(parts)).digest();
  parts.push(trailer);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ref helpers
interface RefInfo {
  name: string;
  oid: string;
  peeled?: string;
}

function listRefs(repo: Repo): RefInfo[] {
  const out: RefInfo[] = [];
  for (const [name, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const info: RefInfo = { name, oid };
    const obj = repo.objects.get(oid);
    if (name.startsWith('refs/tags/') && obj && obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (m) info.peeled = m[1];
    }
    out.push(info);
  }
  return out;
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The v0 advertisement ref lines (without the "# service=" preamble). */
function v0RefLines(repo: Repo, caps: string): Buffer[] {
  const refs = listRefs(repo);
  const parts: Buffer[] = [];
  const capsText = caps;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capsText}\n`));
  } else {
    refs.forEach((r, idx) => {
      const first = idx === 0 ? `\0${capsText}` : '';
      parts.push(pktLine(`${r.oid} ${r.name}${first}\n`));
      if (r.peeled) parts.push(pktLine(`${r.peeled} ${r.name}^{}\n`));
    });
  }
  parts.push(FLUSH);
  return parts;
}

const UPLOAD_CAPS = 'side-band-64k ofs-delta agent=github-core-clone/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=github-core-clone/1.0';

// ---------------------------------------------------------------- handlers
export const handleGit: Handler = async (req: Req, ctx: Ctx): Promise<Resp> => {
  const auth = requireAuth(req, ctx);
  if (auth) return auth;
  const segments = req.segments;
  // /{owner}/{repo}.git/...
  const owner = segments[0];
  const repoName = segments[1].slice(0, -4);
  const rest = segments.slice(2);
  const repo = ctx.store.getRepo(owner, repoName);
  const service = req.query.get('service') ?? '';

  if (req.method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    if (!repo) return errResp(404, 'Not Found');
    if (service === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (v2) {
        const body = Buffer.concat([
          pktLine('version 2\n'),
          pktLine('agent=github-core-clone/1.0\n'),
          pktLine('ls-refs=unborn\n'),
          pktLine('fetch=shallow filter\n'),
          pktLine('object-format=sha1\n'),
          FLUSH,
        ]);
        return { status: 200, raw: body, contentType: 'application/x-git-upload-pack-advertisement' };
      }
      const body = Buffer.concat([
        pktLine('# service=git-upload-pack\n'),
        FLUSH,
        ...v0RefLines(repo, `${UPLOAD_CAPS} symref=HEAD:${headTarget(repo)}`),
      ]);
      return { status: 200, raw: body, contentType: 'application/x-git-upload-pack-advertisement' };
    }
    if (service === 'git-receive-pack') {
      const body = Buffer.concat([
        pktLine('# service=git-receive-pack\n'),
        FLUSH,
        ...v0RefLines(repo, `${RECEIVE_CAPS} symref=HEAD:${headTarget(repo)}`),
      ]);
      return { status: 200, raw: body, contentType: 'application/x-git-receive-pack-advertisement' };
    }
    return errResp(404, 'Not Found');
  }

  if (req.method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
    if (!repo) return errResp(404, 'Not Found');
    return uploadPack(req, ctx, repo);
  }

  if (req.method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
    if (!repo) return errResp(404, 'Not Found');
    return receivePack(req, ctx, repo);
  }

  return errResp(404, 'Not Found');
};

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const slice = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

async function uploadPack(req: Req, ctx: Ctx, repo: Repo): Promise<Resp> {
  let parsed;
  try {
    parsed = parsePktLines(req.rawBody);
  } catch {
    return errResp(400, 'bad pkt-line stream');
  }
  const lines = parsed.packets.filter((p) => p.kind === 'data').map((p) => pktText(p));
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  const command = lines.find((l) => l.startsWith('command='))?.slice('command='.length).trim();

  if (isV2 && command === 'ls-refs') {
    return lsRefs(req, ctx, repo, lines);
  }
  if (command === 'fetch' || (!isV2 && lines.some((l) => l.startsWith('want ')))) {
    return fetchPack(req, ctx, repo, lines, isV2);
  }
  if (isV2 && command !== 'ls-refs' && command !== 'fetch') {
    return errResp(400, `unknown command ${command ?? ''}`);
  }
  // v0 fetch without a parseable command: treat like a fetch attempt.
  return fetchPack(req, ctx, repo, lines, false);
}

function lsRefs(_req: Req, _ctx: Ctx, repo: Repo, lines: string[]): Resp {
  const wantPeel = lines.some((l) => l.trim() === 'peel');
  const wantSymrefs = lines.some((l) => l.trim() === 'symrefs');
  const prefixes = lines.filter((l) => l.startsWith('ref-prefix ')).map((l) => l.slice('ref-prefix '.length).trim());
  const refs = listRefs(repo);
  const out: Buffer[] = [];
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (wantSymrefs && matches('HEAD')) {
    const tip = repo.refs.get(headTarget(repo));
    if (tip) out.push(pktLine(`${tip} HEAD symref-target:${headTarget(repo)}\n`));
    else out.push(pktLine(`unborn HEAD symref-target:${headTarget(repo)}\n`));
  }
  for (const r of refs) {
    if (!matches(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (r.peeled && wantPeel) line += ` peeled:${r.peeled}`;
    out.push(pktLine(`${line}\n`));
  }
  out.push(FLUSH);
  return { status: 200, raw: Buffer.concat(out), contentType: 'application/x-git-upload-pack-result' };
}

function fetchPack(_req: Req, ctx: Ctx, repo: Repo, lines: string[], isV2: boolean): Resp {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let deepen: number | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallows.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) deepen = parseInt(line.slice(7).trim(), 10);
  }
  // Exclusion: objects the client already holds. Its shallow boundaries cut
  // parent traversal, so a deepen never re-sends (or wrongly excludes) history.
  const cut = new Set(shallows.map((s) => s.toLowerCase()));
  const excl = ctx.store.reachable(repo, haves, { cut });
  const excludeSet = new Set(excl.objects.keys());
  const { objects, shallow } = ctx.store.reachable(repo, wants, { exclude: excludeSet, depth: deepen });
  const pack = writePack(objects);
  // Unshallow: old boundaries whose parent is now delivered.
  const delivered = new Set(objects.keys());
  const unshallow: string[] = [];
  for (const b of shallows) {
    const bl = b.toLowerCase();
    if (shallow.includes(bl)) continue;
    const obj = repo.objects.get(bl);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.some((p) => delivered.has(p.toLowerCase()))) unshallow.push(bl);
  }

  if (isV2) {
    const out: Buffer[] = [];
    out.push(pktLine('acknowledgments\n'));
    out.push(pktLine('NAK\n'));
    out.push(FLUSH);
    if (shallow.length > 0 || unshallow.length > 0) {
      out.push(pktLine('shallow-info\n'));
      for (const s of shallow) out.push(pktLine(`shallow ${s}\n`));
      for (const s of unshallow) out.push(pktLine(`unshallow ${s}\n`));
      out.push(FLUSH);
    }
    out.push(pktLine('packfile\n'));
    out.push(...sidebandPackets(pack));
    out.push(FLUSH);
    return { status: 200, raw: Buffer.concat(out), contentType: 'application/x-git-upload-pack-result' };
  }
  // v0: NAK + shallow/unshallow lines, then sideband packets directly.
  const out: Buffer[] = [];
  out.push(pktLine('NAK\n'));
  for (const s of shallow) out.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallow) out.push(pktLine(`unshallow ${s}\n`));
  out.push(...sidebandPackets(pack));
  return { status: 200, raw: Buffer.concat(out), contentType: 'application/x-git-upload-pack-result' };
}

async function receivePack(req: Req, ctx: Ctx, repo: Repo): Promise<Resp> {
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  let packOffset = req.rawBody.length;
  let sideband = false;
  try {
    const parsed = parsePktLines(req.rawBody, { stopAtFlush: true });
    let seenFlush = false;
    for (const p of parsed.packets) {
      if (p.kind === 'flush') {
        seenFlush = true;
        packOffset = parsed.end;
        break;
      }
      if (p.kind !== 'data') continue;
      const text = pktText(p);
      const nul = text.indexOf('\0');
      const caps = nul >= 0 ? text.slice(nul + 1) : '';
      const cmdText = (nul >= 0 ? text.slice(0, nul) : text).trim();
      if (caps.includes('side-band-64k')) sideband = true;
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(cmdText);
      if (!m) continue;
      commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
    }
    void seenFlush;
  } catch {
    // Malformed command stream: answer unpack failure, stay up.
    const report = 'unpack malformed command stream\n';
    return { status: 200, raw: Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(report, 'utf8')])), FLUSH]), contentType: 'application/x-git-receive-pack-result' };
  }

  // Unpack: store every object from the pack (if any bytes follow the flush).
  let unpackOk = true;
  let unpackDetail = '';
  const packBytes = req.rawBody.subarray(packOffset);
  if (packBytes.length > 0) {
    try {
      const parsed = readPack(packBytes, (oid) => ctx.store.getObject(repo, oid));
      for (const obj of parsed.objects) {
        if (!repo.objects.has(obj.oid)) repo.objects.set(obj.oid, { type: obj.type, data: obj.data });
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'pack parse failed';
    }
  }

  const reportLines: string[] = [];
  if (unpackOk) reportLines.push('unpack ok');
  else reportLines.push(`unpack ${unpackDetail || 'failed'}`);
  for (const cmd of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${cmd.ref} unpack failed`);
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (!current) {
        reportLines.push(`ng ${cmd.ref} ref does not exist`);
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid.toLowerCase() !== current.toLowerCase()) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      } else {
        repo.refs.delete(cmd.ref);
        reportLines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current) {
        reportLines.push(`ng ${cmd.ref} already exists`);
      } else if (!repo.objects.has(cmd.newOid.toLowerCase())) {
        reportLines.push(`ng ${cmd.ref} object not found`);
      } else {
        repo.refs.set(cmd.ref, cmd.newOid.toLowerCase());
        reportLines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    // Update: must fast-forward from the advertised old value.
    if (!current || current.toLowerCase() !== cmd.oldOid.toLowerCase()) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward`);
    } else if (!ctx.store.isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward`);
    } else if (!repo.objects.has(cmd.newOid.toLowerCase())) {
      reportLines.push(`ng ${cmd.ref} object not found`);
    } else {
      repo.refs.set(cmd.ref, cmd.newOid.toLowerCase());
      reportLines.push(`ok ${cmd.ref}`);
    }
  }

  const reportText = reportLines.map((l) => `${l}\n`).join('');
  if (sideband) {
    // The report-status stream inside band 1 is itself pkt-line framed:
    // demuxed band-1 bytes are parsed as pkt-lines by the client.
    const framed = Buffer.concat(reportLines.map((l) => pktLine(`${l}\n`)));
    const parts: Buffer[] = [];
    for (let i = 0; i < framed.length; i += 65515) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), framed.subarray(i, Math.min(framed.length, i + 65515))])));
    }
    parts.push(FLUSH);
    return { status: 200, raw: Buffer.concat(parts), contentType: 'application/x-git-receive-pack-result' };
  }
  const parts: Buffer[] = reportLines.map((l) => pktLine(`${l}\n`));
  parts.push(FLUSH);
  return { status: 200, raw: Buffer.concat(parts), contentType: 'application/x-git-receive-pack-result' };
}
