# github-core-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/isyaweb-a11y/github-core-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/isyaweb-a11y/github-core-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge written from scratch in TypeScript with zero dependencies — Node's standard library only, and no git binary: the object model, packfiles (including delta resolution), pkt-line framing and the smart-HTTP protocol are all implemented in `gitobj.ts` and `githttp.ts`.

One in-memory store backs four surfaces, so an effect through any of them is visible through all the others:

- **REST v3** (`/api/v3`) — repositories, branches, commits, contents, git refs, labels, issues, comments, and pull requests (list, changed files, merge with real three-way semantics and conflict detection).
- **GraphQL v4** (`/api/graphql`) — a hand-written parser and executor: queries, mutations (`createIssue`, `closeIssue`, `addComment`, `createPullRequest`, `mergePullRequest`), Relay connections with cursor pagination, `search`, `node(id:)` with opaque stable global ids, batching, and introspection.
- **MCP** (`/mcp`) — streamable HTTP in both protocol eras (the modern `server/discover` handshake and legacy `initialize`), stateless, with six tools: `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.
- **Git smart HTTP** — protocol v2 `ls-refs`/`fetch` (with shallow/deepen and `shallow-info`), a v0 fetch fallback, and `receive-pack` with `report-status` over side-band-64k, fast-forward enforcement and per-ref results.

Determinism is a design rule: every timestamp the forge mints comes from a logical clock, object ids are content hashes, and record ids are sequential — so a trial's answers replay byte for byte.

## Run it

```sh
# The harness sets MAKEFUN_ENV_URL (the env to register with) and MAKEFUN_SHOP_TOKEN
# (the bearer <redacted> every API call must carry); then:
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=sc1d8ke0&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
