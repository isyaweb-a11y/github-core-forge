// The GraphQL v4 surface: a small hand-written parser and executor over a schema registry that
// covers the types the clients exercise (Query, Mutation, Repository, Issue, PullRequest, User,
// connections, search, node(id:), and introspection for __type/__schema). Global ids are opaque,
// stable, and round-trip through node(id:) and the mutation inputs: base64 of "Kind:key".
// The executor shares the forge store, so GraphQL sees REST/git/MCP effects and vice versa.

import { parseCommit, parseTree } from './gitobj.ts';
import { mergePullRequest } from './rest.ts';
import {
  diffFiles,
  mergeFiles,
  type Forge,
  type Issue,
  type IssueComment,
  type Label,
  type PullRequest,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// lexer / parser

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selectionSet: SelectionNode[] | null;
}
type SelectionNode =
  | FieldNode
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Map<string, ValueNode>;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(c)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if (source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      const text = source.slice(i + 3, end === -1 ? source.length : end);
      tokens.push(`str:${JSON.stringify(text)}`);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1]!;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push(`str:${JSON.stringify(out)}`);
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push(`name:${source.slice(i, j)}`);
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      tokens.push(`num:${source.slice(i, j)}`);
      i = j;
      continue;
    }
    tokens.push(c);
    i += 1;
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(symbol: string): void {
    const token = this.next();
    if (token !== symbol) throw new Error(`expected '${symbol}', found '${token}'`);
  }

  private name(): string {
    const token = this.next();
    if (!token.startsWith('name:')) throw new Error(`expected a name, found '${token}'`);
    return token.slice(5);
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token === '{') {
        operations.push({ type: 'query', name: null, variableDefaults: new Map(), selectionSet: this.selectionSet() });
      } else if (token === 'name:query' || token === 'name:mutation' || token === 'name:subscription') {
        const type = this.next().slice(5) as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek()?.startsWith('name:')) name = this.name();
        const variableDefaults = new Map<string, ValueNode>();
        if (this.peek() === '(') {
          this.next();
          while (this.peek() !== ')') {
            this.expect('$');
            const varName = this.name();
            this.expect(':');
            this.typeRef();
            if (this.peek() === '=') {
              this.next();
              variableDefaults.set(varName, this.value());
            }
            this.directives();
          }
          this.next();
        }
        this.directives();
        operations.push({ type, name, variableDefaults, selectionSet: this.selectionSet() });
      } else if (token === 'name:fragment') {
        this.next();
        const fragName = this.name();
        const on = this.name();
        if (on !== 'on') throw new Error("expected 'on' in fragment definition");
        const typeCondition = this.name();
        this.directives();
        fragments.set(fragName, { typeCondition, selectionSet: this.selectionSet() });
      } else {
        throw new Error(`unexpected token '${token}'`);
      }
    }
    return { operations, fragments };
  }

  private typeRef(): void {
    if (this.peek() === '[') {
      this.next();
      this.typeRef();
      this.expect(']');
    } else {
      this.name();
    }
    if (this.peek() === '!') this.next();
  }

  private directives(): void {
    while (this.peek() === '@') {
      this.next();
      this.name();
      if (this.peek() === '(') this.arguments();
    }
  }

  private arguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    this.expect('(');
    while (this.peek() !== ')') {
      const name = this.name();
      this.expect(':');
      args.push({ name, value: this.value() });
    }
    this.next();
    return args;
  }

  private value(): ValueNode {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.name() };
    if (token.startsWith('str:')) return { kind: 'string', value: JSON.parse(token.slice(4)) as string };
    if (token.startsWith('num:')) {
      const raw = token.slice(4);
      return raw.includes('.') || /[eE]/.test(raw)
        ? { kind: 'float', value: Number.parseFloat(raw) }
        : { kind: 'int', value: Number.parseInt(raw, 10) };
    }
    if (token === '[') {
      const values: ValueNode[] = [];
      while (this.peek() !== ']') values.push(this.value());
      this.next();
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (this.peek() !== '}') {
        const name = this.name();
        this.expect(':');
        fields.push({ name, value: this.value() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.startsWith('name:')) {
      const word = token.slice(5);
      if (word === 'true') return { kind: 'bool', value: true };
      if (word === 'false') return { kind: 'bool', value: false };
      if (word === 'null') return { kind: 'null' };
      return { kind: 'enum', value: word };
    }
    throw new Error(`unexpected value token '${token}'`);
  }

  private selectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'name:on') {
          this.next();
          const typeCondition = this.name();
          this.directives();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.selectionSet() });
        } else if (this.peek()?.startsWith('name:')) {
          selections.push({ kind: 'spread', name: this.name() });
        } else {
          this.directives();
          selections.push({ kind: 'inline', typeCondition: null, selectionSet: this.selectionSet() });
        }
        continue;
      }
      const first = this.name();
      let alias: string | null = null;
      let fieldName = first;
      if (this.peek() === ':') {
        this.next();
        alias = first;
        fieldName = this.name();
      }
      const args = this.peek() === '(' ? this.arguments() : [];
      this.directives();
      const selectionSet = this.peek() === '{' ? this.selectionSet() : null;
      selections.push({ kind: 'field', alias, name: fieldName, args, selectionSet });
    }
    this.next();
    return selections;
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => evalValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// global ids

export function encodeId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function decodeId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

