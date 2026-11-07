import type { RequestUser } from '@servermin/sdk';
import type { Database } from '../database/database';
import { hashPassword, passwordProblems, randomToken, sha256, verifyPassword } from './passwords';
import { AttemptLimiter } from './rate-limit';

export interface UserRecord {
  id: number;
  username: string;
  displayName: string;
  permissions: string[];
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 401,
  ) {
    super(message);
  }
}

const USERNAME_RE = /^[a-z][a-z0-9._-]{1,31}$/i;

/** Permission presets offered by the user editor. Permissions themselves stay independent (§19). */
export const ROLE_PRESETS: Record<string, { label: string; permissions: string[] }> = {
  administrator: { label: 'Administrator', permissions: ['*'] },
  operator: {
    label: 'Operator',
    permissions: ['modules.read', 'platform.logs.read', 'system.read', 'docker.*', 'storage.read', 'network.read', 'services.*', 'applications.*', 'logs.read', 'monitoring.read'],
  },
  viewer: {
    label: 'Viewer',
    permissions: ['modules.read', 'system.read', 'docker.read', 'storage.read', 'network.read', 'services.read', 'applications.read', 'logs.read', 'monitoring.read'],
  },
};

/**
 * Users, sessions and API tokens (§20). Session and token secrets are stored only as SHA-256
 * hashes, passwords with scrypt. Sessions slide up to `sessionHours` of inactivity and are
 * capped at 7 days.
 */
export class AuthService {
  readonly limiter: AttemptLimiter;
  private sessionListeners = new Set<(sessionHash: string) => void>();

  constructor(
    private readonly db: Database,
    private readonly opts: { sessionHours: number; loginAttempts: number; lockoutMinutes: number },
  ) {
    this.limiter = new AttemptLimiter(opts.loginAttempts, opts.lockoutMinutes * 60_000, opts.lockoutMinutes * 60_000);
  }

  private toUser(r: any): UserRecord {
    return {
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      permissions: JSON.parse(r.permissions),
      disabled: !!r.disabled,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
    };
  }

  toRequestUser(u: UserRecord): RequestUser {
    return { id: u.id, username: u.username, displayName: u.displayName, permissions: u.permissions };
  }

  userCount(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
  }

  listUsers(): UserRecord[] {
    return this.db.all('SELECT * FROM users ORDER BY username').map((r) => this.toUser(r));
  }

  getUser(id: number): UserRecord | undefined {
    const r = this.db.get('SELECT * FROM users WHERE id = ?', [id]);
    return r ? this.toUser(r) : undefined;
  }

  findUser(username: string): UserRecord | undefined {
    const r = this.db.get('SELECT * FROM users WHERE username = ?', [username]);
    return r ? this.toUser(r) : undefined;
  }

  async createUser(input: { username: string; displayName?: string; password: string; permissions: string[] }): Promise<UserRecord> {
    if (!USERNAME_RE.test(input.username)) throw new AuthError('Username must be 2-32 letters, digits, dots, dashes or underscores', 400);
    const problems = passwordProblems(input.password);
    if (problems.length) throw new AuthError(problems.join('. '), 400);
    if (this.findUser(input.username)) throw new AuthError('A user with this name already exists', 409);
    const hash = await hashPassword(input.password);
    const r = this.db.run('INSERT INTO users (username, display_name, password_hash, permissions, created_at) VALUES (?, ?, ?, ?, ?)', [
      input.username,
      input.displayName?.trim() || input.username,
      hash,
      JSON.stringify(dedupe(input.permissions)),
      new Date().toISOString(),
    ]);
    return this.getUser(r.lastInsertRowid)!;
  }

