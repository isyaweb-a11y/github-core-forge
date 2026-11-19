// The REST v3 surface: /user/repos, /repos/{owner}/{repo} with branches, commits, contents,
// git/refs, labels, issues, comments and pull requests (list, files, merge). Handlers share the
// forge store with the git, GraphQL and MCP surfaces, so an effect through any of them is visible
// through all. Response shapes follow GitHub's: the suite reads them leniently, but statuses,
// error bodies and pagination links follow the real contract.

import { ZERO_OID, parseCommit, parseTree } from './gitobj.ts';
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

export interface Ctx {
  forge: Forge;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  origin: string;
  json: (status: number, value: unknown, headers?: Record<string, string>) => void;
  noContent: () => void;
}

export interface Route {
  method: string;
  /** Path segments under /api/v3; `:name` captures one segment, `:name*` captures the rest. */
  pattern: string[];
  handler: (ctx: Ctx) => void;
}

const route = (method: string, pattern: string, handler: (ctx: Ctx) => void): Route => ({
  method,
  pattern: pattern === '' ? [] : pattern.split('/'),
  handler,
});

// ---------------------------------------------------------------------------
// serializers

export function userJson(forge: Forge): Record<string, unknown> {
  const viewer = forge.viewer;
  return {
    login: viewer.login,
    id: viewer.id,
    type: 'User',
    name: viewer.name,
    email: viewer.email,
    avatar_url: '',
    html_url: '',
    site_admin: false,
  };
}

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `repo-${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: userJson(forge),
    html_url: '',
    clone_url: '',
    created_at: forge.iso(repo.createdSeq),
    updated_at: forge.iso(repo.createdSeq),
    pushed_at: forge.iso(repo.createdSeq),
    size: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    fork: false,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: `label-${label.id}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: '',
  };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `issue-${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelJson(label) : { name };
    }),
    user: userJson(forge),
    comments: issue.comments.length,
    created_at: forge.iso(issue.createdSeq),
    updated_at: forge.iso(issue.closedSeq ?? issue.createdSeq),
    closed_at: issue.closedSeq === null ? null : forge.iso(issue.closedSeq),
    html_url: '',
    url: '',
  };
}

export function commentJson(forge: Forge, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `comment-${comment.id}`,
    body: comment.body,
    user: userJson(forge),
    created_at: forge.iso(comment.createdSeq),
    updated_at: forge.iso(comment.createdSeq),
    html_url: '',
    url: '',
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const side = (ref: string): Record<string, unknown> => ({
    ref,
    sha: repo.branchTip(ref),
    label: `${repo.ownerLogin}:${ref}`,
    user: userJson(forge),
    repo: repoJson(forge, repo),
  });
  return {
    id: pull.id,
    node_id: `pull-${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: side(pull.headRef),
    base: side(pull.baseRef),
    merged: pull.merged,
    merged_at: pull.mergedSeq === null ? null : forge.iso(pull.mergedSeq),
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(forge),
    created_at: forge.iso(pull.createdSeq),
    updated_at: forge.iso(pull.mergedSeq ?? pull.createdSeq),
    closed_at: pull.state === 'closed' ? forge.iso(pull.mergedSeq ?? pull.createdSeq) : null,
    html_url: '',
    url: '',
  };
}

// ---------------------------------------------------------------------------
// helpers

function notFound(ctx: Ctx): void {
  ctx.json(404, { message: 'Not Found' });
}

function validationFailed(ctx: Ctx, message: string): void {
  ctx.json(422, { message: `Validation Failed: ${message}`, errors: [{ message }] });
}

function repoOr404(ctx: Ctx): Repo | null {
  const repo = ctx.forge.getRepo(ctx.params.owner!, ctx.params.repo!);
  if (repo === null) notFound(ctx);
  return repo;
}

interface Page {
  perPage: number;
  page: number;
}

