// HTTP wiring for the forge: one server, one shared store, four surfaces.
//   GET  /healthz                       liveness, no auth
//   *    /api/v3/...                    REST v3 (rest.ts), bearer auth
//   POST /api/graphql                   GraphQL v4 (graphql.ts), bearer auth
//   POST /mcp                           MCP streamable HTTP (mcp.ts)
//   *    /{owner}/{repo}.git/...        git smart HTTP (githttp.ts)
// Auth rule from the spec: every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`;
// a missing or wrong token is a 401, and anything unknown is a JSON 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMCP } from './mcp.ts';
import { REST_ROUTES, type Ctx } from './rest.ts';
import { Forge } from './store.ts';

const MAX_BODY_BYTES = 256 * 1024 * 1024;

export function createApp(env: NodeJS.ProcessEnv = process.env): Server {
  const forge = new Forge();
  const expectedToken = env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error('forge: request failed', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      }
      res.end('{"message":"Internal Server Error"}\n');
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    requestCounter += 1;
    const requestId = `forge-${requestCounter.toString(36)}-${Date.now().toString(36)}`;
    const send = (status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void => {
      res.writeHead(status, {
        'content-type': contentType,
        'x-github-request-id': requestId,
        'cache-control': 'no-cache',
        ...extra,
      });
      res.end(body);
    };
    const sendJson = (status: number, value: unknown, extra: Record<string, string> = {}): void => {
      send(status, Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'), 'application/json; charset=utf-8', extra);
    };

    const url = new URL(req.url ?? '/', 'http://forge.internal');
    const pathname = url.pathname;
    const method = req.method ?? 'GET';
    const authorization = req.headers.authorization ?? '';
    const authed = expectedToken !== '' && authorization === `Bearer ${expectedToken}`;

    // ------------------------------------------------------------ health
    if (pathname === '/healthz' && method === 'GET') {
      sendJson(200, { ok: true });
      return;
    }

    // ------------------------------------------------------------ git smart HTTP
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
    if (gitMatch !== null) {
      const owner = decodeURIComponent(gitMatch[1]!);
      const repoName = decodeURIComponent(gitMatch[2]!);
      const repo = forge.getRepo(owner, repoName);
      const endpoint = gitMatch[3]!;
      if (endpoint === 'info/refs' && method === 'GET') {
        handleInfoRefs(req, send, repo, url.searchParams.get('service') ?? '');
        return;
      }
      if (endpoint === 'git-upload-pack' && method === 'POST') {
        const body = await readBody(req);
        const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
        await handleUploadPack(send, repo, body, isV2);
        return;
      }
      if (endpoint === 'git-receive-pack' && method === 'POST') {
        const body = await readBody(req);
        await handleReceivePack(send, repo, body);
        return;
      }
      sendJson(404, { message: 'Not Found' });
      return;
    }

    // ------------------------------------------------------------ GraphQL
    if (pathname === '/api/graphql') {
      if (method !== 'POST') {
        sendJson(404, { message: 'Not Found' });
        return;
      }
      if (!authed) {
        sendJson(401, { message: 'Bad credentials' });
        return;
      }
      const body = await readBody(req);
      const { status, payload } = handleGraphQL(forge, body.toString('utf8'));
      sendJson(status, payload);
      return;
    }

    // ------------------------------------------------------------ MCP
    if (pathname === '/mcp') {
      if (method !== 'POST') {
        sendJson(404, { message: 'Not Found' });
        return;
      }
      const body = await readBody(req);
      const outcome = handleMCP(forge, authed, body.toString('utf8'));
      if (outcome.payload === undefined) {
        res.writeHead(outcome.status, { 'x-github-request-id': requestId });
        res.end();
        return;
      }
      sendJson(outcome.status, outcome.payload);
      return;
    }

    // ------------------------------------------------------------ REST v3
    if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
      if (!authed) {
        sendJson(401, { message: 'Bad credentials' });
        return;
      }
      const segments = pathname
        .slice('/api/v3'.length)
        .split('/')
        .filter((segment) => segment !== '')
        .map((segment) => decodeURIComponent(segment));
      let rawBody = Buffer.alloc(0);
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        rawBody = await readBody(req);
      }
      let body: Record<string, unknown> = {};
      if (rawBody.length > 0) {
        try {
          const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
          body = parsed as Record<string, unknown>;
        } catch {
          sendJson(400, { message: 'Problems parsing JSON' });
          return;
        }
      }
      const matched = matchRoute(method, segments);
      if (matched === null) {
        sendJson(404, { message: 'Not Found' });
        return;
      }
      const host = req.headers.host ?? 'forge.internal';
      const ctx: Ctx = {
        forge,
        params: matched.params,
        query: url.searchParams,
        body,
        origin: `http://${host}`,
        json: (status, value, headers) =>
          sendJson(status, value, { 'x-oauth-scopes': 'repo, read:org', ...headers }),
        noContent: () => {
          res.writeHead(204, { 'x-github-request-id': requestId });
          res.end();
        },
      };
      matched.handler(ctx);
      return;
    }

    // ------------------------------------------------------------ everything else
    sendJson(404, { message: 'Not Found' });
  }

  return server;
}

function matchRoute(
  method: string,
  segments: string[],
): { handler: (ctx: Ctx) => void; params: Record<string, string> } | null {
  for (const routeDef of REST_ROUTES) {
    if (routeDef.method !== method) continue;
    const params: Record<string, string> = {};
    let ok = true;
    let index = 0;
    for (const part of routeDef.pattern) {
      if (part.startsWith(':') && part.endsWith('*')) {
        params[part.slice(1, -1)] = segments.slice(index).join('/');
        index = segments.length;
        break;
      }
      if (index >= segments.length) {
        ok = false;
        break;
      }
      if (part.startsWith(':')) {
        params[part.slice(1)] = segments[index]!;
      } else if (part !== segments[index]) {
        ok = false;
        break;
      }
      index += 1;
    }
    if (ok && index === segments.length) return { handler: routeDef.handler, params };
  }
  return null;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
