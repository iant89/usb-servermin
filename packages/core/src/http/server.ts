import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { AUTHENTICATED, PUBLIC, hasPermission, type ModuleRequest } from '@servermin/sdk';
import { AuthError } from '../auth/auth-service';
import { TokenBucket } from '../auth/rate-limit';
import { InstallError } from '../modules/installer';
import { ModuleError } from '../modules/module-manager';
import { RpcError } from '../modules/rpc';
import { ProcessError } from '../process/process-service';
import type { Platform } from '../platform';
import { UpdateError } from '../updates/update-service';
import { SESSION_COOKIE, registerCoreRoutes } from './api';
import { Router } from './router';
import { ApiError, clientIp, newRequestId, parseCookies, readJson, sendJson, sendRaw, type RequestContext } from './util';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const STRIPPED_HEADERS = new Set(['cookie', 'authorization', 'x-servermin-request']);

function securityHeaders(res: ServerResponse, dev: boolean) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'content-security-policy',
    `default-src 'self'; script-src 'self'${dev ? " 'unsafe-inline' 'unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`,
  );
}

/** Maps any thrown error to an HTTP status and safe message. */
export function errorStatus(e: unknown): { status: number; body: Record<string, unknown> } {
  if (e instanceof ApiError) return { status: e.status, body: { error: e.message, details: e.details } };
  if (e instanceof AuthError) return { status: e.status, body: { error: e.message } };
  if (e instanceof ModuleError) return { status: e.status, body: { error: e.message, problems: e.problems } };
  if (e instanceof InstallError) return { status: e.status, body: { error: e.message, problems: e.problems } };
  if (e instanceof ProcessError) return { status: e.status, body: { error: e.message } };
  if (e instanceof UpdateError) return { status: e.status, body: { error: e.message } };
  if (e instanceof RpcError) return { status: e.status ?? 502, body: { error: e.message, details: e.details } };
  return { status: 500, body: { error: 'Internal server error' } };
}

export class HttpServer {
  readonly router = new Router();
  readonly server: Server;
  private readonly bucket = new TokenBucket(300, 30);
  private log;

  constructor(private readonly p: Platform) {
    this.log = p.logs.logger('http');
    registerCoreRoutes(this.router, p);
    const tls = p.config.http.tls;
    const handler = (req: IncomingMessage, res: ServerResponse) => void this.handle(req, res);
    this.server = tls ? createHttpsServer({ cert: readFileSync(tls.cert), key: readFileSync(tls.key) }, handler) : createHttpServer(handler);
    this.server.headersTimeout = 30_000;
    this.server.requestTimeout = 0; // uploads and long module operations; module routes have their own timeouts
    this.server.keepAliveTimeout = 10_000;
  }

