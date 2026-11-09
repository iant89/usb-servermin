import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AUTHENTICATED, PUBLIC, isValidPermission, type LogLevel } from '@servermin/sdk';
import { ROLE_PRESETS } from '../auth/auth-service';
import type { InstallSource } from '../modules/installer';
import { hostSummary } from '../system/host-info';
import { CORE_VERSION } from '../version';
import type { Platform } from '../platform';
import type { Router } from './router';
import { ApiError, asString, readToFile, requireFields, type RequestContext } from './util';

export const SESSION_COOKIE = 'sm_session';

function actor(ctx: RequestContext) {
  return ctx.user?.username;
}

function parseSource(body: any): InstallSource {
  const b = requireFields<{ source: string }>(body, ['source']);
  switch (b.source) {
    case 'directory':
      return { type: 'directory', path: asString(body.path, 'path', 1000) };
    case 'git':
      return { type: 'git', url: asString(body.url, 'url', 1000), ref: body.ref ? asString(body.ref, 'ref', 100) : undefined };
    case 'archive':
      return { type: 'archive', path: asString(body.path, 'path', 1000), sha256: body.sha256 ? asString(body.sha256, 'sha256', 64) : undefined };
    case 'link':
      return { type: 'link', path: asString(body.path, 'path', 1000) };
    default:
      throw new ApiError(400, 'source must be directory, archive, git or link');
  }
}

export interface PlatformSettings {
  serverName: string;
  logLevel: LogLevel;
}

