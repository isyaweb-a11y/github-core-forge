// The MCP surface (streamable HTTP, stateless): both protocol eras the suite speaks — the modern
// `server/discover` handshake and the legacy `initialize` one — plus tools/list and tools/call for
// six tools that operate on the same forge store as REST and GraphQL. Tool results carry both a
// text content block (the result as JSON) and structuredContent, as the spec prescribes.

import { issueJson, mergePullRequest, pullJson, repoJson } from './rest.ts';
import type { Forge, Repo } from './store.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
  run: (forge: Forge, args: Record<string, unknown>) => unknown;
}

/** The tool list is built once and never rebuilt, so tools/list is byte-identical across calls. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    run: (forge, args) => {
      const repo = forge.createRepo(
        args.name as string,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      if (repo === null) throw new Error('Repository creation failed: a repository with this name already exists.');
      return repoJson(forge, repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by its owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
    run: (forge, args) => repoJson(forge, repoOrThrow(forge, args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
    run: (forge, args) => {
      const repo = repoOrThrow(forge, args);
      const issue = forge.createIssue(
        repo,
        args.title as string,
        typeof args.body === 'string' ? args.body : '',
        [],
        forge.viewer.login,
      );
      return issueJson(forge, repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
    run: (forge, args) => {
      const repo = repoOrThrow(forge, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.createdSeq - b.createdSeq || a.number - b.number)
        .map((issue) => issueJson(forge, repo, issue));
      return { issues };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The head branch to merge from.' },
        base: { type: 'string', description: 'The base branch to merge into.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
    run: (forge, args) => {
      const repo = repoOrThrow(forge, args);
      const head = args.head as string;
      const base = args.base as string;
      if (repo.branchTip(head) === null) throw new Error(`head branch '${head}' does not exist`);
      if (repo.branchTip(base) === null) throw new Error(`base branch '${base}' does not exist`);
      const duplicate = [...repo.pulls.values()].some(
        (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
      );
      if (duplicate) throw new Error('A pull request already exists for this head and base combination.');
      const pull = forge.createPull(
        repo,
        args.title as string,
        typeof args.body === 'string' ? args.body : '',
        head,
        base,
        forge.viewer.login,
      );
      return pullJson(forge, repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
    run: (forge, args) => {
      const repo = repoOrThrow(forge, args);
      const pull = repo.pulls.get(args.pull_number as number);
      if (pull === undefined) throw new Error('Not Found');
      const sha = mergePullRequest(forge, repo, pull, 'merge');
      if (sha === null) throw new Error('Pull Request is not mergeable');
      return pullJson(forge, repo, pull);
    },
  },
];

function repoOrThrow(forge: Forge, args: Record<string, unknown>): Repo {
  const repo = forge.getRepo(typeof args.owner === 'string' ? args.owner : '', typeof args.repo === 'string' ? args.repo : '');
  if (repo === null) throw new Error('Not Found');
  return repo;
}

const TOOLS_LIST = TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
}));

interface RpcOutcome {
  status: number;
  payload?: unknown;
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function handleOne(forge: Forge, authed: boolean, message: Record<string, unknown>): RpcOutcome | null {
  const method = typeof message.method === 'string' ? message.method : '';
  const id = message.id;
  const params = (message.params ?? {}) as Record<string, unknown>;
  const isNotification = id === undefined || id === null;
  if (isNotification) return null; // notifications are accepted and ignored (202, empty body)

  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        payload: rpcResult(id, {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        }),
      };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-06-18';
      return {
        status: 200,
        payload: rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        }),
      };
    }
    case 'ping':
      return { status: 200, payload: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, payload: rpcResult(id, { tools: TOOLS_LIST }) };
    case 'tools/call': {
      if (!authed) {
        return { status: 401, payload: rpcError(id, -32001, 'Unauthorized: a valid bearer <redacted> is required') };
      }
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        return { status: 200, payload: rpcError(id, -32601, `Method not found: unknown tool '${name}'`) };
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const missing = tool.inputSchema.required.filter(
        (key) => args[key] === undefined || args[key] === null || args[key] === '',
      );
      if (missing.length > 0) {
        return {
          status: 200,
          payload: rpcError(id, -32602, `Invalid params: missing required argument(s): ${missing.join(', ')}`),
        };
      }
      try {
        const value = tool.run(forge, args);
        return {
          status: 200,
          payload: rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(value) }],
            structuredContent: value,
            isError: false,
          }),
        };
      } catch (err) {
        const messageText = err instanceof Error ? err.message : 'tool execution failed';
        return {
          status: 200,
          payload: rpcResult(id, {
            content: [{ type: 'text', text: messageText }],
            isError: true,
          }),
        };
      }
    }
    case 'resources/list':
      return { status: 200, payload: rpcResult(id, { resources: [] }) };
    case 'resources/templates/list':
      return { status: 200, payload: rpcResult(id, { resourceTemplates: [] }) };
    case 'prompts/list':
      return { status: 200, payload: rpcResult(id, { prompts: [] }) };
    default:
      return { status: 200, payload: rpcError(id, -32601, `Method not found: '${method}'`) };
  }
}

/** Handle one POST /mcp body. `authed` says whether the request carried the trial's bearer <redacted> */
export function handleMCP(forge: Forge, authed: boolean, bodyText: string): RpcOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, payload: rpcError(null, -32700, 'Parse error: request body is not valid JSON') };
  }
  if (Array.isArray(parsed)) {
    const results: unknown[] = [];
    let status = 200;
    for (const entry of parsed) {
      if (entry === null || typeof entry !== 'object') continue;
      const outcome = handleOne(forge, authed, entry as Record<string, unknown>);
      if (outcome !== null) {
        if (outcome.status !== 200) status = outcome.status;
        if (outcome.payload !== undefined) results.push(outcome.payload);
      }
    }
    if (results.length === 0) return { status: 202 };
    return { status, payload: results };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { status: 400, payload: rpcError(null, -32700, 'Parse error: expected a JSON-RPC message') };
  }
  const outcome = handleOne(forge, authed, parsed as Record<string, unknown>);
  if (outcome === null) return { status: 202 };
  return outcome;
}
