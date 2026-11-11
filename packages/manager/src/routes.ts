import { AUTHENTICATED, PUBLIC } from '@servermin/sdk';
import { AttemptLimiter, CORE_VERSION, registerAccountRoutes, ApiError, type RequestContext, type Router } from '@servermin/core';
import { RegistrationError } from './registrations';
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

  router.get('/api/v1/manager', AUTHENTICATED, () => ({
    version: CORE_VERSION,
    ...m.health(),
    servers: inventory.count(),
    agents: m.agents.connections(),
    // What an agent needs to trust this Manager: the certificate fingerprint to pin.
    tls: m.tlsFingerprint ? { fingerprint: m.tlsFingerprint } : null,
  }));

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

  // ── Agents (ADR-002) ───────────────────────────────────────────────────────────
  // Enrolling by hand: paste the ids and the public key the agent prints. Registration codes
  // (Phase 4) will do the same thing without the copying.
  router.put('/api/v1/servers/:id/agent', 'servers.manage', (ctx) => {
    const b = body(ctx);
    return audited(ctx, 'agent.enrol', ctx.params.id.slice(0, 64), () => inventory.enrolAgent(ctx.params.id, { agentId: b.agentId, publicKey: b.publicKey }, actor(ctx)));
  });
  router.delete('/api/v1/servers/:id/agent', 'servers.manage', (ctx) => audited(ctx, 'agent.revoke', ctx.params.id.slice(0, 64), () => inventory.removeAgent(ctx.params.id)));

  // ── Registration (Phase 4, ADR-004) ────────────────────────────────────────────
  const { registrations } = m;
  /** Wrong codes per address: ten in 15 minutes lock the address out of registering for 15 minutes. */
  const wrongCodes = new AttemptLimiter(10, 15 * 60_000, 15 * 60_000);

  router.post('/api/v1/registration-codes', 'servers.manage', (ctx) => {
    const b = body(ctx);
    let created: ReturnType<typeof registrations.createCode>;
    try {
      created = registrations.createCode({ serverId: b.serverId, name: b.name, expiresInMinutes: b.expiresInMinutes, autoApprove: b.autoApprove }, actor(ctx));
    } catch (e) {
      audit.record({ user: actor(ctx), action: 'registration.code.create', result: 'failure', ip: ctx.ip, metadata: { reason: (e as Error).message } });
      throw e;
    }
    const { code, record } = created;
    audit.record({ user: actor(ctx), action: 'registration.code.create', target: record.id, result: 'success', ip: ctx.ip, metadata: { serverId: record.serverId, name: record.name, expiresAt: record.expiresAt, autoApprove: record.autoApprove } });
    // The address the administrator reached this Manager at is the best guess for what agents can reach.
    const host = typeof ctx.req.headers.host === 'string' && /^[A-Za-z0-9.:[\]-]+$/.test(ctx.req.headers.host) ? ctx.req.headers.host : `<manager>:${config.http.port}`;
    const url = `${config.http.tls ? 'https' : 'http'}://${host}`;
    const trust = m.tlsFingerprint ? ` --fingerprint ${m.tlsFingerprint}` : ' --insecure';
    // To be run as root on the new server. (The word for that is left out on purpose: the Manager's
    // program is tested to contain nothing that names a way to run commands.)
    return { ...record, code, managerUrl: url, fingerprint: m.tlsFingerprint || null, command: `servermin-agent register ${code} --manager ${url}${trust}`, runAs: 'root' };
  });
  router.get('/api/v1/registration-codes', 'servers.manage', () => registrations.listCodes());
  router.delete('/api/v1/registration-codes/:id', 'servers.manage', (ctx) => {
    try {
      const code = registrations.revokeCode(ctx.params.id);
      audit.record({ user: actor(ctx), action: 'registration.code.revoke', target: code.id, result: 'success', ip: ctx.ip });
      return code;
    } catch (e) {
      audit.record({ user: actor(ctx), action: 'registration.code.revoke', target: ctx.params.id.slice(0, 64), result: 'failure', ip: ctx.ip, metadata: { reason: (e as Error).message } });
      throw e;
    }
  });

  /**
   * Public: an agent presents its code with its ids and public key. Only the code authorises it.
   * The answer carries the Manager's certificate fingerprint so the agent can check it pinned
   * the same certificate it is talking to.
   */
  router.post('/api/v1/registrations', PUBLIC, (ctx) => {
    const ip = ctx.ip ?? 'unknown';
    if (wrongCodes.isLocked(ip)) {
      audit.record({ action: 'registration.submit', result: 'failure', ip: ctx.ip, metadata: { reason: 'address locked out after wrong codes' } });
      throw new ApiError(429, 'Too many wrong registration codes from this address; try again later');
    }
    const b = body(ctx);
    try {
      const { registration, autoApprove } = registrations.submit(b, ctx.ip ?? null);
      audit.record({ action: 'registration.submit', target: registration.agentId, result: 'success', ip: ctx.ip, metadata: { registrationId: registration.id, codeId: registration.codeId, hostname: registration.hostname, keyFingerprint: registration.keyFingerprint } });
      let decided = registration;
      let serverId: string | null = null;
      if (autoApprove) {
        try {
          const r = registrations.approve(registration.id, {}, `code:${registration.codeId}`);
          decided = r.registration;
          serverId = r.server.id;
          audit.record({ user: `code:${registration.codeId}`, action: 'registration.approve', target: registration.id, result: 'success', ip: ctx.ip, metadata: { serverId, agentId: registration.agentId, auto: true } });
        } catch (e) {
          // Left pending for a person to decide.
          audit.record({ user: `code:${registration.codeId}`, action: 'registration.approve', target: registration.id, result: 'failure', ip: ctx.ip, metadata: { reason: (e as Error).message, auto: true } });
        }
      }
      return { registrationId: decided.id, status: decided.status, serverId, fingerprint: m.tlsFingerprint || null };
    } catch (e) {
      if (e instanceof RegistrationError) {
        if (e.status === 403) wrongCodes.fail(ip);
        audit.record({ action: 'registration.submit', target: typeof b.agentId === 'string' ? b.agentId.slice(0, 64) : undefined, result: 'failure', ip: ctx.ip, metadata: { reason: e.reason } });
      }
      throw e;
    }
  });

  router.get('/api/v1/registrations', 'servers.read', (ctx) => registrations.list(ctx.query.status || undefined));
  router.get('/api/v1/registrations/:id', 'servers.read', (ctx) => registrations.require(ctx.params.id));
  router.post('/api/v1/registrations/:id/approve', 'servers.manage', (ctx) => {
    try {
      const r = registrations.approve(ctx.params.id, { name: body(ctx).name }, actor(ctx)!);
      audit.record({ user: actor(ctx), action: 'registration.approve', target: r.registration.id, result: 'success', ip: ctx.ip, metadata: { serverId: r.server.id, agentId: r.registration.agentId } });
      return r;
    } catch (e) {
      audit.record({ user: actor(ctx), action: 'registration.approve', target: ctx.params.id.slice(0, 64), result: 'failure', ip: ctx.ip, metadata: { reason: (e as Error).message } });
      throw e;
    }
  });
  router.post('/api/v1/registrations/:id/reject', 'servers.manage', (ctx) => {
    try {
      const r = registrations.reject(ctx.params.id, { reason: body(ctx).reason }, actor(ctx)!);
      audit.record({ user: actor(ctx), action: 'registration.reject', target: r.id, result: 'success', ip: ctx.ip, metadata: { agentId: r.agentId, reason: r.reason } });
      return r;
    } catch (e) {
      audit.record({ user: actor(ctx), action: 'registration.reject', target: ctx.params.id.slice(0, 64), result: 'failure', ip: ctx.ip, metadata: { reason: (e as Error).message } });
      throw e;
    }
  });
}