  async updateUser(id: number, patch: { displayName?: string; permissions?: string[]; disabled?: boolean; password?: string }): Promise<UserRecord> {
    const user = this.getUser(id);
    if (!user) throw new AuthError('User not found', 404);
    if (patch.permissions && !patch.permissions.includes('*') && user.permissions.includes('*') && this.adminCount() <= 1)
      throw new AuthError('At least one administrator must remain', 409);
    if (patch.disabled && user.permissions.includes('*') && this.adminCount() <= 1) throw new AuthError('At least one administrator must remain', 409);
    if (patch.displayName !== undefined) this.db.run('UPDATE users SET display_name = ? WHERE id = ?', [patch.displayName.trim() || user.username, id]);
    if (patch.permissions) this.db.run('UPDATE users SET permissions = ? WHERE id = ?', [JSON.stringify(dedupe(patch.permissions)), id]);
    if (patch.disabled !== undefined) {
      this.db.run('UPDATE users SET disabled = ? WHERE id = ?', [patch.disabled ? 1 : 0, id]);
      if (patch.disabled) this.revokeUserSessions(id);
    }
    if (patch.password !== undefined) {
      const problems = passwordProblems(patch.password);
      if (problems.length) throw new AuthError(problems.join('. '), 400);
      this.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(patch.password), id]);
      this.revokeUserSessions(id);
    }
    return this.getUser(id)!;
  }

  deleteUser(id: number) {
    const user = this.getUser(id);
    if (!user) throw new AuthError('User not found', 404);
    if (user.permissions.includes('*') && this.adminCount() <= 1) throw new AuthError('At least one administrator must remain', 409);
    this.revokeUserSessions(id);
    this.db.run('DELETE FROM users WHERE id = ?', [id]);
  }

  private adminCount() {
    return this.listUsers().filter((u) => u.permissions.includes('*') && !u.disabled).length;
  }

  async changePassword(userId: number, current: string, next: string) {
    const row = this.db.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [userId]);
    if (!row || !(await verifyPassword(current, row.password_hash))) throw new AuthError('The current password is incorrect', 400);
    await this.updateUser(userId, { password: next });
  }

  /** Verifies credentials; throws AuthError (429 when locked out). */
  async login(username: string, password: string, ip: string, userAgent?: string): Promise<{ token: string; user: UserRecord; expiresAt: number }> {
    const key = `${ip}|${username.toLowerCase()}`;
    const locked = this.limiter.isLocked(key);
    if (locked) throw new AuthError(`Too many failed attempts. Try again in ${Math.ceil(locked / 60_000)} minutes.`, 429);
    const row = this.db.get<any>('SELECT * FROM users WHERE username = ?', [username]);
    // Always run a hash so response timing does not reveal whether the user exists.
    const ok = row ? await verifyPassword(password, row.password_hash) : (await hashPassword(password), false);
    if (!ok || row.disabled) {
      this.limiter.fail(key);
      throw new AuthError('Invalid username or password');
    }
    this.limiter.succeed(key);
    const token = randomToken();
    const now = Date.now();
    const expiresAt = now + this.opts.sessionHours * 3_600_000;
    this.db.run('INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      sha256(token),
      row.id,
      now,
      expiresAt,
      now,
      ip,
      userAgent?.slice(0, 300) ?? null,
    ]);
    this.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [new Date(now).toISOString(), row.id]);
    this.db.run('DELETE FROM sessions WHERE expires_at < ?', [now]);
    return { token, user: this.toUser(row), expiresAt };
  }

  /** Resolves a session cookie. Extends the session (sliding expiry, 7-day cap). */
  authenticateSession(token: string): { user: UserRecord; sessionHash: string } | null {
    if (!token || token.length > 200) return null;
    const hash = sha256(token);
    const s = this.db.get<{ user_id: number; created_at: number; expires_at: number; last_seen_at: number }>('SELECT * FROM sessions WHERE id_hash = ?', [hash]);
    const now = Date.now();
    if (!s || s.expires_at < now) return null;
    const user = this.getUser(s.user_id);
    if (!user || user.disabled) return null;
    if (now - s.last_seen_at > 60_000) {
      const expires = Math.min(now + this.opts.sessionHours * 3_600_000, s.created_at + 7 * 86_400_000);
      this.db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?', [now, expires, hash]);
    }
    return { user, sessionHash: hash };
  }

  isSessionValid(sessionHash: string): boolean {
    const s = this.db.get<{ expires_at: number; user_id: number }>('SELECT expires_at, user_id FROM sessions WHERE id_hash = ?', [sessionHash]);
    if (!s || s.expires_at < Date.now()) return false;
    const u = this.getUser(s.user_id);
    return !!u && !u.disabled;
  }

  logout(token: string) {
    const hash = sha256(token);
    this.db.run('DELETE FROM sessions WHERE id_hash = ?', [hash]);
    for (const l of this.sessionListeners) l(hash);
  }

  revokeUserSessions(userId: number) {
    const rows = this.db.all<{ id_hash: string }>('SELECT id_hash FROM sessions WHERE user_id = ?', [userId]);
    this.db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
    for (const r of rows) for (const l of this.sessionListeners) l(r.id_hash);
  }

  onSessionRevoked(l: (sessionHash: string) => void) {
    this.sessionListeners.add(l);
    return () => this.sessionListeners.delete(l);
  }

  // ── API tokens (CLI and automation) ───────────────────────────────────────────

  createToken(userId: number, name: string, expiresInDays?: number) {
    const secret = `smt_${randomToken(24)}`;
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString() : null;
    const r = this.db.run('INSERT INTO api_tokens (user_id, name, token_hash, prefix, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', [
      userId,
      name.slice(0, 80) || 'token',
      sha256(secret),
      secret.slice(0, 10),
      new Date().toISOString(),
      expiresAt,
    ]);
    return { id: r.lastInsertRowid, token: secret, prefix: secret.slice(0, 10), expiresAt };
  }

  listTokens(userId: number) {
    return this.db
      .all<any>('SELECT id, name, prefix, created_at, last_used_at, expires_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC', [userId])
      .map((t) => ({ id: t.id, name: t.name, prefix: t.prefix, createdAt: t.created_at, lastUsedAt: t.last_used_at, expiresAt: t.expires_at }));
  }

  revokeToken(userId: number, id: number) {
    return this.db.run('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', [id, userId]).changes > 0;
  }

  authenticateToken(secret: string): UserRecord | null {
    if (!secret.startsWith('smt_') || secret.length > 100) return null;
    const t = this.db.get<{ id: number; user_id: number; expires_at: string | null }>('SELECT id, user_id, expires_at FROM api_tokens WHERE token_hash = ?', [sha256(secret)]);
    if (!t || (t.expires_at && t.expires_at < new Date().toISOString())) return null;
    const user = this.getUser(t.user_id);
    if (!user || user.disabled) return null;
    this.db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', [new Date().toISOString(), t.id]);
    return user;
  }
}

function dedupe(list: string[]) {
  return [...new Set(list.filter((p) => typeof p === 'string' && p.length > 0 && p.length < 100))];
}
