import { AUTHENTICATED, PUBLIC } from '@servermin/sdk';
import { CORE_VERSION, registerAccountRoutes, type RequestContext, type Router } from '@servermin/core';
import type { Manager } from './manager';

/** Session cookie of the Manager. Different from the agent's, because cookies ignore the port. */
export const MANAGER_SESSION_COOKIE = 'smm_session';

/** Permissions the Manager itself checks. */
export const MANAGER_PERMISSIONS = {
  'servers.read': 'View the server inventory',
  'servers.manage': 'Add, edit and remove servers',
  'users.manage': 'Create, edit and delete Manager users',
  'audit.read': 'Read the Manager audit log',
} as const;

export const MANAGER_ROLE_PRESETS: Record<string, { label: string; permissions: string[] }> = {
  administrator: { label: 'Administrator', permissions: ['*'] },
  operator: { label: 'Operator', permissions: ['servers.read', 'servers.manage'] },
  viewer: { label: 'Viewer', permissions: ['servers.read'] },
};

const actor = (ctx: RequestContext) => ctx.user?.username;

export function registerManagerRoutes(router: Router, m: Manager) {
  const { auth, audit, inventory, config } = m;

  // Public and minimal. `service` lets a client tell a Manager from an agent's local interface.
  router.get('/api/v1/health', PUBLIC, () => ({ status: m.health().status, version: CORE_VERSION, service: 'manager' }));

  registerAccountRoutes(router, {
    auth,
    audit,
    cookieName: MANAGER_SESSION_COOKIE,
    secureCookies: () => (config.auth.secureCookies === 'auto' ? !!config.http.tls : config.auth.secureCookies),
    setupToken: m.setupToken,
    onLogin: (username) => m.bus.publish('auth.login', { username }, 'manager'),
    sessionInfo: (authenticated) => ({ service: 'manager', ...(authenticated ? { managerVersion: CORE_VERSION } : {}) }),
  });

  router.get('/api/v1/permissions', AUTHENTICATED, () => ({
    permissions: Object.entries(MANAGER_PERMISSIONS).map(([id, description]) => ({ id, description, module: null })),
    presets: MANAGER_ROLE_PRESETS,
  }));

  router.get('/api/v1/manager', AUTHENTICATED, () => ({ version: CORE_VERSION, ...m.health(), servers: inventory.count() }));

  // ── Server inventory ───────────────────────────────────────────────────────────
  router.get('/api/v1/servers', 'servers.read', () => inventory.list());
  router.get('/api/v1/servers/:id', 'servers.read', (ctx) => inventory.require(ctx.params.id));

  /** Runs an inventory change and records it, whether it succeeded or was refused. */
  const audited = <T extends { id: string; name: string }>(ctx: RequestContext, action: string, target: string | undefined, fn: () => T): T => {
    try {
      const server = fn();
      audit.record({ user: actor(ctx), action, target: server.id, result: 'success', ip: ctx.ip, metadata: { name: server.name } });
      return server;
    } catch (e) {
      audit.record({ user: actor(ctx), action, target, result: 'failure', ip: ctx.ip, metadata: { reason: (e as Error).message } });
      throw e;
    }
  };
  const body = (ctx: RequestContext) => (ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? (ctx.body as Record<string, unknown>) : {});

  router.post('/api/v1/servers', 'servers.manage', (ctx) => {
    const b = body(ctx);
    return audited(ctx, 'server.create', typeof b.id === 'string' ? b.id.slice(0, 64) : undefined, () => inventory.create({ name: b.name, hostname: b.hostname, description: b.description, id: b.id }));
  });
  router.patch('/api/v1/servers/:id', 'servers.manage', (ctx) => {
    const b = body(ctx);
    return audited(ctx, 'server.update', ctx.params.id.slice(0, 64), () => inventory.update(ctx.params.id, { name: b.name, hostname: b.hostname, description: b.description }));
  });
  router.delete('/api/v1/servers/:id', 'servers.manage', (ctx) => {
    audited(ctx, 'server.remove', ctx.params.id.slice(0, 64), () => inventory.remove(ctx.params.id));
    return { ok: true };
  });
}