function pageOf(ctx: Ctx): Page {
  const perPageRaw = Number.parseInt(ctx.query.get('per_page') ?? '30', 10);
  const pageRaw = Number.parseInt(ctx.query.get('page') ?? '1', 10);
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

/** Slice a list for the page and answer the Link header value for it ('' when there is one page). */
function paginate<T>(ctx: Ctx, items: readonly T[], path: string): { slice: T[]; link: string } {
  const { perPage, page } = pageOf(ctx);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  if (items.length <= perPage) return { slice, link: '' };
  const url = (p: number): string => `${ctx.origin}${path}?per_page=${perPage}&page=${p}`;
  const links: string[] = [];
  if (page < totalPages) {
    links.push(`<${url(page + 1)}>; rel="next"`, `<${url(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${url(1)}>; rel="first"`, `<${url(page - 1)}>; rel="prev"`);
  }
  return { slice, link: links.join(', ') };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function labelNamesOf(ctx: Ctx, value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry !== null && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    } else return null;
  }
  return names;
}

/** Validate that every named label exists in the repo; answers false (after responding) if not. */
function labelsExist(ctx: Ctx, repo: Repo, names: readonly string[]): boolean {
  for (const name of names) {
    if (!repo.labels.has(name)) {
      validationFailed(ctx, `label '${name}' does not exist in this repository`);
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// routes

export const REST_ROUTES: Route[] = [
  route('GET', '', (ctx) => {
    ctx.json(200, {
      current_user_url: `${ctx.origin}/api/v3/user`,
      current_user_repositories_url: `${ctx.origin}/api/v3/user/repos`,
      repository_url: `${ctx.origin}/api/v3/repos/{owner}/{repo}`,
      issue_search_url: `${ctx.origin}/api/v3/search/issues`,
    });
  }),

  route('GET', 'meta', (ctx) => {
    ctx.json(200, {
      installed_version: '1.0.0',
      services: { git: true, api: true },
      hooks: [],
    });
  }),

  route('GET', 'user', (ctx) => {
    ctx.json(200, userJson(ctx.forge));
  }),

  // ------------------------------------------------------------- repositories

  route('POST', 'user/repos', (ctx) => {
    const name = asString(ctx.body.name);
    if (name === null || name === '' || /[\s/]/.test(name)) {
      validationFailed(ctx, 'name is required and must be a valid repository name');
      return;
    }
    const repo = ctx.forge.createRepo(
      name,
      asString(ctx.body.description) ?? '',
      ctx.body.private === true,
    );
    if (repo === null) {
      ctx.json(422, {
        message: 'Repository creation failed: a repository with this name already exists.',
        errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
      });
      return;
    }
    ctx.json(201, repoJson(ctx.forge, repo));
  }),

  route('GET', 'user/repos', (ctx) => {
    const repos = ctx.forge.listRepos();
    const { slice, link } = paginate(ctx, repos, '/api/v3/user/repos');
    ctx.json(200, slice.map((repo) => repoJson(ctx.forge, repo)), link === '' ? undefined : { Link: link });
  }),

  route('GET', 'repos/:owner/:repo', (ctx) => {
    const repo = repoOr404(ctx);
    if (repo !== null) ctx.json(200, repoJson(ctx.forge, repo));
  }),

  route('PATCH', 'repos/:owner/:repo', (ctx) => {
    const repo = repoOr404(ctx);
    if (repo === null) return;
    const description = asString(ctx.body.description);
    if (description !== null) repo.description = description;
    if (typeof ctx.body.private === 'boolean') repo.isPrivate = ctx.body.private;
    const newName = asString(ctx.body.name);
    if (newName !== null && newName !== '' && newName !== repo.name) {
      const existing = ctx.forge.getRepo(repo.ownerLogin, newName);
      if (existing !== null) {
        validationFailed(ctx, 'name already exists on this account');
        return;
      }
      ctx.forge.repos.delete(`${repo.ownerLogin}/${repo.name}`);
      repo.name = newName;
      ctx.forge.repos.set(`${repo.ownerLogin}/${repo.name}`, repo);
    }
    ctx.json(200, repoJson(ctx.forge, repo));
  }),

  route('DELETE', 'repos/:owner/:repo', (ctx) => {
    const repo = repoOr404(ctx);
    if (repo === null) return;
    ctx.forge.deleteRepo(repo);
    ctx.noContent();
  }),

  // ------------------------------------------------------------- branches & commits

  route('GET', 'repos/:owner/:repo/branches', (ctx) => {
    const repo = repoOr404(ctx);
    if (repo === null) return;
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, oid]) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha: oid, url: '' },
        protected: false,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    const { slice, link } = paginate(ctx, branches, `/api/v3/repos/${repo.ownerLogin}/${repo.name}/branches`);
    ctx.json(200, slice, link === '' ? undefined : { Link: link });
  }),

  route('GET', 'repos/:owner/:repo/commits', (ctx) => {
    const repo = repoOr404(ctx);
    if (repo === null) return;
    const ref = ctx.query.get('sha') ?? repo.defaultBranch;
    const oid = repo.resolveRef(ref);
    const tip = oid === null ? null : repo.peelToCommit(oid);
    if (tip === null) {
      ctx.json(200, []);
      return;
    }
    const commits = repo.ancestorsOf(tip).map((sha) => {
      const info = parseCommit(repo.getObject(sha)!.data);
      const person = (ident: string): Record<string, unknown> => {
        const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(ident);
        return {
          name: match?.[1] ?? '',
          email: match?.[2] ?? '',
          date: ctx.forge.iso(Number.parseInt(match?.[3] ?? '0', 10)),
        };
      };
      return {
        sha,
        node_id: `commit-${sha}`,
        commit: {
          message: info.message,
          author: person(info.author),
          committer: person(info.committer),
          tree: { sha: info.tree, url: '' },
          comment_count: 0,
        },
        parents: info.parents.map((parent) => ({ sha: parent, url: '' })),
        author: null,
        committer: null,
        html_url: '',
        url: '',
      };
    });
    const { slice, link } = paginate(ctx, commits, `/api/v3/repos/${repo.ownerLogin}/${repo.name}/commits`);
    ctx.json(200, slice, link === '' ? undefined : { Link: link });
  }),

  // ------------------------------------------------------------- git refs

  route('POST', 'repos/:owner/:repo/git/refs', (ctx) => {
    const repo = repoOr404(ctx);
    if (repo === null) return;
    const ref = asString(ctx.body.ref);
    const sha = asString(ctx.body.sha);
    if (ref === null || !ref.startsWith('refs/') || sha === null || repo.getObject(sha) === undefined) {
      validationFailed(ctx, 'ref and a sha naming an existing object are required');
      return;
    }
    if (repo.refs.has(ref)) {
      validationFailed(ctx, 'Reference already exists');
      return;
    }
    repo.refs.set(ref, sha);
    ctx.json(201, {
      ref,
      node_id: `ref-${ref}`,
      url: '',
      object: { sha, type: repo.getObject(sha)!.type, url: '' },
    });
  }),

  route('GET', 'repos/:owner/:repo/git/refs', (ctx) => {
    const repo = repoOr404(ctx);
    if (repo === null) return;
    const refs = [...repo.refs.entries()].map(([ref, oid]) => ({
      ref,
      node_id: `ref-${ref}`,
      url: '',
      object: { sha: oid, type: repo.getObject(oid)?.type ?? 'commit', url: '' },
    }));
    ctx.json(200, refs);
  }),

  // ------------------------------------------------------------- contents

  route('GET', 'repos/:owner/:repo/contents/:path*', (ctx) => contentsGet(ctx)),
  route('PUT', 'repos/:owner/:repo/contents/:path*', (ctx) => contentsPut(ctx)),
  route('DELETE', 'repos/:owner/:repo/contents/:path*', (ctx) => contentsDelete(ctx)),

  // ------------------------------------------------------------- labels

  route('POST', 'repos/:owner/:repo/labels', (ctx) => {
    const repo = repoOr404(ctx);
    if (repo === null) return;
    const name = asString(ctx.body.name);
    if (name === null || name === '') {
      validationFailed(ctx, 'name is required');
      return;
    }
    if (repo.labels.has(name)) {
      validationFailed(ctx, 'a label with this name already exists');
      return;
    }
    const color = (asString(ctx.body.color) ?? 'ededed').replace(/^#/, '');
    const label = ctx.forge.createLabel(repo, name, color, asString(ctx.body.description));
    ctx.json(201, labelJson(label));
  }),

  route('GET', 'repos/:owner/:repo/labels', (ctx) => {
    const repo = repoOr404(ctx);
    if (repo === null) return;
    const labels = [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    const { slice, link } = paginate(ctx, labels, `/api/v3/repos/${repo.ownerLogin}/${repo.name}/labels`);
    ctx.json(200, slice.map(labelJson), link === '' ? undefined : { Link: link });
  }),

  // ------------------------------------------------------------- issues

  route('POST', 'repos/:owner/:repo/issues', (ctx) => {
    const repo = repoOr404(ctx);
    if (repo === null) return;
    const title = asString(ctx.body.title);
    if (title === null || title === '') {
      validationFailed(ctx, 'title is required');
      return;
    }
    const labelNames = labelNamesOf(ctx, ctx.body.labels);
    if (labelNames === null) {
      validationFailed(ctx, 'labels must be an array of names');
      return;
    }
    if (!labelsExist(ctx, repo, labelNames)) return;
    const issue = ctx.forge.createIssue(repo, title, asString(ctx.body.body) ?? '', labelNames, ctx.forge.viewer.login);
    ctx.json(201, issueJson(ctx.forge, repo, issue));
  }),

  route('GET', 'repos/:owner/:repo/issues', (ctx) => {
    const repo = repoOr404(ctx);
    if (repo === null) return;
    const state = ctx.query.get('state') ?? 'open';
    let issues = [...repo.issues.values()];
    if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
    const labelFilter = ctx.query.get('labels');
    if (labelFilter !== null && labelFilter !== '') {
      const wanted = labelFilter.split(',');
      issues = issues.filter((issue) => wanted.every((name) => issue.labels.includes(name)));
    }
    const direction = ctx.query.get('direction') ?? 'desc';
    issues.sort((a, b) => (a.createdSeq - b.createdSeq || a.number - b.number) * (direction === 'asc' ? 1 : -1));
    const { slice, link } = paginate(ctx, issues, `/api/v3/repos/${repo.ownerLogin}/${repo.name}/issues`);
    ctx.json(200, slice.map((issue) => issueJson(ctx.forge, repo, issue)), link === '' ? undefined : { Link: link });
  }),

  route('GET', 'repos/:owner/:repo/issues/:number', (ctx) => {
    const repo = repoOr404(ctx);
    if (repo === null) return;
    const issue = repo.issues.get(Number.parseInt(ctx.params.number!, 10));
    if (issue === undefined) {
      notFound(ctx);
      return;
    }
    ctx.json(200, issueJson(ctx.forge, repo, issue));
  }),

  route('PATCH', 'repos/:owner/:repo/issues/:number', (ctx) => {
    const repo = repoOr404(ctx);
    if (repo === null) return;
    const issue = repo.issues.get(Number.parseInt(ctx.params.number!, 10));
    if (issue === undefined) {
      notFound(ctx);
      return;
    }
    const title = asString(ctx.body.title);
    if (title !== null) issue.title = title;
    const body = asString(ctx.body.body);
    if (body !== null) issue.body = body;
    if (ctx.body.labels !== undefined) {
      const labelNames = labelNamesOf(ctx, ctx.body.labels);
      if (labelNames === null) {
        validationFailed(ctx, 'labels must be an array of names');
        return;
      }
      if (!labelsExist(ctx, repo, labelNames)) return;
      issue.labels = labelNames;
    }
    const state = asString(ctx.body.state);
    if (state === 'closed' && issue.state !== 'closed') {
      issue.state = 'closed';
      issue.closedSeq = ctx.forge.tick();
    } else if (state === 'open' && issue.state !== 'open') {
      issue.state = 'open';
      issue.closedSeq = null;
    }
    ctx.json(200, issueJson(ctx.forge, repo, issue));
  }),

  route('POST', 'repos/:owner/:repo/issues/:number/comments', (ctx) => {
    const repo = repoOr404(ctx);
    if (repo === null) return;
    const issue = repo.issues.get(Number.parseInt(ctx.params.number!, 10));
    if (issue === undefined) {
      notFound(ctx);
      return;
    }
    const body = asString(ctx.body.body);
    if (body === null) {
      validationFailed(ctx, 'body is required');
      return;
    }
    const comment = ctx.forge.addComment(repo, issue, body, ctx.forge.viewer.login);
    ctx.json(201, commentJson(ctx.forge, comment));
  }),

  route('GET', 'repos/:owner/:repo/issues/:number/comments', (ctx) => {
    const repo = repoOr404(ctx);
    if (repo === null) return;
    const issue = repo.issues.get(Number.parseInt(ctx.params.number!, 10));
    if (issue === undefined) {
      notFound(ctx);
      return;
    }
    const comments = [...issue.comments].sort((a, b) => a.id - b.id);
    const { slice, link } = paginate(
      ctx,
      comments,
      `/api/v3/repos/${repo.ownerLogin}/${repo.name}/issues/${issue.number}/comments`,
    );
    ctx.json(200, slice.map((comment) => commentJson(ctx.forge, comment)), link === '' ? undefined : { Link: link });
  }),

  // ------------------------------------------------------------- pull requests

  route('POST', 'repos/:owner/:repo/pulls', (ctx) => {
    const repo = repoOr404(ctx);
    if (repo === null) return;
    const title = asString(ctx.body.title);
    const headRaw = asString(ctx.body.head);
    const baseRaw = asString(ctx.body.base);
    if (title === null || headRaw === null || baseRaw === null) {
      validationFailed(ctx, 'title, head and base are required');
      return;
    }
    const head = headRaw.includes(':') ? headRaw.slice(headRaw.indexOf(':') + 1) : headRaw;
    const base = baseRaw.includes(':') ? baseRaw.slice(baseRaw.indexOf(':') + 1) : baseRaw;
    const headTip = repo.branchTip(head);
    const baseTip = repo.branchTip(base);
    if (headTip === null) {
      validationFailed(ctx, `head branch '${head}' does not exist`);
      return;
    }
    if (baseTip === null) {
      validationFailed(ctx, `base branch '${base}' does not exist`);
      return;
    }
    if (headTip === baseTip) {
      validationFailed(ctx, `No commits between ${base} and ${head}`);
      return;
    }
    const duplicate = [...repo.pulls.values()].some(
      (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
    );
    if (duplicate) {
      ctx.json(422, {
        message: `Validation Failed: A pull request already exists for ${repo.ownerLogin}:${head} -> ${base}.`,
        errors: [{ resource: 'PullRequest', code: 'custom', message: 'A pull request already exists for this combination.' }],
      });
      return;
    }
    const pull = ctx.forge.createPull(repo, title, asString(ctx.body.body) ?? '', head, base, ctx.forge.viewer.login);
    ctx.json(201, pullJson(ctx.forge, repo, pull));
  }),

  route('GET', 'repos/:owner/:repo/pulls', (ctx) => {
    const repo = repoOr404(ctx);
    if (repo === null) return;
    const state = ctx.query.get('state') ?? 'open';
    let pulls = [...repo.pulls.values()];
    if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
    const direction = ctx.query.get('direction') ?? 'desc';
    pulls.sort((a, b) => (a.createdSeq - b.createdSeq || a.number - b.number) * (direction === 'asc' ? 1 : -1));
    const { slice, link } = paginate(ctx, pulls, `/api/v3/repos/${repo.ownerLogin}/${repo.name}/pulls`);
    ctx.json(200, slice.map((pull) => pullJson(ctx.forge, repo, pull)), link === '' ? undefined : { Link: link });
  }),

  route('GET', 'repos/:owner/:repo/pulls/:number', (ctx) => {
    const repo = repoOr404(ctx);
    if (repo === null) return;
    const pull = repo.pulls.get(Number.parseInt(ctx.params.number!, 10));
    if (pull === undefined) {
      notFound(ctx);
      return;
    }
    ctx.json(200, pullJson(ctx.forge, repo, pull));
  }),

  route('PATCH', 'repos/:owner/:repo/pulls/:number', (ctx) => {
    const repo = repoOr404(ctx);
    if (repo === null) return;
    const pull = repo.pulls.get(Number.parseInt(ctx.params.number!, 10));
    if (pull === undefined) {
      notFound(ctx);
      return;
    }
    const title = asString(ctx.body.title);
    if (title !== null) pull.title = title;
    const body = asString(ctx.body.body);
    if (body !== null) pull.body = body;
    const state = asString(ctx.body.state);
    if (state === 'closed' || state === 'open') pull.state = state;
    const base = asString(ctx.body.base);
    if (base !== null) pull.baseRef = base;
    ctx.json(200, pullJson(ctx.forge, repo, pull));
  }),

  route('GET', 'repos/:owner/:repo/pulls/:number/files', (ctx) => {
    const repo = repoOr404(ctx);
    if (repo === null) return;
    const pull = repo.pulls.get(Number.parseInt(ctx.params.number!, 10));
    if (pull === undefined) {
      notFound(ctx);
      return;
    }
    const headTip = repo.branchTip(pull.headRef);
    const baseTip = repo.branchTip(pull.baseRef);
    if (headTip === null || baseTip === null) {
      ctx.json(200, []);
      return;
    }
    const mergeBase = repo.mergeBase(baseTip, headTip) ?? baseTip;
    const changes = diffFiles(repo, repo.filesAt(mergeBase), repo.filesAt(headTip));
    const files = changes.map((change) => {
      const after = repo.filesAt(headTip).get(change.path);
      const before = repo.filesAt(mergeBase).get(change.path);
      return {
        filename: change.path,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.changes,
        sha: (after ?? before)?.oid ?? ZERO_OID,
        blob_url: '',
        raw_url: '',
        contents_url: '',
      };
    });
    const { slice, link } = paginate(ctx, files, `/api/v3/repos/${repo.ownerLogin}/${repo.name}/pulls/${pull.number}/files`);
    ctx.json(200, slice, link === '' ? undefined : { Link: link });
  }),

  route('PUT', 'repos/:owner/:repo/pulls/:number/merge', (ctx) => mergePull(ctx)),
];

/** Shared merge logic (also used by GraphQL and MCP): answers the merge commit's oid or null. */
export function mergePullRequest(
  forge: Forge,
  repo: Repo,
  pull: PullRequest,
  method: 'merge' | 'squash' | 'rebase',
): string | null {
  if (pull.state !== 'open' || pull.merged) return null;
  const baseTip = repo.branchTip(pull.baseRef);
  const headTip = repo.branchTip(pull.headRef);
  if (baseTip === null || headTip === null) return null;
  const mergeBase = repo.mergeBase(baseTip, headTip);
  const baseFiles = mergeBase === null ? new Map() : repo.filesAt(mergeBase);
  const outcome = mergeFiles(baseFiles, repo.filesAt(baseTip), repo.filesAt(headTip));
  if (outcome.conflicts.length > 0) return null;
  const tree = repo.buildTreeFromFiles(outcome.files);
  const epoch = forge.tick();
  let commit: string;
  if (method === 'merge') {
    commit = repo.makeCommit(tree, [baseTip, headTip], `Merge pull request #${pull.number} from ${pull.headRef}`, epoch);
  } else {
    const message = pull.body === '' ? pull.title : `${pull.title}\n\n${pull.body}`;
    commit = repo.makeCommit(tree, [baseTip], message, epoch);
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedSeq = epoch;
  pull.mergeCommitSha = commit;
  return commit;
}

function mergePull(ctx: Ctx): void {
  const repo = repoOr404(ctx);
  if (repo === null) return;
  const pull = repo.pulls.get(Number.parseInt(ctx.params.number!, 10));
  if (pull === undefined) {
    notFound(ctx);
    return;
  }
  const methodRaw = asString(ctx.body.merge_method) ?? 'merge';
  const method = methodRaw === 'squash' ? 'squash' : methodRaw === 'rebase' ? 'rebase' : 'merge';
  const sha = mergePullRequest(ctx.forge, repo, pull, method);
  if (sha === null) {
    ctx.json(405, { message: 'Pull Request is not mergeable' });
    return;
  }
  ctx.json(200, { sha, merged: true, message: 'Pull Request successfully merged' });
}

// ---------------------------------------------------------------------------
// contents handlers (paths span segments, so they live outside the table flow)

function contentsTarget(ctx: Ctx): { repo: Repo; path: string; branch: string } | null {
  const repo = repoOr404(ctx);
  if (repo === null) return null;
  const path = (ctx.params.path ?? '').replace(/^\/+|\/+$/g, '');
  const branch = ctx.query.get('ref') ?? (typeof ctx.body.branch === 'string' ? ctx.body.branch : repo.defaultBranch);
  return { repo, path, branch };
}

function contentsGet(ctx: Ctx): void {
  const target = contentsTarget(ctx);
  if (target === null) return;
  const { repo, path, branch } = target;
  const tip = repo.branchTip(branch) ?? repo.resolveRef(branch);
  if (tip === null) {
    notFound(ctx);
    return;
  }
  const commit = repo.peelToCommit(tip);
  if (commit === null) {
    notFound(ctx);
    return;
  }
  const tree = parseCommit(repo.getObject(commit)!.data).tree;
  // Walk to the target tree or blob.
  let currentTree: string | null = tree;
  let found: { mode: string; oid: string } | null = path === '' ? { mode: '40000', oid: tree } : null;
  if (path !== '') {
    const segments = path.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      if (currentTree === null) break;
      const entries = parseTree(repo.getObject(currentTree)!.data);
      const entry = entries.find((candidate) => candidate.name === segments[index]);
      if (entry === undefined) {
        found = null;
        currentTree = null;
        break;
      }
      if (index === segments.length - 1) {
        found = { mode: entry.mode, oid: entry.oid };
      } else if (entry.mode === '40000') {
        currentTree = entry.oid;
      } else {
        found = null;
        currentTree = null;
        break;
      }
    }
  }
  if (found === null) {
    notFound(ctx);
    return;
  }
  const name = path === '' ? '' : path.split('/').pop()!;
  if (found.mode === '40000') {
    const entries = parseTree(repo.getObject(found.oid)!.data).map((entry) => {
      const object = repo.getObject(entry.oid);
      return {
        name: entry.name,
        path: path === '' ? entry.name : `${path}/${entry.name}`,
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : (object?.data.length ?? 0),
        type: entry.mode === '40000' ? 'dir' : 'file',
        url: '',
        html_url: '',
        download_url: '',
      };
    });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    ctx.json(200, entries);
    return;
  }
  const object = repo.getObject(found.oid);
  if (object === undefined) {
    notFound(ctx);
    return;
  }
  ctx.json(200, {
    name,
    path,
    sha: found.oid,
    size: object.data.length,
    type: 'file',
    encoding: 'base64',
    content: object.data.toString('base64'),
    url: '',
    html_url: '',
    download_url: '',
  });
}

function contentsPut(ctx: Ctx): void {
  const target = contentsTarget(ctx);
  if (target === null) return;
  const { repo, path, branch } = target;
  if (path === '') {
    validationFailed(ctx, 'a file path is required');
    return;
  }
  const message = asString(ctx.body.message);
  const contentB64 = asString(ctx.body.content);
  if (message === null || contentB64 === null) {
    validationFailed(ctx, 'message and content are required');
    return;
  }
  const content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
  const tip = repo.branchTip(branch);
  const files = tip === null ? new Map<string, { mode: string; oid: string }>() : repo.filesAt(branch);
  const existing = files.get(path);
  const expectedSha = asString(ctx.body.sha);
  if (existing !== undefined) {
    if (expectedSha === null) {
      validationFailed(ctx, "sha wasn't supplied");
      return;
    }
    if (expectedSha !== existing.oid) {
      ctx.json(409, { message: `${path} does not match ${expectedSha}` });
      return;
    }
  }
  const blobOid = repo.putObject('blob', content);
  files.set(path, { mode: '100644', oid: blobOid });
  const tree = repo.buildTreeFromFiles(files);
  const epoch = ctx.forge.tick();
  const commit = repo.makeCommit(tree, tip === null ? [] : [tip], message, epoch);
  repo.refs.set(`refs/heads/${branch}`, commit);
  ctx.json(existing === undefined ? 201 : 200, {
    content: {
      name: path.split('/').pop()!,
      path,
      sha: blobOid,
      size: content.length,
      type: 'file',
      encoding: 'base64',
      content: content.toString('base64'),
      url: '',
      html_url: '',
    },
    commit: { sha: commit, message, url: '' },
  });
}

function contentsDelete(ctx: Ctx): void {
  const target = contentsTarget(ctx);
  if (target === null) return;
  const { repo, path, branch } = target;
  const message = asString(ctx.body.message);
  const sha = asString(ctx.body.sha);
  if (message === null || sha === null) {
    validationFailed(ctx, 'message and sha are required');
    return;
  }
  const tip = repo.branchTip(branch);
  if (tip === null) {
    notFound(ctx);
    return;
  }
  const files = repo.filesAt(branch);
  const existing = files.get(path);
  if (existing === undefined) {
    notFound(ctx);
    return;
  }
  if (existing.oid !== sha) {
    ctx.json(409, { message: `${path} does not match ${sha}` });
    return;
  }
  files.delete(path);
  const tree = repo.buildTreeFromFiles(files);
  const epoch = ctx.forge.tick();
  const commit = repo.makeCommit(tree, [tip], message, epoch);
  repo.refs.set(`refs/heads/${branch}`, commit);
  ctx.json(200, { content: null, commit: { sha: commit, message, url: '' } });
}
