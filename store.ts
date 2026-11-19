// The forge's store: one seeded user (the token's owner, as the suite's published scenario names
// it), repositories with their own git object stores and refs, and the issue / label / comment /
// pull-request records the REST, GraphQL and MCP surfaces all share. Everything is in memory and
// every timestamp comes from a logical clock, so a trial's answers are deterministic.

import {
  buildCommit,
  buildTree,
  formatIdent,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';

export interface UserInfo {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** The one user the trial's bearer <redacted> names: wire.ts's scenario viewer, fixed by the seed. */
export const VIEWER: UserInfo = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
  createdSeq: number;
}

export interface Issue {
  /** Forge-wide object id (GraphQL databaseId for the issue, and the REST `id`). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  comments: IssueComment[];
  createdSeq: number;
  closedSeq: number | null;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedSeq: number | null;
  mergeCommitSha: string | null;
  userLogin: string;
  createdSeq: number;
}

/** One file of a tree, flattened: path -> blob. */
export interface FlatFile {
  mode: string;
  oid: string;
}

export class Repo {
  readonly id: number;
  readonly ownerLogin: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch = 'main';
  readonly createdSeq: number;

  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, PullRequest>();
  /** Issues and pull requests share one number sequence, as they do on GitHub. */
  nextNumber = 1;

  constructor(id: number, ownerLogin: string, name: string, description: string, isPrivate: boolean, createdSeq: number) {
    this.id = id;
    this.ownerLogin = ownerLogin;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.createdSeq = createdSeq;
  }

  get fullName(): string {
    return `${this.ownerLogin}/${this.name}`;
  }

  // ------------------------------------------------------------- git objects

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Peel a tag chain to the commit it names; a commit peels to itself; anything else to null. */
  peelToCommit(oid: string): string | null {
    let current = oid;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = this.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** Resolve a branch name, a tag name, HEAD or a raw object id to an object id. */
  resolveRef(name: string): string | null {
    if (name === 'HEAD') {
      const tip = this.refs.get(`refs/heads/${this.defaultBranch}`);
      return tip ?? null;
    }
    const branch = this.refs.get(`refs/heads/${name}`);
    if (branch !== undefined) return branch;
    const tag = this.refs.get(`refs/tags/${name}`);
    if (tag !== undefined) return tag;
    if (this.refs.has(name)) return this.refs.get(name)!;
    if (/^[0-9a-f]{40}$/.test(name) && this.objects.has(name)) return name;
    return null;
  }

  branchTip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Flatten a tree (by oid) into path -> {mode, oid}; nested trees recurse. */
  flattenTree(treeOid: string, prefix = '', out = new Map<string, FlatFile>()): Map<string, FlatFile> {
    const object = this.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(entry.oid, path, out);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
    return out;
  }

  /** The flattened file map of a commit (or of a ref naming one); empty for an unborn ref. */
  filesAt(refOrOid: string): Map<string, FlatFile> {
    const oid = this.resolveRef(refOrOid) ?? (/^[0-9a-f]{40}$/.test(refOrOid) ? refOrOid : null);
    if (oid === null) return new Map();
    const commit = this.peelToCommit(oid);
    if (commit === null) return new Map();
    const info = parseCommit(this.objects.get(commit)!.data);
    return this.flattenTree(info.tree);
  }

  /** Store a flattened file map as trees; answers the root tree's oid. */
  buildTreeFromFiles(files: ReadonlyMap<string, FlatFile>): string {
    interface Dir {
      files: Map<string, FlatFile>;
      dirs: Map<string, Dir>;
    }
    const root: Dir = { files: new Map(), dirs: new Map() };
    for (const [path, file] of files) {
      const segments = path.split('/');
      let dir = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const segment = segments[index]!;
        if (!dir.dirs.has(segment)) dir.dirs.set(segment, { files: new Map(), dirs: new Map() });
        dir = dir.dirs.get(segment)!;
      }
      dir.files.set(segments[segments.length - 1]!, file);
    }
    const build = (dir: Dir): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of dir.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, child] of dir.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit of `treeOid` on top of `parents`, authored by the viewer at `epochSec`. */
  makeCommit(treeOid: string, parents: readonly string[], message: string, epochSec: number): string {
    const ident = formatIdent(VIEWER.name, VIEWER.email, epochSec);
    const data = buildCommit({ tree: treeOid, parents: [...parents], author: ident, committer: ident, message });
    return this.putObject('commit', data);
  }

  /** Ancestors of a commit (itself first), breadth-first, parents in order, no repeats. */
  ancestorsOf(tip: string): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    const queue = [tip];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(current);
      order.push(current);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return order;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    return this.ancestorsOf(descendant).includes(ancestor);
  }

  /** The deepest commit that is an ancestor of both `a` and `b`, or null. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsA = this.ancestorsOf(a);
    const setA = new Set(ancestorsA);
    const ancestorsB = this.ancestorsOf(b);
    const common = ancestorsB.filter((oid) => setA.has(oid));
    if (common.length === 0) return null;
    // The merge base is a common ancestor that is not itself an ancestor of another common one.
    for (const candidate of common) {
      const shadowed = common.some((other) => other !== candidate && this.isAncestor(candidate, other));
      if (!shadowed) return candidate;
    }
    return common[0]!;
  }

  /** Every object reachable from the given tips (tags peel, commits walk, trees recurse). */
  reachableFrom(tips: readonly string[], stopCommits?: ReadonlySet<string>): Set<string> {
    const out = new Set<string>();
    const visit = (oid: string): void => {
      if (out.has(oid)) return;
      const object = this.objects.get(oid);
      if (object === undefined) return;
      out.add(oid);
      if (object.type === 'tag') {
        visit(parseTag(object.data).object);
      } else if (object.type === 'commit') {
        const info = parseCommit(object.data);
        visit(info.tree);
        if (stopCommits !== undefined && stopCommits.has(oid)) return;
        for (const parent of info.parents) visit(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) visit(entry.oid);
      }
    };
    for (const tip of tips) visit(tip);
    return out;
  }
}

// ---------------------------------------------------------------------------
// diffs and merges over flattened file maps

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Line counts of a line-based diff (LCS), with a cheap fallback for very large files. */
export function lineDiffCounts(before: string, after: string): { additions: number; deletions: number } {
  if (before === after) return { additions: 0, deletions: 0 };
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (a.length * b.length > 4_000_000) {
    return { additions: b.length, deletions: a.length };
  }
  // LCS length via dynamic programming over the shorter axis.
  const dp = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j]!;
      if (a[i - 1] === b[j - 1]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(dp[j]!, dp[j - 1]!);
      diagonal = above;
    }
  }
  const common = dp[b.length]!;
  return { additions: b.length - common, deletions: a.length - common };
}

