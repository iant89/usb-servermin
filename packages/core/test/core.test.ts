import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttemptLimiter, AuditLog, AuthService, CORE_MIGRATIONS, Database, EventBus, InstallError, LogService, ModuleInstaller, ProcessService, TokenBucket, hashPassword, verifyPassword } from '../src/index';
import { defaultConfig, loadConfig, mergeConfig } from '../src/config/config';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'core-test-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function coreDb() {
  const db = new Database(join(dir, 'core.db'));
  db.migrate(CORE_MIGRATIONS);
  return db;
}

describe('event bus', () => {
  it('delivers by pattern, isolates failing handlers and removes an owner in one call', () => {
    const errors: string[] = [];
    const bus = new EventBus((e, _ev, owner) => errors.push(`${owner}: ${(e as Error).message}`));
    const got: string[] = [];
    bus.subscribe('docker.container.*', (e) => got.push(e.type), 'apps');
    bus.subscribe('*', () => {
      throw new Error('bad handler');
    }, 'buggy');
    bus.subscribe('**', (e) => got.push(`all:${e.type}`), 'apps');
    bus.publish('docker.container.started', {}, 'docker');
    expect(got).toEqual(['docker.container.started', 'all:docker.container.started']);
    expect(errors).toEqual(['buggy: bad handler']);
    expect(bus.removeOwner('apps')).toBe(2);
    bus.publish('docker.container.stopped', {});
    expect(got).toHaveLength(2);
    expect(bus.history('docker.**').map((e) => e.type)).toEqual(['docker.container.started', 'docker.container.stopped']);
  });
});

describe('database', () => {
  it('applies migrations once, in order, transactionally', () => {
    const db = new Database(join(dir, 'm.db'));
    const migrations = [
      { version: 2, name: 'b', sql: 'ALTER TABLE t ADD COLUMN b TEXT' },
      { version: 1, name: 'a', sql: 'CREATE TABLE t (a TEXT)' },
    ];
    db.migrate(migrations);
    db.migrate(migrations);
    expect(db.all('SELECT version FROM _migrations ORDER BY version')).toEqual([{ version: 1 }, { version: 2 }]);
    expect(() => db.migrate([{ version: 3, name: 'broken', sql: 'CREATE TABLE x (; nonsense' }])).toThrow();
    expect(db.get('SELECT COUNT(*) AS n FROM _migrations')).toEqual({ n: 2 });
    expect(() => db.migrate([{ version: 4, name: 'a', sql: 'SELECT 1' }, { version: 4, name: 'b', sql: 'SELECT 1' }])).toThrow(/Duplicate/);
    db.close();
  });
});

describe('configuration', () => {
  it('merges file and environment configuration and validates it', () => {
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ http: { port: 8080 }, logging: { level: 'WARN' } }));
    const c = loadConfig({ SERVERMIN_CONFIG: file, SERVERMIN_DATA_DIR: join(dir, 'data'), SERVERMIN_PRIVILEGED_MODE: 'simulate' });
    expect(c.http).toMatchObject({ port: 8080, host: '0.0.0.0' });
    expect(c.logging.level).toBe('WARN');
    expect(c.paths.modules).toBe(join(dir, 'data', 'modules'));
    expect(c.privileged.mode).toBe('simulate');
    writeFileSync(file, JSON.stringify({ http: { port: 70000 } }));
    expect(() => loadConfig({ SERVERMIN_CONFIG: file })).toThrow(/http.port/);
    expect(mergeConfig(defaultConfig(), { modules: { preinstall: ['/x'] } }).modules.preinstall).toEqual(['/x']);
  });
});