  listen(): Promise<{ port: number; host: string }> {
    return new Promise((resolvePromise, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.p.config.http.port, this.p.config.http.host, () => {
        const addr = this.server.address();
        resolvePromise({ port: typeof addr === 'object' && addr ? addr.port : this.p.config.http.port, host: this.p.config.http.host });
      });
    });
  }

  close(): Promise<void> {
    return new Promise((r) => {
      this.server.closeAllConnections?.();
      this.server.close(() => r());
    });
  }

  /** Resolve the user from a bearer token or the session cookie. */
  authenticate(req: IncomingMessage, ctx: Pick<RequestContext, 'user' | 'requestUser' | 'sessionToken' | 'authKind'>) {
    const authz = req.headers.authorization;
    if (authz?.startsWith('Bearer ')) {
      const user = this.p.auth.authenticateToken(authz.slice(7).trim());
      if (!user) throw new ApiError(401, 'Invalid or expired API token');
      ctx.user = user;
      ctx.authKind = 'token';
    } else {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (token) {
        const s = this.p.auth.authenticateSession(token);
        if (s) {
          ctx.user = s.user;
          ctx.sessionToken = token;
          ctx.authKind = 'session';
        }
      }
    }
    if (ctx.user) ctx.requestUser = this.p.auth.toRequestUser(ctx.user);
  }

  /** Same-origin check for browsers (CSRF defence together with SameSite=Strict and the custom header). */
  sameOrigin(req: IncomingMessage) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://local');
    const method = (req.method ?? 'GET').toUpperCase();
    const ctx: RequestContext = {
      req,
      res,
      url,
      method,
      path: url.pathname,
      params: {},
      query: Object.fromEntries(url.searchParams),
      ip: clientIp(req, this.p.config.http.trustProxy),
      requestId: newRequestId(),
    };
    securityHeaders(res, this.p.config.dev);
    res.setHeader('x-request-id', ctx.requestId);
    try {
      if (ctx.path.includes('\0') || ctx.path.split('/').includes('..')) throw new ApiError(400, 'Invalid path');
      if (ctx.path.startsWith('/api/')) await this.handleApi(ctx);
      else if (/^\/modules\/[a-z][a-z0-9-]{1,47}\/assets\//.test(ctx.path)) await this.handleModuleAsset(ctx);
      else await this.handleStatic(ctx);
    } catch (e) {
      const { status, body } = errorStatus(e);
      if (status >= 500) this.log.error(`${method} ${ctx.path} failed: ${(e as Error)?.message}`, { requestId: ctx.requestId, stack: (e as Error)?.stack });
      if (ctx.path.startsWith('/api/') || res.headersSent) sendJson(res, status, { ...body, requestId: ctx.requestId });
      else sendRaw(res, status, String(body.error ?? 'Error'), { 'content-type': 'text/plain; charset=utf-8' });
    } finally {
      const ms = Date.now() - started;
      if (ms > 2000) this.log.warn(`Slow request ${method} ${ctx.path} (${ms} ms)`, { requestId: ctx.requestId });
    }
  }

  private async handleApi(ctx: RequestContext) {
    if (!this.bucket.take(ctx.ip)) throw new ApiError(429, 'Too many requests');
    this.authenticate(ctx.req, ctx);
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(ctx.method);
    if (unsafe && ctx.authKind !== 'token') {
      if (!this.sameOrigin(ctx.req)) throw new ApiError(403, 'Cross-origin request rejected');
      if (ctx.req.headers['x-servermin-request'] !== '1') throw new ApiError(403, 'Missing X-Servermin-Request header');
    }

    const hit = this.router.match(ctx.method, ctx.path);
    if (hit && 'route' in hit) {
      const { route, params } = hit;
      ctx.params = params;
      this.authorize(ctx, route.permission);
      if (!route.rawBody) ctx.body = await readJson(ctx.req);
      const out = (await route.handler(ctx)) as any;
      if (out && typeof out === 'object' && '__raw' in out) {
        return sendRaw(ctx.res, 200, out.__raw, { 'content-type': out.contentType, 'content-disposition': `attachment; filename="${out.filename}"` });
      }
      return sendJson(ctx.res, out === undefined ? 204 : 200, out);
    }

    const m = /^\/api\/v1\/modules\/([a-z][a-z0-9-]{1,47})(\/.*)?$/.exec(ctx.path);
    if (m) return this.handleModuleApi(ctx, m[1], m[2] || '/');
    if (hit && 'methodNotAllowed' in hit) throw new ApiError(405, 'Method not allowed');
    throw new ApiError(404, 'Not found');
  }

  private authorize(ctx: RequestContext, permission: string) {
    if (permission === PUBLIC) return;
    if (!ctx.user) throw new ApiError(401, 'Sign in required');
    if (permission !== AUTHENTICATED && !hasPermission(ctx.user.permissions, permission)) throw new ApiError(403, `Permission "${permission}" required`, { permission, reason: 'permission-denied' });
  }

  /** Dispatch to a module-registered route (§15, §27). */
  private async handleModuleApi(ctx: RequestContext, id: string, subPath: string) {
    if (!ctx.user) throw new ApiError(401, 'Sign in required');
    const managed = this.p.modules.get(id);
    if (!managed) throw new ApiError(404, `Module ${id} is not installed`, { reason: 'module-missing' });
    if (managed.state !== 'ACTIVE' || !managed.instance) {
      const reason = !managed.enabled ? 'module-disabled' : managed.state === 'BLOCKED' ? 'dependency-unavailable' : managed.state === 'ERROR' ? 'module-error' : 'module-unavailable';
      throw new ApiError(503, `Module ${managed.manifest.name} is ${managed.state.toLowerCase()}`, { reason, state: managed.state, error: managed.error, blockedBy: managed.blockedBy });
    }
    const { match, pathExists } = managed.instance.match(ctx.method === 'HEAD' ? 'GET' : ctx.method, subPath);
    if (!match) throw new ApiError(pathExists ? 405 : 404, pathExists ? 'Method not allowed' : 'Not found');
    this.authorize(ctx, match.route.permission);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(ctx.req.headers)) if (!STRIPPED_HEADERS.has(k) && typeof v === 'string') headers[k] = v;
    const request: ModuleRequest = {
      method: ctx.method,
      path: subPath,
      params: match.params,
      query: ctx.query,
      body: await readJson(ctx.req, 5 * 1024 * 1024),
      headers,
      user: ctx.requestUser!,
      requestId: ctx.requestId,
      remoteAddress: ctx.ip.replace(/^::ffff:/, ''),
      host: String(ctx.req.headers.host ?? ''),
    };
    const out = await managed.instance.handleRequest(match.route, request);
    if (match.route.audit)
      this.p.audit.record({
        user: ctx.user.username,
        action: match.route.audit,
        module: id,
        target: Object.values(match.params).join('/') || subPath,
        result: out.status < 400 ? 'success' : 'failure',
        ip: ctx.ip,
        metadata: out.status >= 400 ? { status: out.status, error: (out.body as any)?.error } : undefined,
      });
    const safeHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(out.headers ?? {})) if (/^(content-type|content-disposition|cache-control|x-[a-z-]+)$/i.test(k)) safeHeaders[k.toLowerCase()] = String(v);
    if (out.raw) return sendRaw(ctx.res, out.status, String(out.body ?? ''), { 'content-type': 'text/plain; charset=utf-8', ...safeHeaders });
    return sendJson(ctx.res, out.status, out.body, safeHeaders);
  }

  /** Module frontend bundles: `/modules/<id>/assets/<file>`, limited to the frontend's directory. */
  private async handleModuleAsset(ctx: RequestContext) {
    const m = /^\/modules\/([a-z][a-z0-9-]{1,47})\/assets\/(.+)$/.exec(ctx.path);
    if (!m || ctx.method !== 'GET') throw new ApiError(404, 'Not found');
    this.authenticate(ctx.req, ctx);
    if (!ctx.user) throw new ApiError(401, 'Sign in required');
    const managed = this.p.modules.get(m[1]);
    if (!managed?.manifest.frontend) throw new ApiError(404, 'Not found');
    const allowedRoot = resolve(managed.dir, managed.manifest.frontend.entry, '..');
    const file = resolve(managed.dir, normalize(decodeURIComponent(m[2])));
    if (!file.startsWith(allowedRoot + sep)) throw new ApiError(404, 'Not found');
    await this.sendFile(ctx, file, 'no-cache');
  }

  private async sendFile(ctx: RequestContext, file: string, cache: string) {
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) throw new ApiError(404, 'Not found');
    ctx.res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'content-length': st.size, 'cache-control': cache });
    if (ctx.method === 'HEAD') return ctx.res.end();
    await new Promise<void>((r, j) => createReadStream(file).on('error', j).on('end', r).pipe(ctx.res));
  }

  /** The React shell, with SPA fallback to index.html. */
  private async handleStatic(ctx: RequestContext) {
    if (!['GET', 'HEAD'].includes(ctx.method)) throw new ApiError(405, 'Method not allowed');
    const root = this.p.config.paths.shell;
    const index = join(root, 'index.html');
    if (!existsSync(index)) {
      return sendRaw(ctx.res, 503, 'The web interface is not built. Run `npm run build` (or use `npm run dev`).', { 'content-type': 'text/plain; charset=utf-8' });
    }
    const file = resolve(root, '.' + normalize(decodeURIComponent(ctx.path)));
    if (file.startsWith(resolve(root) + sep) && extname(file) && existsSync(file)) {
      return this.sendFile(ctx, file, file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
    }
    if (extname(ctx.path) && ctx.path.startsWith('/assets/')) throw new ApiError(404, 'Not found');
    return this.sendFile(ctx, index, 'no-cache');
  }
}