const repoGid = (repo: Repo): string => encodeId('Repository', `${repo.id}`);
const issueGid = (repo: Repo, issue: Issue): string => encodeId('Issue', `${repo.id}:${issue.number}`);
const pullGid = (repo: Repo, pull: PullRequest): string => encodeId('PullRequest', `${repo.id}:${pull.number}`);
const commentGid = (repo: Repo, issue: Issue, comment: IssueComment): string =>
  encodeId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`);
const labelGid = (repo: Repo, label: Label): string => encodeId('Label', `${repo.id}:${label.name}`);
const userGid = (id: number): string => encodeId('User', `${id}`);

// ---------------------------------------------------------------------------
// sources (typed wrappers the resolvers switch on)

interface Src {
  t: string;
  repo?: Repo;
  issue?: Issue;
  pull?: PullRequest;
  comment?: IssueComment;
  label?: Label;
  oid?: string;
  name?: string;
  path?: string;
  mode?: number;
  nodes?: Src[];
  cursors?: string[];
  total?: number;
  hasNext?: boolean;
  hasPrev?: boolean;
  payload?: Record<string, unknown>;
}

const srcRepo = (repo: Repo): Src => ({ t: 'Repository', repo });
const srcIssue = (repo: Repo, issue: Issue): Src => ({ t: 'Issue', repo, issue });
const srcPull = (repo: Repo, pull: PullRequest): Src => ({ t: 'PullRequest', repo, pull });
const srcUser = (): Src => ({ t: 'User' });

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number.parseInt(match[1]!, 10);
  } catch {
    return -1;
  }
}

/** Relay-style connection over an already-ordered list of node sources. */
function connect(typeName: string, items: Src[], args: Record<string, unknown>): Src {
  const start = decodeCursor(args.after) + 1;
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : items.length;
  const nodes = items.slice(start, start + first);
  return {
    t: typeName,
    nodes,
    cursors: nodes.map((_, index) => encodeCursor(start + index)),
    total: items.length,
    hasNext: start + nodes.length < items.length,
    hasPrev: start > 0,
  };
}

// ---------------------------------------------------------------------------
// schema registry and resolvers

type Resolver = (forge: Forge, src: Src, args: Record<string, unknown>) => unknown;

interface FieldDef {
  type: string;
  args?: { name: string; type: string }[];
  resolve: Resolver;
}

interface TypeDef {
  kind: 'OBJECT' | 'INTERFACE' | 'UNION' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR';
  fields?: Record<string, FieldDef>;
  enumValues?: string[];
  possibleTypes?: string[];
  inputFields?: { name: string; type: string }[];
}

const field = (type: string, resolve: Resolver, args?: FieldDef['args']): FieldDef => ({ type, resolve, args });

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);

function repoById(forge: Forge, id: number): Repo | null {
  return forge.listRepos().find((repo) => repo.id === id) ?? null;
}

function nodeSrc(forge: Forge, id: string): Src | null {
  const decoded = decodeId(id);
  if (decoded === null) return null;
  const [head, ...rest] = decoded.key.split(':');
  const repoId = Number.parseInt(head ?? '', 10);
  switch (decoded.kind) {
    case 'User':
      return repoId === forge.viewer.id ? srcUser() : null;
    case 'Repository': {
      const repo = repoById(forge, repoId);
      return repo === null ? null : srcRepo(repo);
    }
    case 'Issue': {
      const repo = repoById(forge, repoId);
      const issue = repo?.issues.get(Number.parseInt(rest[0] ?? '', 10));
      return repo !== null && repo !== undefined && issue !== undefined ? srcIssue(repo, issue) : null;
    }
    case 'PullRequest': {
      const repo = repoById(forge, repoId);
      const pull = repo?.pulls.get(Number.parseInt(rest[0] ?? '', 10));
      return repo !== null && repo !== undefined && pull !== undefined ? srcPull(repo, pull) : null;
    }
    case 'IssueComment': {
      const repo = repoById(forge, repoId);
      const issue = repo?.issues.get(Number.parseInt(rest[0] ?? '', 10));
      const comment = issue?.comments.find((candidate) => candidate.id === Number.parseInt(rest[1] ?? '', 10));
      return repo !== null && repo !== undefined && issue !== undefined && comment !== undefined
        ? { t: 'IssueComment', repo, issue, comment }
        : null;
    }
    case 'Label': {
      const repo = repoById(forge, repoId);
      const label = repo?.labels.get(rest.join(':'));
      return repo !== null && repo !== undefined && label !== undefined ? { t: 'Label', repo, label } : null;
    }
    case 'Ref': {
      const repo = repoById(forge, repoId);
      const name = rest.join(':');
      const oid = name === repo?.defaultBranch ? repo?.branchTip(name) : repo?.refs.get(`refs/heads/${name}`) ?? repo?.refs.get(name);
      return repo !== null && repo !== undefined && oid !== undefined && oid !== null
        ? { t: 'Ref', repo, name, oid }
        : null;
    }
    case 'Commit':
    case 'Tree':
    case 'Blob': {
      const repo = repoById(forge, repoId);
      const oid = rest.join(':');
      return repo !== null && repo !== undefined && repo.getObject(oid) !== undefined
        ? { t: decoded.kind, repo, oid }
        : null;
    }
    default:
      return null;
  }
}

function mergeableOf(repo: Repo, pull: PullRequest): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.branchTip(pull.baseRef);
  const headTip = repo.branchTip(pull.headRef);
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  const mergeBase = repo.mergeBase(baseTip, headTip);
  const baseFiles = mergeBase === null ? new Map() : repo.filesAt(mergeBase);
  const outcome = mergeFiles(baseFiles, repo.filesAt(baseTip), repo.filesAt(headTip));
  return outcome.conflicts.length === 0 ? 'MERGEABLE' : 'CONFLICTING';
}

function pullFiles(repo: Repo, pull: PullRequest): Src[] {
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (headTip === null || baseTip === null) return [];
  const mergeBase = repo.mergeBase(baseTip, headTip) ?? baseTip;
  return diffFiles(repo, repo.filesAt(mergeBase), repo.filesAt(headTip)).map((change) => ({
    t: 'PullRequestChangedFile',
    payload: {
      path: change.path,
      additions: change.additions,
      deletions: change.deletions,
      changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED',
    },
  }));
}

function orderItems<T extends { createdSeq: number; number: number }>(
  items: T[],
  orderBy: unknown,
  defaultDirection: 'ASC' | 'DESC',
): T[] {
  const order = (orderBy ?? {}) as { direction?: unknown };
  const direction = order.direction === 'ASC' ? 'ASC' : order.direction === 'DESC' ? 'DESC' : defaultDirection;
  const sign = direction === 'ASC' ? 1 : -1;
  return [...items].sort((a, b) => (a.createdSeq - b.createdSeq || a.number - b.number) * sign);
}

function searchIssues(forge: Forge, query: string): Src[] {
  const terms: string[] = [];
  let repoFilter: string | null = null;
  let stateFilter: string | null = null;
  for (const token of query.split(/\s+/).filter(Boolean)) {
    if (token.startsWith('repo:')) repoFilter = token.slice(5).toLowerCase();
    else if (token.startsWith('state:')) stateFilter = token.slice(6).toLowerCase();
    else if (token.startsWith('is:')) {
      const value = token.slice(3).toLowerCase();
      if (value === 'open' || value === 'closed') stateFilter = value;
    } else if (token.includes(':')) {
      // Other qualifiers (author:, label:, ...) are accepted and ignored.
    } else terms.push(token.toLowerCase());
  }
  const matches: { repo: Repo; issue: Issue }[] = [];
  for (const repo of forge.listRepos()) {
    if (repoFilter !== null && repo.fullName.toLowerCase() !== repoFilter) continue;
    for (const issue of repo.issues.values()) {
      if (stateFilter !== null && issue.state !== stateFilter) continue;
      const haystack = `${issue.title}\n${issue.body}`.toLowerCase();
      if (!terms.every((term) => haystack.includes(term))) continue;
      matches.push({ repo, issue });
    }
  }
  matches.sort((a, b) => b.issue.createdSeq - a.issue.createdSeq || b.issue.number - a.issue.number);
  return matches.map(({ repo, issue }) => srcIssue(repo, issue));
}

const connectionOf = (elemType: string): TypeDef => ({
  kind: 'OBJECT',
  fields: {
    totalCount: field('Int!', (_forge, src) => src.total ?? 0),
    nodes: field(`[${elemType}]`, (_forge, src) => src.nodes ?? []),
    edges: field(`[${elemType}Edge]`, (_forge, src) =>
      (src.nodes ?? []).map((node, index) => ({
        t: 'Edge',
        payload: { node, cursor: (src.cursors ?? [])[index] ?? '' },
      })),
    ),
    pageInfo: field('PageInfo!', (_forge, src) => ({
      t: 'PageInfo',
      payload: {
        hasNextPage: src.hasNext ?? false,
        hasPreviousPage: src.hasPrev ?? false,
        startCursor: (src.cursors ?? [])[0] ?? null,
        endCursor: (src.cursors ?? [])[(src.cursors ?? []).length - 1] ?? null,
      },
    })),
  },
});

const edgeOf = (elemType: string): TypeDef => ({
  kind: 'OBJECT',
  fields: {
    node: field(elemType, (_forge, src) => src.payload?.node ?? null),
    cursor: field('String!', (_forge, src) => src.payload?.cursor ?? ''),
  },
});

const TYPES: Record<string, TypeDef> = {
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Float: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
  URI: { kind: 'SCALAR' },
  GitObjectID: { kind: 'SCALAR' },

  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  MergeStateStatus: {
    kind: 'ENUM',
    enumValues: ['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE'],
  },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  PullRequestOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'REBASE', 'SQUASH'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  FileChangeType: { kind: 'ENUM', enumValues: ['ADDED', 'CHANGED', 'COPIED', 'DELETED', 'MODIFIED', 'RENAMED'] },

  IssueOrder: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'field', type: 'IssueOrderField!' },
      { name: 'direction', type: 'OrderDirection!' },
    ],
  },
  PullRequestOrder: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'field', type: 'PullRequestOrderField!' },
      { name: 'direction', type: 'OrderDirection!' },
    ],
  },
  CreateIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'repositoryId', type: 'ID!' },
      { name: 'title', type: 'String!' },
      { name: 'body', type: 'String' },
      { name: 'labelIds', type: '[ID!]' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  CloseIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'issueId', type: 'ID!' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  AddCommentInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'subjectId', type: 'ID!' },
      { name: 'body', type: 'String!' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  MergePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'pullRequestId', type: 'ID!' },
      { name: 'mergeMethod', type: 'PullRequestMergeMethod' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  CreatePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'repositoryId', type: 'ID!' },
      { name: 'baseRefName', type: 'String!' },
      { name: 'headRefName', type: 'String!' },
      { name: 'title', type: 'String!' },
      { name: 'body', type: 'String' },
      { name: 'draft', type: 'Boolean' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },

  Node: { kind: 'INTERFACE', fields: { id: field('ID!', () => null) }, possibleTypes: [] },
  RepositoryOwner: {
    kind: 'INTERFACE',
    fields: {
      id: field('ID!', () => null),
      login: field('String!', () => null),
      url: field('URI!', () => null),
      avatarUrl: field('URI!', () => ''),
    },
    possibleTypes: ['User', 'Organization'],
  },
  Organization: {
    kind: 'OBJECT',
    fields: {
      id: field('ID!', (forge) => userGid(forge.viewer.id)),
      login: field('String!', () => ''),
      name: field('String', () => null),
      url: field('URI!', () => ''),
      avatarUrl: field('URI!', () => ''),
    },
  },
  Actor: {
    kind: 'INTERFACE',
    fields: {
      login: field('String!', () => null),
      url: field('URI!', () => null),
      avatarUrl: field('URI!', () => ''),
    },
    possibleTypes: ['User'],
  },
  GitObject: {
    kind: 'INTERFACE',
    fields: { id: field('ID!', () => null), oid: field('GitObjectID!', () => null) },
    possibleTypes: ['Blob', 'Commit', 'Tree'],
  },
  IssueOrPullRequest: { kind: 'UNION', possibleTypes: ['Issue', 'PullRequest'] },
  SearchResultItem: { kind: 'UNION', possibleTypes: ['Issue', 'PullRequest', 'Repository', 'User'] },

  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: field('Boolean!', (_forge, src) => src.payload?.hasNextPage ?? false),
      hasPreviousPage: field('Boolean!', (_forge, src) => src.payload?.hasPreviousPage ?? false),
      startCursor: field('String', (_forge, src) => src.payload?.startCursor ?? null),
      endCursor: field('String', (_forge, src) => src.payload?.endCursor ?? null),
    },
  },

  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: field('User!', (forge) => srcUser()),
      repository: field(
        'Repository',
        (forge, _src, args) => {
          const repo = forge.getRepo(str(args.owner) ?? '', str(args.name) ?? '');
          return repo === null ? null : srcRepo(repo);
        },
        [
          { name: 'owner', type: 'String!' },
          { name: 'name', type: 'String!' },
        ],
      ),
      node: field('Node', (forge, _src, args) => (typeof args.id === 'string' ? nodeSrc(forge, args.id) : null), [
        { name: 'id', type: 'ID!' },
      ]),
      search: field(
        'SearchResultItemConnection!',
        (forge, _src, args) => {
          const items = args.type === 'ISSUE' || args.type === undefined ? searchIssues(forge, str(args.query) ?? '') : [];
          return connect('SearchResultItemConnection', items, args);
        },
        [
          { name: 'query', type: 'String!' },
          { name: 'type', type: 'SearchType!' },
          { name: 'first', type: 'Int' },
          { name: 'after', type: 'String' },
        ],
      ),
      rateLimit: field('RateLimit', (forge) => ({
        t: 'RateLimit',
        payload: {
          limit: 5000,
          cost: 1,
          remaining: 4999,
          used: 1,
          nodeCount: 0,
          resetAt: forge.iso(forge.tick() + 3600),
        },
      })),
    },
  },

  RateLimit: {
    kind: 'OBJECT',
    fields: {
      limit: field('Int!', (_forge, src) => src.payload?.limit ?? 0),
      cost: field('Int!', (_forge, src) => src.payload?.cost ?? 0),
      remaining: field('Int!', (_forge, src) => src.payload?.remaining ?? 0),
      used: field('Int!', (_forge, src) => src.payload?.used ?? 0),
      nodeCount: field('Int!', (_forge, src) => src.payload?.nodeCount ?? 0),
      resetAt: field('DateTime!', (_forge, src) => src.payload?.resetAt ?? ''),
    },
  },

  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: field(
        'CreateIssuePayload',
        (forge, _src, args) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const decoded = typeof input.repositoryId === 'string' ? decodeId(input.repositoryId) : null;
          const repo = decoded !== null && decoded.kind === 'Repository' ? repoById(forge, Number.parseInt(decoded.key, 10)) : null;
          if (repo === null) throw new Error('repositoryId does not name a repository');
          const title = str(input.title);
          if (title === null || title === '') throw new Error('title is required');
          const labelNames: string[] = [];
          const labelIds = Array.isArray(input.labelIds) ? input.labelIds : [];
          for (const labelId of labelIds) {
            const decodedLabel = typeof labelId === 'string' ? decodeId(labelId) : null;
            if (decodedLabel === null || decodedLabel.kind !== 'Label') throw new Error('labelIds contains an unknown label');
            const name = decodedLabel.key.split(':').slice(1).join(':');
            if (!repo.labels.has(name)) throw new Error(`label '${name}' does not exist in this repository`);
            labelNames.push(name);
          }
          const issue = forge.createIssue(repo, title, str(input.body) ?? '', labelNames, forge.viewer.login);
          return {
            t: 'CreateIssuePayload',
            payload: { issue: srcIssue(repo, issue), clientMutationId: str(input.clientMutationId) },
          };
        },
        [{ name: 'input', type: 'CreateIssueInput!' }],
      ),
      closeIssue: field(
        'CloseIssuePayload',
        (forge, _src, args) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const target = typeof input.issueId === 'string' ? nodeSrc(forge, input.issueId) : null;
          if (target === null || target.t !== 'Issue' || target.issue === undefined || target.repo === undefined) {
            throw new Error('issueId does not name an issue');
          }
          if (target.issue.state !== 'closed') {
            target.issue.state = 'closed';
            target.issue.closedSeq = forge.tick();
          }
          return {
            t: 'CloseIssuePayload',
            payload: { issue: target, clientMutationId: str(input.clientMutationId) },
          };
        },
        [{ name: 'input', type: 'CloseIssueInput!' }],
      ),
      addComment: field(
        'AddCommentPayload',
        (forge, _src, args) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const target = typeof input.subjectId === 'string' ? nodeSrc(forge, input.subjectId) : null;
          if (target === null || target.t !== 'Issue' || target.issue === undefined || target.repo === undefined) {
            throw new Error('subjectId does not name an issue');
          }
          const body = str(input.body);
          if (body === null) throw new Error('body is required');
          const comment = forge.addComment(target.repo, target.issue, body, forge.viewer.login);
          const node: Src = { t: 'IssueComment', repo: target.repo, issue: target.issue, comment };
          return {
            t: 'AddCommentPayload',
            payload: {
              commentEdge: { t: 'Edge', payload: { node, cursor: encodeCursor(comment.id) } },
              clientMutationId: str(input.clientMutationId),
            },
          };
        },
        [{ name: 'input', type: 'AddCommentInput!' }],
      ),
      createPullRequest: field(
        'CreatePullRequestPayload',
        (forge, _src, args) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const decoded = typeof input.repositoryId === 'string' ? decodeId(input.repositoryId) : null;
          const repo = decoded !== null && decoded.kind === 'Repository' ? repoById(forge, Number.parseInt(decoded.key, 10)) : null;
          if (repo === null) throw new Error('repositoryId does not name a repository');
          const title = str(input.title);
          const head = str(input.headRefName);
          const base = str(input.baseRefName);
          if (title === null || head === null || base === null) throw new Error('title, headRefName and baseRefName are required');
          const headTip = repo.branchTip(head);
          const baseTip = repo.branchTip(base);
          if (headTip === null) throw new Error(`headRefName '${head}' does not name a branch`);
          if (baseTip === null) throw new Error(`baseRefName '${base}' does not name a branch`);
          if (headTip === baseTip) throw new Error(`No commits between ${base} and ${head}`);
          const duplicate = [...repo.pulls.values()].some(
            (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
          );
          if (duplicate) throw new Error('A pull request already exists for this head and base combination.');
          const pull = forge.createPull(repo, title, str(input.body) ?? '', head, base, forge.viewer.login);
          return {
            t: 'CreatePullRequestPayload',
            payload: { pullRequest: srcPull(repo, pull), clientMutationId: str(input.clientMutationId) },
          };
        },
        [{ name: 'input', type: 'CreatePullRequestInput!' }],
      ),
      mergePullRequest: field(
        'MergePullRequestPayload',
        (forge, _src, args) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const target = typeof input.pullRequestId === 'string' ? nodeSrc(forge, input.pullRequestId) : null;
          if (target === null || target.t !== 'PullRequest' || target.pull === undefined || target.repo === undefined) {
            throw new Error('pullRequestId does not name a pull request');
          }
          const methodRaw = str(input.mergeMethod) ?? 'MERGE';
          const method = methodRaw === 'SQUASH' ? 'squash' : methodRaw === 'REBASE' ? 'rebase' : 'merge';
          const sha = mergePullRequest(forge, target.repo, target.pull, method);
          if (sha === null) throw new Error('Pull Request is not mergeable');
          return {
            t: 'MergePullRequestPayload',
            payload: { pullRequest: target, clientMutationId: str(input.clientMutationId) },
          };
        },
        [{ name: 'input', type: 'MergePullRequestInput!' }],
      ),
    },
  },

  CreateIssuePayload: {
    kind: 'OBJECT',
    fields: {
      issue: field('Issue', (_forge, src) => src.payload?.issue ?? null),
      clientMutationId: field('String', (_forge, src) => src.payload?.clientMutationId ?? null),
      actor: field('User', () => srcUser()),
    },
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    fields: {
      issue: field('Issue', (_forge, src) => src.payload?.issue ?? null),
      clientMutationId: field('String', (_forge, src) => src.payload?.clientMutationId ?? null),
      actor: field('User', () => srcUser()),
    },
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: {
      commentEdge: field('IssueCommentEdge', (_forge, src) => src.payload?.commentEdge ?? null),
      clientMutationId: field('String', (_forge, src) => src.payload?.clientMutationId ?? null),
      actor: field('User', () => srcUser()),
    },
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: {
      pullRequest: field('PullRequest', (_forge, src) => src.payload?.pullRequest ?? null),
      clientMutationId: field('String', (_forge, src) => src.payload?.clientMutationId ?? null),
      actor: field('User', () => srcUser()),
    },
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: {
      pullRequest: field('PullRequest', (_forge, src) => src.payload?.pullRequest ?? null),
      clientMutationId: field('String', (_forge, src) => src.payload?.clientMutationId ?? null),
      actor: field('User', () => srcUser()),
    },
  },

  User: {
    kind: 'OBJECT',
    fields: {
      id: field('ID!', (forge) => userGid(forge.viewer.id)),
      databaseId: field('Int', (forge) => forge.viewer.id),
      login: field('String!', (forge) => forge.viewer.login),
      name: field('String', (forge) => forge.viewer.name),
      email: field('String', (forge) => forge.viewer.email),
      url: field('URI!', () => ''),
      avatarUrl: field('URI!', () => ''),
      isViewer: field('Boolean!', () => true),
      repositories: field(
        'RepositoryConnection!',
        (forge, _src, args) => connect('RepositoryConnection', forge.listRepos().map(srcRepo), args),
        [
          { name: 'first', type: 'Int' },
          { name: 'after', type: 'String' },
        ],
      ),
    },
  },

  Repository: {
    kind: 'OBJECT',
    fields: {
      id: field('ID!', (_forge, src) => repoGid(src.repo!)),
      databaseId: field('Int', (_forge, src) => src.repo!.id),
      name: field('String!', (_forge, src) => src.repo!.name),
      nameWithOwner: field('String!', (_forge, src) => src.repo!.fullName),
      description: field('String', (_forge, src) => src.repo!.description),
      isPrivate: field('Boolean!', (_forge, src) => src.repo!.isPrivate),
      isFork: field('Boolean!', () => false),
      isArchived: field('Boolean!', () => false),
      isEmpty: field('Boolean!', (_forge, src) => src.repo!.refs.size === 0),
      url: field('URI!', () => ''),
      createdAt: field('DateTime!', (forge, src) => forge.iso(src.repo!.createdSeq)),
      updatedAt: field('DateTime!', (forge, src) => forge.iso(src.repo!.createdSeq)),
      owner: field('RepositoryOwner!', () => srcUser()),
      viewerPermission: field('RepositoryPermission', () => 'ADMIN'),
      hasIssuesEnabled: field('Boolean!', () => true),
      hasProjectsEnabled: field('Boolean!', () => true),
      hasWikiEnabled: field('Boolean!', () => true),
      stargazerCount: field('Int!', () => 0),
      forkCount: field('Int!', () => 0),
      defaultBranchRef: field('Ref', (_forge, src) => {
        const tip = src.repo!.branchTip(src.repo!.defaultBranch);
        return tip === null ? null : { t: 'Ref', repo: src.repo!, name: src.repo!.defaultBranch, oid: tip };
      }),
      issue: field(
        'Issue',
        (_forge, src, args) => {
          const issue = src.repo!.issues.get(num(args.number) ?? -1);
          return issue === undefined ? null : srcIssue(src.repo!, issue);
        },
        [{ name: 'number', type: 'Int!' }],
      ),
      issues: field(
        'IssueConnection!',
        (_forge, src, args) => {
          let issues = [...src.repo!.issues.values()];
          const states = Array.isArray(args.states) ? (args.states as unknown[]) : null;
          if (states !== null) {
            issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
          }
          const ordered = orderItems(issues, args.orderBy, 'DESC');
          return connect('IssueConnection', ordered.map((issue) => srcIssue(src.repo!, issue)), args);
        },
        [
          { name: 'first', type: 'Int' },
          { name: 'after', type: 'String' },
          { name: 'states', type: '[IssueState!]' },
          { name: 'orderBy', type: 'IssueOrder' },
          { name: 'labels', type: '[String!]' },
        ],
      ),
      pullRequest: field(
        'PullRequest',
        (_forge, src, args) => {
          const pull = src.repo!.pulls.get(num(args.number) ?? -1);
          return pull === undefined ? null : srcPull(src.repo!, pull);
        },
        [{ name: 'number', type: 'Int!' }],
      ),
      pullRequests: field(
        'PullRequestConnection!',
        (_forge, src, args) => {
          let pulls = [...src.repo!.pulls.values()];
          const states = Array.isArray(args.states) ? (args.states as unknown[]) : ['OPEN'];
          pulls = pulls.filter((pull) => {
            const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
            return states.includes(state) || (states.includes('CLOSED') && pull.merged);
          });
          const ordered = orderItems(pulls, args.orderBy, 'DESC');
          return connect('PullRequestConnection', ordered.map((pull) => srcPull(src.repo!, pull)), args);
        },
        [
          { name: 'first', type: 'Int' },
          { name: 'after', type: 'String' },
          { name: 'states', type: '[PullRequestState!]' },
          { name: 'orderBy', type: 'PullRequestOrder' },
        ],
      ),
      issueOrPullRequest: field(
        'IssueOrPullRequest',
        (_forge, src, args) => {
          const number = num(args.number) ?? -1;
          const issue = src.repo!.issues.get(number);
          if (issue !== undefined) return srcIssue(src.repo!, issue);
          const pull = src.repo!.pulls.get(number);
          return pull === undefined ? null : srcPull(src.repo!, pull);
        },
        [{ name: 'number', type: 'Int!' }],
      ),
      labels: field(
        'LabelConnection',
        (_forge, src, args) => {
          const labels = [...src.repo!.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
          return connect('LabelConnection', labels.map((label) => ({ t: 'Label', repo: src.repo!, label })), args);
        },
        [
          { name: 'first', type: 'Int' },
          { name: 'after', type: 'String' },
        ],
      ),
      refs: field(
        'RefConnection',
        (_forge, src, args) => {
          const prefix = str(args.refPrefix) ?? 'refs/heads/';
          const refs = [...src.repo!.refs.entries()]
            .filter(([ref]) => ref.startsWith(prefix))
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([ref, oid]) => ({
              t: 'Ref',
              repo: src.repo!,
              name: ref.slice(prefix.length),
              oid,
            }));
          return connect('RefConnection', refs, args);
        },
        [
          { name: 'refPrefix', type: 'String!' },
          { name: 'first', type: 'Int' },
          { name: 'after', type: 'String' },
        ],
      ),
      object: field(
        'GitObject',
        (_forge, src, args) => {
          const expression = str(args.expression) ?? 'HEAD';
          const oid = src.repo!.resolveRef(expression);
          if (oid === null) return null;
          const object = src.repo!.getObject(oid);
          if (object === undefined) return null;
          const typeName = object.type === 'commit' ? 'Commit' : object.type === 'tree' ? 'Tree' : 'Blob';
          return { t: typeName, repo: src.repo!, oid };
        },
        [{ name: 'expression', type: 'String' }],
      ),
    },
  },

  Ref: {
    kind: 'OBJECT',
    fields: {
      id: field('ID!', (_forge, src) => encodeId('Ref', `${src.repo!.id}:${src.name}`)),
      name: field('String!', (_forge, src) => src.name ?? ''),
      prefix: field('String!', () => 'refs/heads/'),
      target: field('GitObject!', (_forge, src) => {
        const object = src.repo!.getObject(src.oid!);
        const typeName = object?.type === 'tree' ? 'Tree' : object?.type === 'blob' ? 'Blob' : 'Commit';
        return { t: typeName, repo: src.repo!, oid: src.oid! };
      }),
      repository: field('Repository!', (_forge, src) => srcRepo(src.repo!)),
    },
  },

  GitActor: {
    kind: 'OBJECT',
    fields: {
      name: field('String', (_forge, src) => src.payload?.name ?? null),
      email: field('String', (_forge, src) => src.payload?.email ?? null),
      date: field('DateTime', (_forge, src) => src.payload?.date ?? null),
      avatarUrl: field('URI!', () => ''),
      user: field('User', (forge, src) => (src.payload?.email === forge.viewer.email ? srcUser() : null)),
    },
  },

  Commit: {
    kind: 'OBJECT',
    fields: {
      id: field('ID!', (_forge, src) => encodeId('Commit', `${src.repo!.id}:${src.oid}`)),
      oid: field('GitObjectID!', (_forge, src) => src.oid ?? ''),
      abbreviatedOid: field('String!', (_forge, src) => (src.oid ?? '').slice(0, 7)),
      message: field('String!', (_forge, src) => parseCommit(src.repo!.getObject(src.oid!)!.data).message),
      messageHeadline: field('String!', (_forge, src) =>
        parseCommit(src.repo!.getObject(src.oid!)!.data).message.split('\n')[0] ?? '',
      ),
      committedDate: field('DateTime!', (forge, src) => {
        const ident = parseCommit(src.repo!.getObject(src.oid!)!.data).committer;
        return forge.iso(Number.parseInt(/ (\d+) [+-]\d{4}$/.exec(ident)?.[1] ?? '0', 10));
      }),
      authoredDate: field('DateTime!', (forge, src) => {
        const ident = parseCommit(src.repo!.getObject(src.oid!)!.data).author;
        return forge.iso(Number.parseInt(/ (\d+) [+-]\d{4}$/.exec(ident)?.[1] ?? '0', 10));
      }),
      author: field('GitActor', (forge, src) => {
        const ident = parseCommit(src.repo!.getObject(src.oid!)!.data).author;
        const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(ident);
        return {
          t: 'GitActor',
          payload: { name: match?.[1] ?? '', email: match?.[2] ?? '', date: forge.iso(Number.parseInt(match?.[3] ?? '0', 10)) },
        };
      }),
      committer: field('GitActor', (forge, src) => {
        const ident = parseCommit(src.repo!.getObject(src.oid!)!.data).committer;
        const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(ident);
        return {
          t: 'GitActor',
          payload: { name: match?.[1] ?? '', email: match?.[2] ?? '', date: forge.iso(Number.parseInt(match?.[3] ?? '0', 10)) },
        };
      }),
      tree: field('Tree!', (_forge, src) => ({
        t: 'Tree',
        repo: src.repo!,
        oid: parseCommit(src.repo!.getObject(src.oid!)!.data).tree,
        path: '',
      })),
      parents: field(
        'CommitConnection!',
        (_forge, src, args) => {
          const parents = parseCommit(src.repo!.getObject(src.oid!)!.data).parents.map((oid) => ({
            t: 'Commit',
            repo: src.repo!,
            oid,
          }));
          return connect('CommitConnection', parents, args);
        },
        [
          { name: 'first', type: 'Int' },
          { name: 'after', type: 'String' },
        ],
      ),
      url: field('URI!', () => ''),
      repository: field('Repository!', (_forge, src) => srcRepo(src.repo!)),
    },
  },

  Tree: {
    kind: 'OBJECT',
    fields: {
      id: field('ID!', (_forge, src) => encodeId('Tree', `${src.repo!.id}:${src.oid}`)),
      oid: field('GitObjectID!', (_forge, src) => src.oid ?? ''),
      entries: field('[TreeEntry!]!', (_forge, src) => {
        const object = src.repo!.getObject(src.oid!);
        if (object === undefined || object.type !== 'tree') return [];
        return parseTree(object.data).map((entry) => ({
          t: 'TreeEntry',
          repo: src.repo!,
          name: entry.name,
          path: src.path === '' || src.path === undefined ? entry.name : `${src.path}/${entry.name}`,
          mode: Number.parseInt(entry.mode, 10),
          oid: entry.oid,
        }));
      }),
      repository: field('Repository!', (_forge, src) => srcRepo(src.repo!)),
    },
  },

  TreeEntry: {
    kind: 'OBJECT',
    fields: {
      name: field('String!', (_forge, src) => src.name ?? ''),
      path: field('String!', (_forge, src) => src.path ?? ''),
      mode: field('Int!', (_forge, src) => src.mode ?? 0),
      type: field('String!', (_forge, src) => (src.mode === 40000 ? 'tree' : 'blob')),
      extension: field('String', (_forge, src) => {
        const name = src.name ?? '';
        const dot = name.lastIndexOf('.');
        return dot === -1 ? '' : name.slice(dot);
      }),
      isGenerated: field('Boolean!', () => false),
      object: field('GitObject', (_forge, src) => ({
        t: src.mode === 40000 ? 'Tree' : 'Blob',
        repo: src.repo!,
        oid: src.oid!,
        path: src.path ?? '',
      })),
    },
  },

  Blob: {
    kind: 'OBJECT',
    fields: {
      id: field('ID!', (_forge, src) => encodeId('Blob', `${src.repo!.id}:${src.oid}`)),
      oid: field('GitObjectID!', (_forge, src) => src.oid ?? ''),
      byteSize: field('Int!', (_forge, src) => src.repo!.getObject(src.oid!)?.data.length ?? 0),
      isBinary: field('Boolean', (_forge, src) => (src.repo!.getObject(src.oid!)?.data.includes(0) ?? false)),
      isTruncated: field('Boolean!', () => false),
      text: field('String', (_forge, src) => {
        const data = src.repo!.getObject(src.oid!)?.data;
        if (data === undefined || data.includes(0)) return null;
        return data.toString('utf8');
      }),
      repository: field('Repository!', (_forge, src) => srcRepo(src.repo!)),
    },
  },

  Issue: {
    kind: 'OBJECT',
    fields: {
      id: field('ID!', (_forge, src) => issueGid(src.repo!, src.issue!)),
      databaseId: field('Int', (_forge, src) => src.issue!.id),
      number: field('Int!', (_forge, src) => src.issue!.number),
      title: field('String!', (_forge, src) => src.issue!.title),
      body: field('String!', (_forge, src) => src.issue!.body),
      bodyText: field('String!', (_forge, src) => src.issue!.body),
      state: field('IssueState!', (_forge, src) => src.issue!.state.toUpperCase()),
      closed: field('Boolean!', (_forge, src) => src.issue!.state === 'closed'),
      closedAt: field('DateTime', (forge, src) =>
        src.issue!.closedSeq === null ? null : forge.iso(src.issue!.closedSeq),
      ),
      createdAt: field('DateTime!', (forge, src) => forge.iso(src.issue!.createdSeq)),
      updatedAt: field('DateTime!', (forge, src) => forge.iso(src.issue!.closedSeq ?? src.issue!.createdSeq)),
      author: field('User', () => srcUser()),
      repository: field('Repository!', (_forge, src) => srcRepo(src.repo!)),
      url: field('URI!', () => ''),
      viewerCanUpdate: field('Boolean!', () => true),
      locked: field('Boolean!', () => false),
      labels: field(
        'LabelConnection',
        (_forge, src, args) => {
          const labels = src.issue!.labels
            .map((name) => src.repo!.labels.get(name))
            .filter((label) => label !== undefined)
            .map((label) => ({ t: 'Label', repo: src.repo!, label }));
          return connect('LabelConnection', labels, args);
        },
        [
          { name: 'first', type: 'Int' },
          { name: 'after', type: 'String' },
        ],
      ),
      comments: field(
        'IssueCommentConnection!',
        (_forge, src, args) => {
          const comments = [...src.issue!.comments]
            .sort((a, b) => a.id - b.id)
            .map((comment) => ({ t: 'IssueComment', repo: src.repo!, issue: src.issue!, comment }));
          return connect('IssueCommentConnection', comments, args);
        },
        [
          { name: 'first', type: 'Int' },
          { name: 'after', type: 'String' },
        ],
      ),
    },
  },

  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: field('ID!', (_forge, src) => commentGid(src.repo!, src.issue!, src.comment!)),
      databaseId: field('Int', (_forge, src) => src.comment!.id),
      body: field('String!', (_forge, src) => src.comment!.body),
      bodyText: field('String!', (_forge, src) => src.comment!.body),
      createdAt: field('DateTime!', (forge, src) => forge.iso(src.comment!.createdSeq)),
      updatedAt: field('DateTime!', (forge, src) => forge.iso(src.comment!.createdSeq)),
      author: field('User', () => srcUser()),
      url: field('URI!', () => ''),
      issue: field('Issue!', (_forge, src) => srcIssue(src.repo!, src.issue!)),
    },
  },

  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: field('ID!', (_forge, src) => pullGid(src.repo!, src.pull!)),
      databaseId: field('Int', (_forge, src) => src.pull!.id),
      number: field('Int!', (_forge, src) => src.pull!.number),
      title: field('String!', (_forge, src) => src.pull!.title),
      body: field('String', (_forge, src) => src.pull!.body),
      state: field('PullRequestState!', (_forge, src) =>
        src.pull!.merged ? 'MERGED' : src.pull!.state.toUpperCase(),
      ),
      closed: field('Boolean!', (_forge, src) => src.pull!.state === 'closed'),
      merged: field('Boolean!', (_forge, src) => src.pull!.merged),
      mergedAt: field('DateTime', (forge, src) =>
        src.pull!.mergedSeq === null ? null : forge.iso(src.pull!.mergedSeq),
      ),
      createdAt: field('DateTime!', (forge, src) => forge.iso(src.pull!.createdSeq)),
      updatedAt: field('DateTime!', (forge, src) => forge.iso(src.pull!.mergedSeq ?? src.pull!.createdSeq)),
      author: field('User', () => srcUser()),
      repository: field('Repository!', (_forge, src) => srcRepo(src.repo!)),
      url: field('URI!', () => ''),
      isDraft: field('Boolean!', () => false),
      headRefName: field('String!', (_forge, src) => src.pull!.headRef),
      baseRefName: field('String!', (_forge, src) => src.pull!.baseRef),
      headRefOid: field('GitObjectID', (_forge, src) => src.repo!.branchTip(src.pull!.headRef)),
      baseRefOid: field('GitObjectID', (_forge, src) => src.repo!.branchTip(src.pull!.baseRef)),
      headRef: field('Ref', (_forge, src) => {
        const tip = src.repo!.branchTip(src.pull!.headRef);
        return tip === null ? null : { t: 'Ref', repo: src.repo!, name: src.pull!.headRef, oid: tip };
      }),
      baseRef: field('Ref', (_forge, src) => {
        const tip = src.repo!.branchTip(src.pull!.baseRef);
        return tip === null ? null : { t: 'Ref', repo: src.repo!, name: src.pull!.baseRef, oid: tip };
      }),
      mergeable: field('MergeableState!', (_forge, src) => mergeableOf(src.repo!, src.pull!)),
      mergeStateStatus: field('MergeStateStatus!', (_forge, src) => {
        const mergeable = mergeableOf(src.repo!, src.pull!);
        if (src.pull!.state !== 'open') return 'UNKNOWN';
        return mergeable === 'MERGEABLE' ? 'CLEAN' : mergeable === 'CONFLICTING' ? 'DIRTY' : 'UNKNOWN';
      }),
      mergeCommit: field('Commit', (_forge, src) =>
        src.pull!.mergeCommitSha === null
          ? null
          : { t: 'Commit', repo: src.repo!, oid: src.pull!.mergeCommitSha },
      ),
      potentialMergeCommit: field('Commit', () => null),
      additions: field('Int!', (_forge, src) =>
        pullFiles(src.repo!, src.pull!).reduce((sum, file) => sum + ((file.payload?.additions as number) ?? 0), 0),
      ),
      deletions: field('Int!', (_forge, src) =>
        pullFiles(src.repo!, src.pull!).reduce((sum, file) => sum + ((file.payload?.deletions as number) ?? 0), 0),
      ),
      changedFiles: field('Int!', (_forge, src) => pullFiles(src.repo!, src.pull!).length),
      files: field(
        'PullRequestChangedFileConnection',
        (_forge, src, args) => connect('PullRequestChangedFileConnection', pullFiles(src.repo!, src.pull!), args),
        [
          { name: 'first', type: 'Int' },
          { name: 'after', type: 'String' },
        ],
      ),
      labels: field(
        'LabelConnection',
        (_forge, src, args) => connect('LabelConnection', [], args),
        [
          { name: 'first', type: 'Int' },
          { name: 'after', type: 'String' },
        ],
      ),
    },
  },

  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: field('String!', (_forge, src) => src.payload?.path ?? ''),
      additions: field('Int!', (_forge, src) => src.payload?.additions ?? 0),
      deletions: field('Int!', (_forge, src) => src.payload?.deletions ?? 0),
      changeType: field('FileChangeType!', (_forge, src) => src.payload?.changeType ?? 'MODIFIED'),
    },
  },

  Label: {
    kind: 'OBJECT',
    fields: {
      id: field('ID!', (_forge, src) => labelGid(src.repo!, src.label!)),
      name: field('String!', (_forge, src) => src.label!.name),
      color: field('String!', (_forge, src) => src.label!.color),
      description: field('String', (_forge, src) => src.label!.description),
      url: field('URI!', () => ''),
      isDefault: field('Boolean!', () => false),
    },
  },
};

// Connections and their edges, generated for each element type used above.
for (const [connection, elem] of [
  ['RepositoryConnection', 'Repository'],
  ['IssueConnection', 'Issue'],
  ['PullRequestConnection', 'PullRequest'],
  ['LabelConnection', 'Label'],
  ['IssueCommentConnection', 'IssueComment'],
  ['CommitConnection', 'Commit'],
  ['RefConnection', 'Ref'],
  ['PullRequestChangedFileConnection', 'PullRequestChangedFile'],
  ['SearchResultItemConnection', 'SearchResultItem'],
] as const) {
  TYPES[connection] = connectionOf(elem);
  TYPES[`${elem}Edge`] = edgeOf(elem);
}
TYPES['Node']!.possibleTypes = [
  'User',
  'Repository',
  'Issue',
  'PullRequest',
  'IssueComment',
  'Label',
  'Ref',
  'Commit',
  'Tree',
  'Blob',
];

// ---------------------------------------------------------------------------
// introspection types

interface TypeRefPayload {
  kind: string;
  name: string | null;
  ofType: TypeRefPayload | null;
}

function typeRefPayload(typeStr: string): TypeRefPayload {
  const trimmed = typeStr.trim();
  if (trimmed.endsWith('!')) {
    return { kind: 'NON_NULL', name: null, ofType: typeRefPayload(trimmed.slice(0, -1)) };
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return { kind: 'LIST', name: null, ofType: typeRefPayload(trimmed.slice(1, -1)) };
  }
  return { kind: TYPES[trimmed]?.kind ?? 'SCALAR', name: trimmed, ofType: null };
}

function namedTypeSrc(name: string): Src {
  return { t: '__Type', payload: { kind: TYPES[name]?.kind ?? 'SCALAR', name, ofType: null } };
}

Object.assign(TYPES, {
  __Type: {
    kind: 'OBJECT',
    fields: {
      kind: field('String!', (_forge, src) => (src.payload as TypeRefPayload).kind),
      name: field('String', (_forge, src) => (src.payload as TypeRefPayload).name),
      description: field('String', () => null),
      fields: field('[__Field]', (_forge, src) => {
        const payload = src.payload as TypeRefPayload;
        if (payload.name === null) return null;
        const def = TYPES[payload.name];
        if (def === undefined || (def.kind !== 'OBJECT' && def.kind !== 'INTERFACE') || def.fields === undefined) return null;
        return Object.keys(def.fields).map((fieldName) => ({
          t: '__Field',
          payload: { typeName: payload.name, fieldName },
        }));
      }),
      inputFields: field('[__InputValue]', (_forge, src) => {
        const payload = src.payload as TypeRefPayload;
        if (payload.name === null) return null;
        const def = TYPES[payload.name];
        if (def === undefined || def.kind !== 'INPUT_OBJECT' || def.inputFields === undefined) return null;
        return def.inputFields.map((input) => ({
          t: '__InputValue',
          payload: { name: input.name, type: input.type, defaultValue: null },
        }));
      }),
      enumValues: field('[__EnumValue]', (_forge, src) => {
        const payload = src.payload as TypeRefPayload;
        if (payload.name === null) return null;
        const def = TYPES[payload.name];
        if (def === undefined || def.kind !== 'ENUM' || def.enumValues === undefined) return null;
        return def.enumValues.map((name) => ({ t: '__EnumValue', payload: { name } }));
      }),
      possibleTypes: field('[__Type]', (_forge, src) => {
        const payload = src.payload as TypeRefPayload;
        if (payload.name === null) return null;
        const def = TYPES[payload.name];
        if (def === undefined || def.possibleTypes === undefined) return null;
        return def.possibleTypes.map((name) => namedTypeSrc(name));
      }),
      ofType: field('__Type', (_forge, src) => {
        const payload = src.payload as TypeRefPayload;
        return payload.ofType === null ? null : { t: '__Type', payload: payload.ofType };
      }),
      specifiedByURL: field('String', () => null),
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: field('String!', (_forge, src) => (src.payload as { fieldName: string }).fieldName),
      description: field('String', () => null),
      args: field('[__InputValue!]!', (_forge, src) => {
        const payload = src.payload as { typeName: string; fieldName: string };
        const def = TYPES[payload.typeName]?.fields?.[payload.fieldName];
        return (def?.args ?? []).map((arg) => ({
          t: '__InputValue',
          payload: { name: arg.name, type: arg.type, defaultValue: null },
        }));
      }),
      type: field('__Type!', (_forge, src) => {
        const payload = src.payload as { typeName: string; fieldName: string };
        const def = TYPES[payload.typeName]?.fields?.[payload.fieldName];
        return { t: '__Type', payload: typeRefPayload(def?.type ?? 'String') };
      }),
      isDeprecated: field('Boolean!', () => false),
      deprecationReason: field('String', () => null),
    },
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: {
      name: field('String!', (_forge, src) => (src.payload as { name: string }).name),
      description: field('String', () => null),
      type: field('__Type!', (_forge, src) => ({
        t: '__Type',
        payload: typeRefPayload((src.payload as { type: string }).type),
      })),
      defaultValue: field('String', (_forge, src) => (src.payload as { defaultValue: string | null }).defaultValue),
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: {
      name: field('String!', (_forge, src) => (src.payload as { name: string }).name),
      description: field('String', () => null),
      isDeprecated: field('Boolean!', () => false),
      deprecationReason: field('String', () => null),
    },
  },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      types: field('[__Type!]!', () => Object.keys(TYPES).map((name) => namedTypeSrc(name))),
      queryType: field('__Type!', () => namedTypeSrc('Query')),
      mutationType: field('__Type', () => namedTypeSrc('Mutation')),
      subscriptionType: field('__Type', () => null),
      directives: field('[__Directive!]!', () => []),
    },
  },
  __Directive: {
    kind: 'OBJECT',
    fields: {
      name: field('String!', () => ''),
      description: field('String', () => null),
      locations: field('[String!]!', () => []),
      args: field('[__InputValue!]!', () => []),
    },
  },
} as Record<string, TypeDef>);

// __schema and __type live on Query but outside the registry's field list for the type.
TYPES['Query']!.fields!['__schema'] = field('__Schema!', () => ({ t: '__Schema' }));
TYPES['Query']!.fields!['__type'] = field(
  '__Type',
  (_forge, _src, args) => {
    const name = str(args.name);
    if (name === null || TYPES[name] === undefined) return null;
    return namedTypeSrc(name);
  },
  [{ name: 'name', type: 'String!' }],
);

// ---------------------------------------------------------------------------
// executor

interface GqlError {
  message: string;
  path?: (string | number)[];
}

interface ExecCtx {
  forge: Forge;
  doc: DocumentNode;
  variables: Record<string, unknown>;
  errors: GqlError[];
}

function baseTypeName(typeStr: string): string {
  return typeStr.replace(/[[\]!]/g, '');
}

function isListType(typeStr: string): boolean {
  const trimmed = typeStr.trim();
  if (trimmed.endsWith('!')) return isListType(trimmed.slice(0, -1));
  return trimmed.startsWith('[');
}

function innerType(typeStr: string): string {
  const trimmed = typeStr.trim();
  if (trimmed.endsWith('!')) return innerType(trimmed.slice(0, -1));
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1);
  return trimmed;
}

function typeMatches(condition: string, src: Src, declaredType: string): boolean {
  if (condition === src.t || condition === declaredType) return true;
  const possible = TYPES[condition]?.possibleTypes;
  return possible !== undefined && possible.includes(src.t);
}

function expandSelections(
  ctx: ExecCtx,
  src: Src,
  declaredType: string,
  selections: SelectionNode[],
  out: FieldNode[],
): void {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      out.push(selection);
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === null || typeMatches(selection.typeCondition, src, declaredType)) {
        expandSelections(ctx, src, selection.typeCondition ?? declaredType, selection.selectionSet, out);
      }
    } else {
      const fragment = ctx.doc.fragments.get(selection.name);
      if (fragment !== undefined && typeMatches(fragment.typeCondition, src, declaredType)) {
        expandSelections(ctx, src, fragment.typeCondition, fragment.selectionSet, out);
      }
    }
  }
}

function resolveObject(
  ctx: ExecCtx,
  src: Src,
  declaredType: string,
  selections: SelectionNode[] | null,
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (selections === null) return out;
  const fields: FieldNode[] = [];
  expandSelections(ctx, src, declaredType, selections, fields);
  for (const node of fields) {
    const key = node.alias ?? node.name;
    const fieldPath = [...path, key];
    if (node.name === '__typename') {
      out[key] = src.t === 'Edge' ? declaredType : src.t;
      continue;
    }
    // The concrete type's resolver wins: interface field defs are placeholders for validation
    // and introspection, while the object at hand knows how to answer.
    const def = TYPES[src.t]?.fields?.[node.name] ?? TYPES[declaredType]?.fields?.[node.name];
    if (def === undefined) {
      ctx.errors.push({ message: `Field '${node.name}' doesn't exist on type '${declaredType}'`, path: fieldPath });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of node.args) args[arg.name] = evalValue(arg.value, ctx.variables);
    let raw: unknown;
    try {
      raw = def.resolve(ctx.forge, src, args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : 'internal error', path: fieldPath });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, def.type, raw, node.selectionSet, fieldPath);
  }
  return out;
}

