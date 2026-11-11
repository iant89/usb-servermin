import { AUTHENTICATED, PUBLIC, isValidPermission } from '@servermin/sdk';
import type { AuditLog } from '../audit/audit';
import type { AuthService } from '../auth/auth-service';
import type { SetupToken } from '../auth/setup-token';
import type { Router } from './router';
import { ApiError, asString, requireFields, type RequestContext } from './util';

export interface AccountRouteDeps {
  auth: AuthService;
  audit: AuditLog;
  /** Name of the session cookie. Cookies are shared between ports of one host, so two services on one host need two names. */
  cookieName: string;
  secureCookies(): boolean;
  setupToken: SetupToken;
  onLogin?(username: string): void;
  /** Extra fields for `GET /auth/session` (product name, version, …). */
  sessionInfo(authenticated: boolean): Record<string, unknown>;
}

function actor(ctx: RequestContext) {
  return ctx.user?.username;
}

/**
 * Sign-in, first-run setup, API tokens, user management and the audit log: the endpoints every
 * Servermin service with its own accounts exposes (the agent's local interface and the Manager).
 */
export function registerAccountRoutes(router: Router, d: AccountRouteDeps) {
  const { auth, audit } = d;

  router.get('/api/v1/auth/session', PUBLIC, (ctx) => {
    const needsSetup = auth.userCount() === 0;
    if (!ctx.user) return { authenticated: false, needsSetup, ...d.sessionInfo(false) };
    return {
      authenticated: true,
      needsSetup,
      user: { id: ctx.user.id, username: ctx.user.username, displayName: ctx.user.displayName, permissions: ctx.user.permissions },
      ...d.sessionInfo(true),
    };
  });

  router.post('/api/v1/auth/setup', PUBLIC, async (ctx) => {
    if (auth.userCount() > 0) throw new ApiError(409, 'Setup is already complete');
    const b = requireFields<{ setupToken: string; username: string; password: string; displayName?: string }>(ctx.body, ['setupToken', 'username', 'password']);
    if (!d.setupToken.check(String(b.setupToken))) {
      audit.record({ action: 'auth.setup', result: 'failure', ip: ctx.ip, metadata: { reason: 'invalid setup token' } });
      throw new ApiError(403, 'The setup token is incorrect. It is in the setup-token file in the data directory.');
    }
    const user = await auth.createUser({ username: String(b.username), displayName: b.displayName, password: String(b.password), permissions: ['*'] });
    d.setupToken.consume();
    audit.record({ user: user.username, action: 'auth.setup', result: 'success', ip: ctx.ip });
    return loginResponse(ctx, await auth.login(user.username, String(b.password), ctx.ip, ctx.req.headers['user-agent']));
  });

  const loginResponse = (ctx: RequestContext, r: Awaited<ReturnType<typeof auth.login>>) => {
    const secure = d.secureCookies();
    ctx.res.setHeader('set-cookie', `${d.cookieName}=${r.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 86400}${secure ? '; Secure' : ''}`);
    d.onLogin?.(r.user.username);
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
    ctx.res.setHeader('set-cookie', `${d.cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
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

  // ── Users ──────────────────────────────────────────────────────────────────────
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


  // ── Audit log ──────────────────────────────────────────────────────────────────
  router.get('/api/v1/audit', 'audit.read', (ctx) => {
    const rows = audit.query({ user: ctx.query.user, action: ctx.query.action, module: ctx.query.module, result: ctx.query.result, search: ctx.query.search, before: Number(ctx.query.before) || undefined, limit: Number(ctx.query.limit) || 200 });
    if (ctx.query.format === 'csv') {
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = ['timestamp,user,action,module,target,result,ip,metadata', ...rows.map((r) => [r.timestamp, r.user, r.action, r.module, r.target, r.result, r.ip, JSON.stringify(r.metadata ?? {})].map(esc).join(','))].join('\n');
      return { __raw: csv, contentType: 'text/csv; charset=utf-8', filename: 'audit-log.csv' };
    }
    return rows;
  });
}
