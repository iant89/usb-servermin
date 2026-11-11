import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AUTHENTICATED, PUBLIC, type LogLevel } from '@servermin/sdk';
import { ROLE_PRESETS } from '../auth/auth-service';
import type { InstallSource } from '../modules/installer';
import { hostSummary } from '../system/host-info';
import { CORE_VERSION } from '../version';
import type { Platform } from '../platform';
import { registerAccountRoutes } from './account-routes';
import type { Router } from './router';
import { ApiError, asString, readToFile, requireFields, SESSION_COOKIE, type RequestContext } from './util';

export { SESSION_COOKIE };

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

  // ── Authentication, users and the audit log (shared with the Manager) ─────────
  registerAccountRoutes(router, {
    auth,
    audit,
    cookieName: SESSION_COOKIE,
    secureCookies: () => (config.auth.secureCookies === 'auto' ? !!config.http.tls : config.auth.secureCookies),
    setupToken: p.setupToken,
    onLogin: (username) => p.bus.publish('auth.login', { username }),
    sessionInfo: (authenticated) => ({ serverName: p.settings().serverName, ...(authenticated ? { coreVersion: CORE_VERSION, simulated: config.privileged.mode !== 'sudo' } : {}) }),
  });
  router.get('/api/v1/permissions', AUTHENTICATED, () => ({ permissions: modules.permissionCatalog(), presets: ROLE_PRESETS }));

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
  router.get('/api/v1/agent', AUTHENTICATED, () => p.agent.report());
  router.get('/api/v1/platform/health', 'modules.read', () => ({ ...p.health(), processes: p.processes.list() }));
  router.get('/api/v1/events', 'platform.logs.read', (ctx) => p.bus.history(ctx.query.pattern || '*', Math.min(Number(ctx.query.limit) || 100, 200)));
  router.get('/api/v1/logs', 'platform.logs.read', (ctx) =>
    logs.query({ module: ctx.query.module, source: ctx.query.source, level: (ctx.query.level as LogLevel) || undefined, search: ctx.query.search, before: Number(ctx.query.before) || undefined, limit: Number(ctx.query.limit) || 200 }),
  );
  router.get('/api/v1/notifications', AUTHENTICATED, (ctx) => notifications.list(ctx.user!.id, ctx.user!.permissions));
  router.post('/api/v1/notifications/read', AUTHENTICATED, (ctx) => {
    notifications.markAllRead(ctx.user!.id);
    return { ok: true };
  });

}