function completeValue(
  ctx: ExecCtx,
  typeStr: string,
  raw: unknown,
  selections: SelectionNode[] | null,
  path: (string | number)[],
): unknown {
  if (raw === null || raw === undefined) return null;
  if (isListType(typeStr)) {
    const inner = innerType(typeStr);
    const items = Array.isArray(raw) ? raw : [raw];
    return items.map((item, index) => completeValue(ctx, inner, item, selections, [...path, index]));
  }
  const base = baseTypeName(typeStr);
  const def = TYPES[base];
  if (def === undefined || def.kind === 'SCALAR' || def.kind === 'ENUM') {
    return base === 'ID' ? String(raw) : raw;
  }
  if (typeof raw === 'object' && raw !== null && 't' in raw) {
    return resolveObject(ctx, raw as Src, base, selections, path);
  }
  return raw;
}

/** A light validation pass: unknown fields are reported in GitHub's wording, before execution. */
function validateSelections(
  ctx: ExecCtx,
  declaredType: string,
  selections: SelectionNode[],
  errors: GqlError[],
): void {
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      const condition = selection.typeCondition;
      if (condition !== null && TYPES[condition] === undefined) {
        errors.push({ message: `Type '${condition}' doesn't exist` });
        continue;
      }
      validateSelections(ctx, condition ?? declaredType, selection.selectionSet, errors);
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.doc.fragments.get(selection.name);
      if (fragment === undefined) {
        errors.push({ message: `Fragment '${selection.name}' doesn't exist` });
        continue;
      }
      validateSelections(ctx, fragment.typeCondition, fragment.selectionSet, errors);
      continue;
    }
    if (selection.name === '__typename') continue;
    const def = TYPES[declaredType]?.fields?.[selection.name];
    if (def === undefined) {
      errors.push({ message: `Field '${selection.name}' doesn't exist on type '${declaredType}'` });
      continue;
    }
    if (selection.selectionSet !== null) {
      validateSelections(ctx, baseTypeName(def.type), selection.selectionSet, errors);
    }
  }
}