export function registerCoreRoutes(router: Router, p: Platform) {
  const { auth, modules, audit, logs, notifications, config } = p;

  // ── Health (public, minimal) ───────────────────────────────────────────────────
  router.get('/api/v1/health', PUBLIC, () => ({ status: p.health().status, version: CORE_VERSION }));

  // ── Authentication ─────────────────────────────────────────────────────────────
  router.get('/api/v1/auth/session', PUBLIC, (ctx) => {
    const needsSetup = auth.userCount() === 0;
    if (!ctx.user) return { authenticated: false, needsSetup, serverName: p.settings().serverName };
    return {
      authenticated: true,
      needsSetup,
      serverName: p.settings().serverName,
      user: { id: ctx.user.id, username: ctx.user.username, displayName: ctx.user.displayName, permissions: ctx.user.permissions },
      coreVersion: CORE_VERSION,
      simulated: config.privileged.mode !== 'sudo',
    };
  });

  router.post('/api/v1/auth/setup', PUBLIC, async (ctx) => {
    if (auth.userCount() > 0) throw new ApiError(409, 'Setup is already complete');
    const b = requireFields<{ setupToken: string; username: string; password: string; displayName?: string }>(ctx.body, ['setupToken', 'username', 'password']);
    if (!p.checkSetupToken(String(b.setupToken))) {
      audit.record({ action: 'auth.setup', result: 'failure', ip: ctx.ip, metadata: { reason: 'invalid setup token' } });
      throw new ApiError(403, 'The setup token is incorrect. It is in the setup-token file in the data directory.');
    }
    const user = await auth.createUser({ username: String(b.username), displayName: b.displayName, password: String(b.password), permissions: ['*'] });
    p.consumeSetupToken();
    audit.record({ user: user.username, action: 'auth.setup', result: 'success', ip: ctx.ip });
    return loginResponse(ctx, await auth.login(user.username, String(b.password), ctx.ip, ctx.req.headers['user-agent']));
  });

  const loginResponse = (ctx: RequestContext, r: Awaited<ReturnType<typeof auth.login>>) => {
    const secure = config.auth.secureCookies === 'auto' ? !!config.http.tls : config.auth.secureCookies;
    ctx.res.setHeader('set-cookie', `${SESSION_COOKIE}=${r.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 86400}${secure ? '; Secure' : ''}`);
    p.bus.publish('auth.login', { username: r.user.username });
    return { user: { id: r.user.id, username: r.user.username, displayName: r.user.displayName, permissions: r.user.permissions } };
  };

  router.post('/api/v1/auth/login', PUBLIC, async (ctx) => {
    const b = requireFields<{ username: string; password: string }>(ctx.body, ['username', 'password']);
    const username = asString(b.username, 'username', 64);
    try {
      const r = await auth.login(username, asString(b.password, 'password', 256), ctx.ip, ctx.req.headers['user-agent']);
      audit.record({ user: r.user.username, action: 'auth.login', result: 'success', ip: ctx.ip });
      return loginResponse(ctx, r);
    } catch (e) {
      audit.record({ user: username, action: 'auth.login', result: 'failure', ip: ctx.ip, metadata: { reason: (e as Error).message } });
      throw e;
    }
  });

  router.post('/api/v1/auth/logout', AUTHENTICATED, (ctx) => {
    if (ctx.sessionToken) auth.logout(ctx.sessionToken);
    ctx.res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    audit.record({ user: actor(ctx), action: 'auth.logout', result: 'success', ip: ctx.ip });
    return { ok: true };
  });

  router.post('/api/v1/auth/password', AUTHENTICATED, async (ctx) => {
    const b = requireFields<{ currentPassword: string; newPassword: string }>(ctx.body, ['currentPassword', 'newPassword']);
    await auth.changePassword(ctx.user!.id, String(b.currentPassword), String(b.newPassword));
    audit.record({ user: actor(ctx), action: 'auth.password.change', result: 'success', ip: ctx.ip });
    return { ok: true, message: 'Password changed. Sign in again on other devices.' };
  });

  router.get('/api/v1/auth/tokens', AUTHENTICATED, (ctx) => auth.listTokens(ctx.user!.id));
  router.post('/api/v1/auth/tokens', AUTHENTICATED, (ctx) => {
    const b = requireFields<{ name: string; expiresInDays?: number }>(ctx.body, ['name']);
    const days = b.expiresInDays === undefined ? undefined : Number(b.expiresInDays);
    if (days !== undefined && (!Number.isFinite(days) || days < 1 || days > 3650)) throw new ApiError(400, 'expiresInDays must be 1-3650');
    const t = auth.createToken(ctx.user!.id, asString(b.name, 'name', 80), days);
    audit.record({ user: actor(ctx), action: 'auth.token.create', target: t.prefix, result: 'success', ip: ctx.ip });
    return t;
  });
  router.delete('/api/v1/auth/tokens/:id', AUTHENTICATED, (ctx) => {
    if (!auth.revokeToken(ctx.user!.id, Number(ctx.params.id))) throw new ApiError(404, 'Token not found');
    audit.record({ user: actor(ctx), action: 'auth.token.revoke', target: ctx.params.id, result: 'success', ip: ctx.ip });
    return { ok: true };
  });

  // ── Users and permissions ──────────────────────────────────────────────────────
  router.get('/api/v1/permissions', AUTHENTICATED, () => ({ permissions: modules.permissionCatalog(), presets: ROLE_PRESETS }));

  const checkPermissions = (list: unknown) => {
    if (!Array.isArray(list)) throw new ApiError(400, 'permissions must be an array');
    for (const x of list) if (typeof x !== 'string' || !(x === '*' || isValidPermission(x) || /^[a-z][a-z0-9-]*\.\*$/.test(x))) throw new ApiError(400, `Invalid permission "${x}"`);
    return list as string[];
  };

  router.get('/api/v1/users', 'users.manage', () => auth.listUsers());
  router.post('/api/v1/users', 'users.manage', async (ctx) => {
    const b = requireFields<{ username: string; password: string; permissions: string[]; displayName?: string }>(ctx.body, ['username', 'password', 'permissions']);
    const user = await auth.createUser({ username: String(b.username), password: String(b.password), displayName: b.displayName, permissions: checkPermissions(b.permissions) });
    audit.record({ user: actor(ctx), action: 'user.create', target: user.username, result: 'success', ip: ctx.ip, metadata: { permissions: user.permissions } });
    return user;
  });
  router.patch('/api/v1/users/:id', 'users.manage', async (ctx) => {
    const b = (ctx.body ?? {}) as { displayName?: string; permissions?: string[]; disabled?: boolean; password?: string };
    const id = Number(ctx.params.id);
    if (id === ctx.user!.id && (b.disabled || (b.permissions && !b.permissions.includes('*') && ctx.user!.permissions.includes('*'))))
      throw new ApiError(409, 'You cannot disable yourself or remove your own administrator rights');
    const user = await auth.updateUser(id, { displayName: b.displayName, permissions: b.permissions ? checkPermissions(b.permissions) : undefined, disabled: b.disabled, password: b.password });
    audit.record({ user: actor(ctx), action: 'user.update', target: user.username, result: 'success', ip: ctx.ip, metadata: { fields: Object.keys(b).filter((k) => k !== 'password'), passwordReset: !!b.password } });
    return user;
  });
  router.delete('/api/v1/users/:id', 'users.manage', (ctx) => {
    const id = Number(ctx.params.id);
    if (id === ctx.user!.id) throw new ApiError(409, 'You cannot delete your own account');
    const target = auth.getUser(id);
    auth.deleteUser(id);
    audit.record({ user: actor(ctx), action: 'user.delete', target: target?.username, result: 'success', ip: ctx.ip });
    return { ok: true };
  });

  // ── Modules (§33) ──────────────────────────────────────────────────────────────
  const listModules = () => modules.list();
  router.get('/api/v1/modules', 'modules.read', listModules);
  router.get('/api/v1/platform/modules', 'modules.read', listModules);
  router.get('/api/v1/platform/frontend', AUTHENTICATED, () => modules.frontendManifest());
  router.get('/api/v1/platform/modules/discover', 'modules.read', async () => {
    const found = await modules.installer.discover(config.modules.sources);
    return found.map((f) => {
      const installed = f.manifest ? modules.get(f.manifest.id) : undefined;
      return {
        path: f.path,
        id: f.manifest?.id,
        name: f.manifest?.name,
        version: f.manifest?.version,
        description: f.manifest?.description,
        errors: f.errors,
        state: f.errors.length ? 'INVALID' : 'DISCOVERED',
        installedVersion: installed?.manifest.version ?? null,
      };
    });
  });

  router.post('/api/v1/platform/modules', 'modules.install', async (ctx) => modules.install(parseSource(ctx.body), actor(ctx)));

  /** Upload a packaged module (.tgz). Body: application/octet-stream; `?sha256=` optional. */
  const upload = async (ctx: RequestContext) => {
    await mkdir(config.paths.tmp, { recursive: true });
    const file = join(config.paths.tmp, `upload-${randomUUID()}.tgz`);
    try {
      await readToFile(ctx.req, file, 200 * 1024 * 1024);
      const source: InstallSource = { type: 'archive', path: file, sha256: ctx.query.sha256 || undefined };
      return ctx.params.id ? await modules.update(ctx.params.id, source, actor(ctx)) : await modules.install(source, actor(ctx));
    } finally {
      await rm(file, { force: true });
    }
  };
  router.post('/api/v1/platform/modules/upload', 'modules.install', upload, { rawBody: true });
  router.post('/api/v1/platform/modules/:id/upload', 'modules.install', upload, { rawBody: true });

  router.get('/api/v1/platform/modules/:id', 'modules.read', (ctx) => {
    const m = modules.get(ctx.params.id);
    if (!m) throw new ApiError(404, 'Module not installed');
    return modules.summary(m);
  });
  router.delete('/api/v1/platform/modules/:id', 'modules.remove', (ctx) => modules.remove(ctx.params.id, { deleteData: ctx.query.deleteData === 'true' }, actor(ctx)));
  router.post('/api/v1/platform/modules/:id/enable', 'modules.configure', (ctx) => modules.enable(ctx.params.id, actor(ctx)));
  router.post('/api/v1/platform/modules/:id/disable', 'modules.configure', (ctx) => modules.disable(ctx.params.id, actor(ctx)));
  router.post('/api/v1/platform/modules/:id/reload', 'modules.configure', (ctx) => modules.reload(ctx.params.id, actor(ctx)));
  router.post('/api/v1/platform/modules/:id/restart', 'modules.configure', (ctx) => modules.restart(ctx.params.id, actor(ctx)));
  router.post('/api/v1/platform/modules/:id/update', 'modules.install', (ctx) => modules.update(ctx.params.id, parseSource(ctx.body), actor(ctx)));
  router.get('/api/v1/platform/modules/:id/config', 'modules.read', (ctx) => modules.configFor(ctx.params.id));
  router.put('/api/v1/platform/modules/:id/config', 'modules.configure', (ctx) => modules.setConfig(ctx.params.id, (ctx.body ?? {}) as Record<string, unknown>, actor(ctx)));
  router.get('/api/v1/platform/modules/:id/logs', 'modules.read', async (ctx) =>
    logs.query({ module: ctx.params.id, level: (ctx.query.level as LogLevel) || undefined, search: ctx.query.search, before: Number(ctx.query.before) || undefined, limit: Number(ctx.query.limit) || 200 }),
  );

  // ── Platform configuration (§24) ───────────────────────────────────────────────
  router.get('/api/v1/config', AUTHENTICATED, () => ({
    settings: p.settings(),
    readOnly: {
      version: CORE_VERSION,
      http: { host: config.http.host, port: config.http.port, tls: !!config.http.tls },
      paths: config.paths,
      privilegedMode: config.privileged.mode,
      dev: config.dev,
      watch: config.modules.watch,
    },
  }));
  router.patch('/api/v1/config', 'platform.config', (ctx) => {
    const b = (ctx.body ?? {}) as Partial<PlatformSettings>;
    const next = p.updateSettings(b);
    audit.record({ user: actor(ctx), action: 'platform.configure', result: 'success', ip: ctx.ip, metadata: { keys: Object.keys(b) } });
    return next;
  });

  // ── Updates from signed releases ───────────────────────────────────────────────
  router.get('/api/v1/updates', 'platform.update', () => p.updates.state());
  router.post('/api/v1/updates/check', 'platform.update', (ctx) => p.updates.check(actor(ctx)));
  router.post('/api/v1/updates/apply', 'platform.update', (ctx) => p.updates.apply(actor(ctx)));
  router.post('/api/v1/updates/rollback', 'platform.update', (ctx) => p.updates.rollback(actor(ctx)));
  router.post('/api/v1/updates/modules/:id', 'platform.update', (ctx) => p.updates.updateModule(ctx.params.id, actor(ctx)));
  router.put('/api/v1/updates/settings', 'platform.update', (ctx) => p.updates.updateSettings((ctx.body ?? {}) as Record<string, never>, actor(ctx)));

  // ── Observability ──────────────────────────────────────────────────────────────
  router.get('/api/v1/system', AUTHENTICATED, async () => ({ ...(await hostSummary(config.paths.data)), health: p.health(), coreVersion: CORE_VERSION }));
  router.get('/api/v1/platform/health', 'modules.read', () => ({ ...p.health(), processes: p.processes.list() }));
  router.get('/api/v1/events', 'platform.logs.read', (ctx) => p.bus.history(ctx.query.pattern || '*', Math.min(Number(ctx.query.limit) || 100, 200)));
  router.get('/api/v1/logs', 'platform.logs.read', (ctx) =>
    logs.query({ module: ctx.query.module, source: ctx.query.source, level: (ctx.query.level as LogLevel) || undefined, search: ctx.query.search, before: Number(ctx.query.before) || undefined, limit: Number(ctx.query.limit) || 200 }),
  );
  router.get('/api/v1/audit', 'audit.read', (ctx) => {
    const rows = audit.query({ user: ctx.query.user, action: ctx.query.action, module: ctx.query.module, result: ctx.query.result, search: ctx.query.search, before: Number(ctx.query.before) || undefined, limit: Number(ctx.query.limit) || 200 });
    if (ctx.query.format === 'csv') {
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = ['timestamp,user,action,module,target,result,ip,metadata', ...rows.map((r) => [r.timestamp, r.user, r.action, r.module, r.target, r.result, r.ip, JSON.stringify(r.metadata ?? {})].map(esc).join(','))].join('\n');
      return { __raw: csv, contentType: 'text/csv; charset=utf-8', filename: 'audit-log.csv' };
    }
    return rows;
  });
  router.get('/api/v1/notifications', AUTHENTICATED, (ctx) => notifications.list(ctx.user!.id, ctx.user!.permissions));
  router.post('/api/v1/notifications/read', AUTHENTICATED, (ctx) => {
    notifications.markAllRead(ctx.user!.id);
    return { ok: true };
  });

}