/** The changed files between two flattened maps, with line counts read from the repo's blobs. */
export function diffFiles(
  repo: Repo,
  before: ReadonlyMap<string, FlatFile>,
  after: ReadonlyMap<string, FlatFile>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  const text = (file: FlatFile | undefined): string => {
    if (file === undefined) return '';
    const object = repo.getObject(file.oid);
    return object === undefined ? '' : object.data.toString('utf8');
  };
  for (const path of [...paths].sort()) {
    const oldFile = before.get(path);
    const newFile = after.get(path);
    if (oldFile !== undefined && newFile !== undefined && oldFile.oid === newFile.oid) continue;
    const status = oldFile === undefined ? 'added' : newFile === undefined ? 'removed' : 'modified';
    const { additions, deletions } = lineDiffCounts(text(oldFile), text(newFile));
    changes.push({ path, status, additions, deletions, changes: additions + deletions });
  }
  return changes;
}

export interface MergeOutcome {
  files: Map<string, FlatFile>;
  conflicts: string[];
}

/** A per-file three-way merge of flattened maps; a path both sides changed differently conflicts. */
export function mergeFiles(
  base: ReadonlyMap<string, FlatFile>,
  ours: ReadonlyMap<string, FlatFile>,
  theirs: ReadonlyMap<string, FlatFile>,
): MergeOutcome {
  const files = new Map<string, FlatFile>();
  const conflicts: string[] = [];
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const inBase = base.get(path);
    const inOurs = ours.get(path);
    const inTheirs = theirs.get(path);
    const sameOid = (x: FlatFile | undefined, y: FlatFile | undefined): boolean => x?.oid === y?.oid && x?.mode === y?.mode;
    if (sameOid(inOurs, inTheirs)) {
      if (inOurs !== undefined) files.set(path, inOurs);
    } else if (sameOid(inBase, inOurs)) {
      if (inTheirs !== undefined) files.set(path, inTheirs);
    } else if (sameOid(inBase, inTheirs)) {
      if (inOurs !== undefined) files.set(path, inOurs);
    } else {
      conflicts.push(path);
    }
  }
  return { files, conflicts };
}

// ---------------------------------------------------------------------------
// the forge

export class Forge {
  readonly viewer: UserInfo = VIEWER;
  readonly repos = new Map<string, Repo>();
  private repoList: Repo[] = [];
  private nextRepoId = 1;
  private nextLabelId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextPullId = 1;
  /** A logical clock: every stamp is one second after the last, from a fixed epoch. */
  private seq = 0;

  /** The next deterministic timestamp (epoch seconds), strictly increasing. */
  tick(): number {
    this.seq += 1;
    return 1_735_689_600 + this.seq; // 2025-01-01T00:00:00Z plus the sequence
  }

  iso(epochSec: number): string {
    return new Date(epochSec * 1000).toISOString();
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    const key = `${this.viewer.login}/${name}`;
    if (this.repos.has(key)) return null;
    const repo = new Repo(this.nextRepoId, this.viewer.login, name, description, isPrivate, this.tick());
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    this.repoList.push(repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(`${repo.ownerLogin}/${repo.name}`);
    this.repoList = this.repoList.filter((candidate) => candidate !== repo);
  }

  /** The viewer's repositories in creation order. */
  listRepos(): Repo[] {
    return [...this.repoList];
  }

  createLabel(repo: Repo, name: string, color: string, description: string | null): Label {
    const label: Label = { id: this.nextLabelId, name, color, description };
    this.nextLabelId += 1;
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[], userLogin: string): Issue {
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labelNames],
      userLogin,
      comments: [],
      createdSeq: this.tick(),
      closedSeq: null,
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string, userLogin: string): IssueComment {
    const comment: IssueComment = { id: this.nextCommentId, body, userLogin, createdSeq: this.tick() };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    void repo;
    return comment;
  }

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
    userLogin: string,
  ): PullRequest {
    const pull: PullRequest = {
      id: this.nextPullId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      merged: false,
      mergedSeq: null,
      mergeCommitSha: null,
      userLogin,
      createdSeq: this.tick(),
    };
    this.nextPullId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }
}