export interface GraphQLResult {
  data?: unknown;
  errors?: GqlError[];
}

export function executeGraphQL(
  forge: Forge,
  query: string,
  variables: Record<string, unknown>,
  operationName: string | null,
): GraphQLResult {
  let doc: DocumentNode;
  try {
    doc = new Parser(query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation =
    doc.operations.find((candidate) => operationName === null || candidate.name === operationName) ?? doc.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation found' }] };
  const mergedVariables: Record<string, unknown> = {};
  for (const [name, defaultNode] of operation.variableDefaults) {
    mergedVariables[name] = evalValue(defaultNode, {});
  }
  Object.assign(mergedVariables, variables);
  const ctx: ExecCtx = { forge, doc, variables: mergedVariables, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const validationErrors: GqlError[] = [];
  validateSelections(ctx, rootType, operation.selectionSet, validationErrors);
  if (validationErrors.length > 0) return { data: null, errors: validationErrors };
  const root: Src = { t: rootType };
  const data = resolveObject(ctx, root, rootType, operation.selectionSet, []);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** Handle one POST /api/graphql body: a single operation or a batch (array) of them. */
export function handleGraphQL(forge: Forge, bodyText: string): { status: number; payload: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, payload: { errors: [{ message: 'request body is not valid JSON' }] } };
  }
  const runOne = (entry: unknown): GraphQLResult => {
    if (entry === null || typeof entry !== 'object') return { errors: [{ message: 'invalid operation' }] };
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables =
      record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables)
        ? (record.variables as Record<string, unknown>)
        : {};
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    if (query === '') return { errors: [{ message: 'query is required' }] };
    return executeGraphQL(forge, query, variables, operationName);
  };
  if (Array.isArray(parsed)) return { status: 200, payload: parsed.map(runOne) };
  return { status: 200, payload: runOne(parsed) };
}
