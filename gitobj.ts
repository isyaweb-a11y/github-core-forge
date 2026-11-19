// Git object primitives for the forge: SHA-1 object ids, tree/commit/tag parsing and building,
// packfile reading (with delta resolution) and writing (plain objects), pkt-lines and the git
// delta format. Pure node:crypto / node:zlib; no git binary anywhere, as the rules require.

import { createHash } from 'node:crypto';
import { createInflate, deflateSync } from 'node:zlib';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODES: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The SHA-1 of an object: sha1("<type> <size>\0" + bytes). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function isOid(text: string): boolean {
  return /^[0-9a-f]{40}$/.test(text);
}

// ---------------------------------------------------------------------------
// trees

export interface TreeEntry {
  /** As written in the tree object: "100644", "100755", "120000", "40000" for a subtree. */
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's bytes into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(pos, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree sort key: directories compare as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object's bytes from entries (sorted the way git sorts them). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object; extra headers (gpgsig, encoding, ...) are skipped, not kept. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  const fields = new Map<string, string>();
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) fields.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: fields.get('object') ?? '',
    type: fields.get('type') ?? '',
    tag: fields.get('tag') ?? '',
    tagger: fields.get('tagger') ?? '',
    message,
  };
}

/** "Name <email> 1739175597 +0000" -> the pieces a REST view wants. */
export function parseIdent(ident: string): { name: string; email: string; epochSec: number; tz: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(ident.trim());
  if (match === null) return { name: ident.trim(), email: '', epochSec: 0, tz: '+0000' };
  return { name: match[1]!, email: match[2]!, epochSec: Number(match[3]), tz: match[4]! };
}

export function formatIdent(name: string, email: string, epochSec: number): string {
  return `${name} <${email}> ${epochSec} +0000`;
}

// ---------------------------------------------------------------------------
// the git delta format

/** Apply a git delta (source-size varint, target-size varint, copy/insert ops) to a base. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('delta is truncated');
      const byte = delta[pos]!;
      pos += 1;
      value |= (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base is ${base.length} bytes, the delta wants ${sourceSize}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos]!;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          offset |= delta[pos]! * 2 ** (8 * bit);
          pos += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          size |= delta[pos]! * 2 ** (8 * bit);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) {
    throw new Error(`delta produced ${result.length} bytes, the header promised ${targetSize}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// packfiles

/** Inflate one zlib stream starting at `pos`; answers the data and the compressed bytes consumed. */
function inflateOne(buffer: Buffer, pos: number): Promise<{ data: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const stream = createInflate();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve({ data: Buffer.concat(chunks), consumed: stream.bytesWritten }));
    stream.end(buffer.subarray(pos));
  });
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  declaredCount: number;
  version: number;
}

/**
 * Read a whole packfile. Delta entries resolve against bases in the pack itself or, for a thin
 * pack, through `resolveExternal` (an object the receiving store already holds).
 */
export async function readPack(
  pack: Buffer,
  resolveExternal?: (oid: string) => GitObject | undefined,
): Promise<PackReadResult> {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  const declaredCount = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const checksum = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!checksum.equals(trailer)) throw new Error('pack checksum does not match its bytes');

  interface RawEntry {
    type: GitObjectType;
    data?: Buffer;
    deltaKind?: 'ofs' | 'ref';
    baseOid?: string;
    baseOffset?: number;
    start: number;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let pos = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const start = pos;
    let byte = pack[pos]!;
    pos += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos]!;
      pos += 1;
      size |= (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let entry: RawEntry;
    if (code === 6) {
      // OFS_DELTA: a negative offset back to the base entry's start.
      let offsetByte = pack[pos]!;
      pos += 1;
      let offset = offsetByte & 0x7f;
      while (offsetByte & 0x80) {
        offsetByte = pack[pos]!;
        pos += 1;
        offset = ((offset + 1) << 7) | (offsetByte & 0x7f);
      }
      entry = { type: 'blob', deltaKind: 'ofs', baseOffset: start - offset, start };
    } else if (code === 7) {
      // REF_DELTA: the base's object id.
      const baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      entry = { type: 'blob', deltaKind: 'ref', baseOid, start };
    } else {
      const type = CODE_TYPES[code];
      if (type === undefined) throw new Error(`pack entry has unknown type code ${code}`);
      entry = { type, start };
    }
    const { data, consumed } = await inflateOne(pack, pos);
    if (data.length !== size) throw new Error(`pack entry inflated to ${data.length} bytes, the header said ${size}`);
    pos += consumed;
    entry.data = data; // for a delta entry these are the delta bytes; resolveEntry applies them
    raw.push(entry);
    byOffset.set(start, entry);
  }

  const resolved = new Map<string, GitObject>();
  // Plain entries resolve at once, so a ref-delta can find its base by object id.
  const plainByOid = new Map<string, GitObject>();
  for (const entry of raw) {
    if (entry.deltaKind === undefined) {
      plainByOid.set(hashObject(entry.type, entry.data!), { type: entry.type, data: entry.data! });
    }
  }
  const resolveEntry = (entry: RawEntry, depth: number): GitObject => {
    if (depth > 64) throw new Error('delta chain is too deep');
    if (entry.deltaKind === undefined) return { type: entry.type, data: entry.data! };
    let base: GitObject;
    if (entry.deltaKind === 'ofs') {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (baseEntry === undefined) throw new Error('ofs-delta names a base outside the pack');
      base = resolveEntry(baseEntry, depth + 1);
    } else {
      const local = plainByOid.get(entry.baseOid!);
      if (local !== undefined) {
        base = local;
      } else {
        const external = resolveExternal?.(entry.baseOid!);
        if (external === undefined) throw new Error(`ref-delta base ${entry.baseOid} is not available`);
        base = external;
      }
    }
    const data = applyDelta(base.data, entry.data!);
    return { type: base.type, data };
  };
  for (const entry of raw) {
    const object = resolveEntry(entry, 0);
    resolved.set(hashObject(object.type, object.data), object);
  }
  return { objects: resolved, declaredCount, version };
}

/** Write a packfile of plain (never delta) objects; the trailer is the pack's SHA-1. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(TYPE_CODES[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function packObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// pkt-lines

export type PktLine = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 0xffff) throw new Error('pkt-line too long');
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Decode a buffer of pkt-lines; throws on a malformed length prefix. */
export function decodePktLines(buffer: Buffer, start = 0): { lines: PktLine[]; end: number } {
  const lines: PktLine[] = [];
  let pos = start;
  while (pos < buffer.length) {
    if (pos + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      lines.push({ kind: 'flush' });
      pos += 4;
      // A flush ends the pkt-line section; whatever follows is another protocol phase.
      return { lines, end: pos };
    }
    if (length === 1) {
      lines.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (length === 2) {
      lines.push({ kind: 'response-end' });
      pos += 4;
      continue;
    }
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (pos + length > buffer.length) throw new Error('truncated pkt-line payload');
    lines.push({ kind: 'data', payload: buffer.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { lines, end: pos };
}
