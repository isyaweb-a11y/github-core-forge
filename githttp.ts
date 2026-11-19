// Git smart HTTP: info/refs advertisements (protocol v0 and v2), git-upload-pack (v2 ls-refs and
// fetch, plus a v0 fetch fallback) and git-receive-pack (v0, report-status over side-band-64k).
// The protocol is implemented here, on the forge's own object store — no git binary, as the rules
// require. Object selection follows the classic rules: a fetch sends the closure of the wants,
// minus the closure of the haves (whose parent walk stops at the client's shallow boundary),
// cut at the requested depth, with the new shallow boundary reported in shallow-info.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PKT_FLUSH,
  decodePktLines,
  pktLine,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
  type PktLine,
} from './gitobj.ts';
import { parseCommit } from './gitobj.ts';
import type { Repo } from './store.ts';

const AGENT = 'forge/1.0';
const SIDEBAND_CHUNK = 65_000;

type Send = (status: number, body: Buffer, contentType: string) => void;

function pkt(text: string): Buffer {
  return pktLine(Buffer.from(text, 'utf8'));
}

/** Wrap a byte stream in side-band-64k band-1 packets. */
function sidebandWrap(stream: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < stream.length; offset += SIDEBAND_CHUNK) {
    const chunk = stream.subarray(offset, offset + SIDEBAND_CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (parts.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

/** A repository's refs for advertisement: HEAD first (when asked), then refs sorted by name. */
function advertisedRefs(repo: Repo): { name: string; oid: string }[] {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------------------
// info/refs

function v0Advertisement(repo: Repo, service: string): Buffer {
  const capabilities =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow no-progress symref=HEAD:${headTarget(repo)} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta quiet symref=HEAD:${headTarget(repo)} agent=${AGENT}`;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = advertisedRefs(repo);
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    const headOid = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
    parts.push(pkt(`${headOid} HEAD\0${capabilities}\n`));
    for (const ref of refs) {
      parts.push(pkt(`${ref.oid} ${ref.name}\n`));
      const peeled = repo.peelToCommit(ref.oid);
      if (peeled !== null && peeled !== ref.oid) parts.push(pkt(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow\n'),
    pkt('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

export function handleInfoRefs(
  req: IncomingMessage,
  send: Send,
  repo: Repo | null,
  service: string,
): void {
  if (repo === null) {
    send(404, Buffer.from('{"message":"Not Found"}\n'), 'application/json; charset=utf-8');
    return;
  }
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    send(400, Buffer.from('{"message":"unknown service"}\n'), 'application/json; charset=utf-8');
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
  const body = wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
  send(200, body, `application/x-${service}-advertisement`);
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsReply(repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      let line = `${headOid} HEAD`;
      if (args.symrefs) line += ` symref-target:${target}`;
      if (args.peel) {
        const peeled = repo.peelToCommit(headOid);
        if (peeled !== null && peeled !== headOid) line += ` peeled:${peeled}`;
      }
      parts.push(pkt(`${line}\n`));
    } else if (args.unborn) {
      parts.push(pkt(`unborn HEAD${args.symrefs ? ` symref-target:${target}` : ''}\n`));
    } else {
      parts.push(pkt(`${ZERO_OID} HEAD${args.symrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const ref of advertisedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const peeled = repo.peelToCommit(ref.oid);
      if (peeled !== null && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    parts.push(pkt(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch: object selection

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  common: string[];
}

/** Commit depths (1 = a want) by breadth-first walk over parents, limited to `limit`. */
function commitDepths(repo: Repo, wantCommits: readonly string[], limit: number): Map<string, number> {
  const depths = new Map<string, number>();
  let frontier = [...wantCommits];
  for (const oid of frontier) depths.set(oid, 1);
  let depth = 1;
  while (frontier.length > 0 && depth < limit) {
    const next: string[] = [];
    for (const oid of frontier) {
      const object = repo.getObject(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!depths.has(parent) && repo.getObject(parent)?.type === 'commit') {
          depths.set(parent, depth + 1);
          next.push(parent);
        }
      }
    }
    frontier = next;
    depth += 1;
  }
  return depths;
}

function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depthLimit: number | null,
): FetchPlan {
  const shallowSet = new Set(clientShallow);
  // What the client already holds: the haves' closure, not crossing its shallow boundary.
  const haveClosure = repo.reachableFrom(
    haves.filter((oid) => repo.getObject(oid) !== undefined),
    shallowSet,
  );

  // The wants, peeled to commits for the depth walk; tag objects ride along themselves.
  const wantCommits: string[] = [];
  const extraTips: string[] = [];
  for (const want of wants) {
    const object = repo.getObject(want);
    if (object === undefined) continue;
    if (object.type === 'commit') wantCommits.push(want);
    else {
      extraTips.push(want);
      const commit = repo.peelToCommit(want);
      if (commit !== null) wantCommits.push(commit);
    }
  }

  const limit = depthLimit ?? Number.POSITIVE_INFINITY;
  const depths = commitDepths(repo, wantCommits, limit);
  const includedCommits = new Set(depths.keys());

  const included = new Set<string>();
  for (const oid of extraTips) {
    for (const reachable of repo.reachableFrom([oid])) included.add(reachable);
  }
  for (const commit of includedCommits) {
    // A commit always travels with its whole tree.
    const info = parseCommit(repo.getObject(commit)!.data);
    included.add(commit);
    for (const reachable of repo.reachableFrom([info.tree])) included.add(reachable);
  }

  // The shallow bookkeeping: boundary commits are included ones with a parent left behind.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depthLimit !== null || clientShallow.length > 0) {
    for (const commit of includedCommits) {
      const info = parseCommit(repo.getObject(commit)!.data);
      const parentLeft = info.parents.some((parent) => !includedCommits.has(parent) && repo.getObject(parent) !== undefined);
      if (parentLeft) shallow.push(commit);
      else if (shallowSet.has(commit)) unshallow.push(commit);
    }
    for (const oid of clientShallow) {
      if (!includedCommits.has(oid) && !shallow.includes(oid) && !unshallow.includes(oid)) shallow.push(oid);
    }
  }

  const objects: GitObject[] = [];
  for (const oid of included) {
    if (haveClosure.has(oid)) continue;
    const object = repo.getObject(oid);
    if (object !== undefined) objects.push(object);
  }
  const common = haves.filter((oid) => repo.getObject(oid)?.type === 'commit');
  return { objects, shallow, unshallow, common };
}

function fetchReply(repo: Repo, plan: FetchPlan, withShallowInfo: boolean): Buffer {
  const parts: Buffer[] = [pkt('acknowledgments\n')];
  if (plan.common.length > 0) {
    parts.push(pkt(`ACK ${plan.common[0]}\n`));
    parts.push(pkt('ready\n'));
  } else {
    parts.push(pkt('NAK\n'));
  }
  parts.push(Buffer.from('0001', 'ascii'));
  if (withShallowInfo && (plan.shallow.length > 0 || plan.unshallow.length > 0)) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  parts.push(pkt('packfile\n'));
  parts.push(sidebandWrap(writePack(plan.objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack POST

interface ParsedRequest {
  command: string;
  args: string[];
}

function parseV2Request(body: Buffer): ParsedRequest {
  const { lines } = decodePktLines(body);
  let command = '';
  const args: string[] = [];
  let inArgs = false;
  for (const line of lines) {
    if (line.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (line.kind !== 'data') continue;
    const text = line.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) {
      if (text.startsWith('command=')) command = text.slice('command='.length);
      continue;
    }
    args.push(text);
  }
  return { command, args };
}

/** Parse a whole body as pkt-lines (a v0 fetch body has several flush-separated sections). */
function parseAllPktLines(body: Buffer): PktLine[] {
  const all: PktLine[] = [];
  let offset = 0;
  while (offset < body.length) {
    const { lines, end } = decodePktLines(body.subarray(offset));
    if (end === 0) break;
    all.push(...lines);
    offset += end;
  }
  return all;
}

export async function handleUploadPack(send: Send, repo: Repo | null, body: Buffer, isV2: boolean): Promise<void> {
  if (repo === null) {
    send(404, Buffer.from('{"message":"Not Found"}\n'), 'application/json; charset=utf-8');
    return;
  }
  try {
    if (isV2) {
      const { command, args } = parseV2Request(body);
      if (command === 'ls-refs') {
        const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
        for (const arg of args) {
          if (arg === 'peel') lsArgs.peel = true;
          else if (arg === 'symrefs') lsArgs.symrefs = true;
          else if (arg === 'unborn') lsArgs.unborn = true;
          else if (arg.startsWith('ref-prefix ')) lsArgs.prefixes.push(arg.slice('ref-prefix '.length));
        }
        send(200, lsRefsReply(repo, lsArgs), 'application/x-git-upload-pack-result');
        return;
      }
      if (command === 'fetch') {
        const wants: string[] = [];
        const haves: string[] = [];
        const shallow: string[] = [];
        let depth: number | null = null;
        for (const arg of args) {
          if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
          else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
          else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
          else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7), 10);
        }
        const plan = planFetch(repo, wants, haves, shallow, depth);
        send(200, fetchReply(repo, plan, true), 'application/x-git-upload-pack-result');
        return;
      }
      send(400, Buffer.from('{"message":"unknown command"}\n'), 'application/json; charset=utf-8');
      return;
    }
    // Protocol v0: want lines, a flush, have lines, done, a flush.
    const lines = parseAllPktLines(body);
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    let section = 0;
    for (const line of lines) {
      if (line.kind === 'flush') {
        section += 1;
        continue;
      }
      if (line.kind !== 'data') continue;
      const text = line.payload.toString('utf8').replace(/\n$/, '');
      if (section === 0) {
        if (text.startsWith('want ')) wants.push(text.slice(5, 45));
        else if (text.startsWith('shallow ')) shallow.push(text.slice(8, 48));
        else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7), 10);
      } else if (text.startsWith('have ')) {
        haves.push(text.slice(5, 45));
      }
    }
    const plan = planFetch(repo, wants, haves, shallow, depth);
    const parts: Buffer[] = [];
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    }
    parts.push(pkt(plan.common.length > 0 ? `ACK ${plan.common[0]}\n` : 'NAK\n'));
    parts.push(sidebandWrap(writePack(plan.objects)));
    parts.push(PKT_FLUSH);
    send(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
  } catch {
    send(400, Buffer.from('{"message":"malformed git request"}\n'), 'application/json; charset=utf-8');
  }
}

// ---------------------------------------------------------------------------
// receive-pack POST

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export async function handleReceivePack(send: Send, repo: Repo | null, body: Buffer): Promise<void> {
  if (repo === null) {
    send(404, Buffer.from('{"message":"Not Found"}\n'), 'application/json; charset=utf-8');
    return;
  }
  let commands: PushCommand[] = [];
  let capabilities = new Set<string>();
  let packBytes: Buffer = Buffer.alloc(0);
  try {
    const { lines, end } = decodePktLines(body);
    packBytes = body.subarray(end);
    let first = true;
    for (const line of lines) {
      if (line.kind !== 'data') continue;
      let text = line.payload.toString('utf8').replace(/\n$/, '');
      if (first) {
        first = false;
        const nul = text.indexOf('\0');
        if (nul >= 0) {
          capabilities = new Set(text.slice(nul + 1).split(' ').filter(Boolean));
          text = text.slice(0, nul);
        }
      }
      const fields = text.split(' ');
      if (fields.length === 3) {
        commands.push({ oldOid: fields[0]!, newOid: fields[1]!, ref: fields[2]! });
      }
    }
  } catch {
    send(400, Buffer.from('{"message":"malformed git request"}\n'), 'application/json; charset=utf-8');
    return;
  }

  const report: string[] = [];
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const pack = await readPack(packBytes, (oid) => repo.getObject(oid));
      for (const [oid, object] of pack.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  report.push(unpackError === null ? 'unpack ok' : `unpack ${unpackError}`);

  for (const command of commands) {
    if (unpackError !== null) {
      report.push(`ng ${command.ref} unpacker error`);
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      report.push(`ng ${command.ref} stale info`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      report.push(`ok ${command.ref}`);
      continue;
    }
    if (repo.getObject(command.newOid) === undefined) {
      report.push(`ng ${command.ref} missing object`);
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && current !== ZERO_OID) {
      const currentCommit = repo.peelToCommit(current);
      const newCommit = repo.peelToCommit(command.newOid);
      if (
        currentCommit !== null &&
        newCommit !== null &&
        currentCommit !== newCommit &&
        !repo.isAncestor(currentCommit, newCommit)
      ) {
        report.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    report.push(`ok ${command.ref}`);
  }

  const inner = Buffer.concat([...report.map((line) => pkt(`${line}\n`)), PKT_FLUSH]);
  const useSideband = capabilities.has('side-band-64k');
  const out = useSideband ? Buffer.concat([sidebandWrap(inner), PKT_FLUSH]) : inner;
  send(200, out, 'application/x-git-receive-pack-result');
}