describe('authentication', () => {
  it('hashes passwords with scrypt', async () => {
    const h = await hashPassword('correct horse 1');
    expect(h).toMatch(/^scrypt\$/);
    expect(await verifyPassword('correct horse 1', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });

  it('manages users, sessions and tokens', async () => {
    const auth = new AuthService(coreDb(), { sessionHours: 1, loginAttempts: 3, lockoutMinutes: 1 });
    await expect(auth.createUser({ username: 'admin', password: 'short', permissions: ['*'] })).rejects.toThrow(/10 characters/);
    const admin = await auth.createUser({ username: 'admin', password: 'long-enough-1', permissions: ['*'] });
    await expect(auth.createUser({ username: 'ADMIN', password: 'long-enough-1', permissions: [] })).rejects.toThrow(/exists/);
    const { token } = await auth.login('admin', 'long-enough-1', '1.2.3.4');
    expect(auth.authenticateSession(token)?.user.id).toBe(admin.id);
    expect(auth.authenticateSession('forged')).toBeNull();
    const api = auth.createToken(admin.id, 'cli', 30);
    expect(auth.authenticateToken(api.token)?.username).toBe('admin');
    auth.revokeToken(admin.id, api.id);
    expect(auth.authenticateToken(api.token)).toBeNull();
    // The last administrator cannot be removed or demoted.
    expect(() => auth.deleteUser(admin.id)).toThrow(/administrator/);
    await expect(auth.updateUser(admin.id, { permissions: ['system.read'] })).rejects.toThrow(/administrator/);
    // Changing the password ends existing sessions.
    const revoked: string[] = [];
    auth.onSessionRevoked((h) => revoked.push(h));
    await auth.updateUser(admin.id, { password: 'another-pass-2' });
    expect(auth.authenticateSession(token)).toBeNull();
    expect(revoked).toHaveLength(1);
  });

  it('locks out repeated failures', async () => {
    const auth = new AuthService(coreDb(), { sessionHours: 1, loginAttempts: 2, lockoutMinutes: 1 });
    await auth.createUser({ username: 'u1', password: 'long-enough-1', permissions: [] });
    await expect(auth.login('u1', 'x', 'ip')).rejects.toThrow(/Invalid/);
    await expect(auth.login('u1', 'x', 'ip')).rejects.toThrow(/Invalid/);
    await expect(auth.login('u1', 'long-enough-1', 'ip')).rejects.toMatchObject({ status: 429 });
    await expect(auth.login('u1', 'long-enough-1', 'other-ip')).resolves.toBeTruthy();
  });

  it('rate limiters', () => {
    const l = new AttemptLimiter(2, 1000, 5000);
    l.fail('k', 0);
    expect(l.isLocked('k', 1)).toBe(0);
    l.fail('k', 2);
    expect(l.isLocked('k', 3)).toBeGreaterThan(0);
    expect(l.isLocked('k', 6000)).toBe(0);
    const b = new TokenBucket(2, 1);
    expect([b.take('a', 0), b.take('a', 0), b.take('a', 0), b.take('a', 1000)]).toEqual([true, true, false, true]);
  });
});

describe('process service', () => {
  const make = (mode: 'simulate' | 'disabled' = 'simulate') => {
    const db = coreDb();
    const audit = new AuditLog(db);
    const logs = new LogService({ level: 'ERROR', stdout: false });
    return { audit, svc: new ProcessService({ logger: logs.logger('test'), audit, privilegedMode: mode, helper: '/nonexistent' }) };
  };

  it('runs only declared commands, without a shell, with timeouts and bounded output', async () => {
    const { svc } = make();
    await expect(svc.execute('m', ['echo'], { command: 'ls' })).rejects.toMatchObject({ status: 403 });
    const r = await svc.execute('m', ['echo'], { command: 'echo', args: ['$(id)', '; rm -rf /'] });
    expect(r.stdout).toBe('$(id) ; rm -rf /\n');
    const slow = await svc.execute('m', ['sleep'], { command: 'sleep', args: ['5'], timeoutMs: 200 });
    expect(slow.timedOut).toBe(true);
    const big = await svc.execute('m', ['head'], { command: 'head', args: ['-c', '100000', '/dev/zero'], maxOutputBytes: 1000 });
    expect(big.stdout).toMatch(/output truncated/);
    const ac = new AbortController();
    const p = svc.execute('m', ['sleep'], { command: 'sleep', args: ['5'], signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    expect((await p).cancelled).toBe(true);
    const env = await svc.execute('m', ['env'], { command: 'env', env: { LD_PRELOAD: '/evil.so', GOOD: '1' } });
    expect(env.stdout).toContain('GOOD=1');
    expect(env.stdout).not.toContain('LD_PRELOAD');
  });

  it('kills long-running processes of a module on unload', async () => {
    const { svc } = make();
    let exited = false;
    await svc.spawn('m', ['sleep'], { command: 'sleep', args: ['30'] }, { onExit: () => (exited = true) });
    expect(svc.list()).toHaveLength(1);
    expect(svc.killOwner('m')).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(exited).toBe(true);
  });

  it('guards and audits privileged operations', async () => {
    const { svc, audit } = make();
    await expect(svc.privileged('m', [], 'power.reboot', {}, { confirmed: true })).rejects.toMatchObject({ status: 403 });
    await expect(svc.privileged('m', ['power.reboot'], 'power.reboot')).rejects.toMatchObject({ status: 428 });
    await expect(svc.privileged('m', ['service.stop'], 'service.stop', { unit: 'x;y' })).rejects.toMatchObject({ status: 400 });
    const ok = await svc.privileged('m', ['service.stop'], 'service.stop', { unit: 'nginx.service' }, { user: 'alice' });
    expect(ok.stdout).toMatch(/simulated: service.stop unit=nginx.service/);
    const rows = audit.query();
    expect(rows.map((r) => r.result)).toEqual(['success', 'failure', 'failure', 'failure']);
    expect(rows[0]).toMatchObject({ user: 'alice', action: 'privileged.service.stop', module: 'm' });
    await expect(make('disabled').svc.privileged('m', ['power.reboot'], 'power.reboot', {}, { confirmed: true })).rejects.toMatchObject({ status: 403 });
  });
});

describe('module installer', () => {
  function moduleDir(name: string, manifest: object) {
    const d = join(dir, name);
    mkdirSync(join(d, 'dist'), { recursive: true });
    writeFileSync(join(d, 'module.json'), JSON.stringify(manifest));
    writeFileSync(join(d, 'dist/backend.js'), 'export default {}');
    return d;
  }
  const manifest = { id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: 1, backend: { entry: 'dist/backend.js' } };

  it('stages a directory, copying only module files', async () => {
    const src = moduleDir('src', manifest);
    writeFileSync(join(src, 'secret.txt'), 'not part of the module');
    const staged = await new ModuleInstaller(join(dir, 'tmp')).stage({ type: 'directory', path: src });
    expect(staged.manifest.id).toBe('demo');
    expect(staged.integrity).toBe('unverified');
    expect(staged.warnings.join()).toMatch(/integrity/);
  });

  it('rejects missing entries and symbolic links', async () => {
    const src = moduleDir('src2', { ...manifest, frontend: { entry: 'dist/frontend.js' } });
    await expect(new ModuleInstaller(join(dir, 'tmp')).stage({ type: 'directory', path: src })).rejects.toThrow(/frontend entry/);
    const linked = moduleDir('src3', manifest);
    symlinkSync('/etc/passwd', join(linked, 'dist', 'passwd'));
    writeFileSync(join(linked, 'integrity.json'), JSON.stringify({ algorithm: 'sha256', files: { 'module.json': 'x', 'dist/passwd': 'y' } }));
    await expect(new ModuleInstaller(join(dir, 'tmp')).stage({ type: 'directory', path: linked })).rejects.toBeInstanceOf(InstallError);
  });

  it('rejects integrity lists that point outside the module', async () => {
    const src = moduleDir('src4', manifest);
    writeFileSync(join(src, 'integrity.json'), JSON.stringify({ algorithm: 'sha256', files: { '../../etc/passwd': 'x' } }));
    await expect(new ModuleInstaller(join(dir, 'tmp')).stage({ type: 'directory', path: src })).rejects.toThrow(/invalid path/);
  });

  it('discovers modules in source directories and reports invalid ones', async () => {
    moduleDir('sources/good', manifest);
    moduleDir('sources/bad', { ...manifest, id: 'BAD' });
    const found = await new ModuleInstaller(join(dir, 'tmp')).discover([join(dir, 'sources')]);
    expect(found.map((f) => [f.manifest?.id, f.errors.length > 0]).sort()).toEqual([['BAD', true], ['demo', false]]);
  });
});
