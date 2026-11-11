import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ROOT, startServer, waitFor } from './helpers';
import { startManager, type TestManager } from './manager-helpers';

let m: TestManager | undefined;
afterEach(async () => {
  await m?.stop().catch(() => undefined);
  m = undefined;
});

const addUser = async (t: TestManager, username: string, permissions: string[]) => {
  expect((await t.api('POST', '/api/v1/users', { username, password: 'test-password-2', permissions })).status).toBe(200);
  const login = await t.api('POST', '/api/v1/auth/login', { username, password: 'test-password-2' }, { cookie: '' });
  return login.setCookie!.split(';')[0];
};

describe('manager foundation', () => {
  it('starts on its own, with no agent, no modules and nothing to administer yet', async () => {
    m = await startManager({ setup: false });
    expect((await m.api('GET', '/api/v1/health')).body).toMatchObject({ status: 'HEALTHY', service: 'manager' });
    expect((await m.api('GET', '/api/v1/auth/session')).body).toEqual({ authenticated: false, needsSetup: true, service: 'manager' });
    // Nothing of the agent's interface exists here.
    for (const path of ['/api/v1/agent', '/api/v1/platform/modules', '/api/v1/modules/system/info', '/api/v1/updates', '/modules/system/assets/frontend.js', '/']) {
      expect((await m.api('GET', path)).status, path).toBe(404);
    }
    expect((m.manager as any).modules).toBeUndefined();
    expect((m.manager as any).processes).toBeUndefined();
    // Only its owner may read the data directory: it holds password and session hashes.
    expect(statSync(m.manager.config.paths.data).mode & 0o777).toBe(0o700);
    expect(statSync(join(m.manager.config.paths.data, 'setup-token')).mode & 0o777).toBe(0o600);
  });

  it('needs the setup token for the first administrator and records a wrong one', async () => {
    m = await startManager({ setup: false });
    const bad = await m.api('POST', '/api/v1/auth/setup', { setupToken: 'guess', username: 'admin', password: 'test-password-1' });
    expect(bad.status).toBe(403);
    expect((await m.api('GET', '/api/v1/servers')).status).toBe(401);
    const token = readFileSync(join(m.manager.config.paths.data, 'setup-token'), 'utf8').trim();
    const ok = await m.api('POST', '/api/v1/auth/setup', { setupToken: token, username: 'admin', password: 'test-password-1' });
    expect(ok.status).toBe(200);
    expect(ok.setCookie).toMatch(/^smm_session=.*HttpOnly; SameSite=Strict/);
    expect((await m.api('POST', '/api/v1/auth/setup', { setupToken: token, username: 'again', password: 'test-password-1' })).status).toBe(409);
    const audit = (await m.api('GET', '/api/v1/audit')).body;
    expect(audit.map((a: any) => `${a.action}:${a.result}`)).toEqual(expect.arrayContaining(['auth.setup:failure', 'auth.setup:success']));
    expect((await m.api('GET', '/api/v1/auth/session')).body).toMatchObject({ authenticated: true, service: 'manager', user: { username: 'admin', permissions: ['*'] } });
  });

  it('keeps an inventory of servers through the API and audits every change', async () => {
    m = await startManager();
    expect((await m.api('GET', '/api/v1/servers')).body).toEqual([]);
    const created = await m.api('POST', '/api/v1/servers', { name: 'Saturn', hostname: 'saturn.lan', description: 'compute' });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ name: 'Saturn', hostname: 'saturn.lan', state: 'UNKNOWN', agentId: null });
    const id = created.body.id;
    await m.api('POST', '/api/v1/servers', { name: 'Jupiter' });

    expect((await m.api('GET', '/api/v1/servers')).body.map((s: any) => s.name)).toEqual(['Jupiter', 'Saturn']);
    expect((await m.api('GET', `/api/v1/servers/${id}`)).body.id).toBe(id);
    expect((await m.api('PATCH', `/api/v1/servers/${id}`, { description: 'gpu' })).body).toMatchObject({ name: 'Saturn', description: 'gpu' });
    // The state is derived from what an agent reports; a client cannot set it.
    expect((await m.api('PATCH', `/api/v1/servers/${id}`, { state: 'ONLINE', agentId: 'x' })).body).toMatchObject({ state: 'UNKNOWN', agentId: null });

    expect((await m.api('POST', '/api/v1/servers', { name: 'saturn' })).status).toBe(409);
    expect((await m.api('POST', '/api/v1/servers', { name: '' })).status).toBe(400);
    expect((await m.api('POST', '/api/v1/servers', 'not an object' as any)).status).toBe(400);
    expect((await m.api('GET', '/api/v1/servers/nope')).status).toBe(404);
    expect((await m.api('PATCH', '/api/v1/servers/0b9f3c1e-2d4a-4f6b-8c7d-9e0f1a2b3c4d', { name: 'x' })).status).toBe(404);

    expect((await m.api('GET', '/api/v1/manager')).body).toMatchObject({ status: 'HEALTHY', servers: { total: 2, byState: { UNKNOWN: 2 } } });
    expect((await m.api('DELETE', `/api/v1/servers/${id}`)).body).toEqual({ ok: true });
    expect((await m.api('GET', `/api/v1/servers/${id}`)).status).toBe(404);

    const audit = (await m.api('GET', '/api/v1/audit?search=server.')).body.map((a: any) => `${a.user} ${a.action} ${a.result} ${a.metadata?.name ?? a.metadata?.reason}`).reverse();
    expect(audit).toEqual([
      'admin server.create success Saturn',
      'admin server.create success Jupiter',
      'admin server.update success Saturn',
      'admin server.update success Saturn',
      'admin server.create failure A server named "saturn" already exists',
      'admin server.create failure name must be 1-64 printable characters',
      'admin server.create failure name must be 1-64 printable characters',
      'admin server.update failure Server not found',
      'admin server.remove success Saturn',
    ]);
  });

  it('keeps servers, users and sessions across a restart', async () => {
    m = await startManager();
    const saturn = (await m.api('POST', '/api/v1/servers', { name: 'Saturn', hostname: 'saturn.lan' })).body;
    await m.api('POST', '/api/v1/servers', { name: 'Pluto', id: '0b9f3c1e-2d4a-4f6b-8c7d-9e0f1a2b3c4d' });
    await m.restart();
    expect((await m.api('GET', '/api/v1/auth/session')).body).toMatchObject({ authenticated: true, needsSetup: false });
    const after = (await m.api('GET', '/api/v1/servers')).body;
    expect(after).toEqual([expect.objectContaining({ name: 'Pluto', id: '0b9f3c1e-2d4a-4f6b-8c7d-9e0f1a2b3c4d' }), saturn]);
    // No setup token is offered again once an administrator exists.
    expect(() => readFileSync(join(m!.manager.config.paths.data, 'setup-token'))).toThrow();
    expect((await m.api('POST', '/api/v1/auth/login', { username: 'admin', password: 'test-password-1' }, { cookie: '' })).status).toBe(200);
  });

  it('enforces permissions: viewers read, operators manage servers, neither manages users', async () => {
    m = await startManager();
    const id = (await m.api('POST', '/api/v1/servers', { name: 'Saturn' })).body.id;
    const presets = (await m.api('GET', '/api/v1/permissions')).body.presets;
    const viewer = await addUser(m, 'vera', presets.viewer.permissions);
    const operator = await addUser(m, 'oscar', presets.operator.permissions);
    const nobody = await addUser(m, 'nora', []);

    expect((await m.api('GET', '/api/v1/servers', undefined, { cookie: viewer })).status).toBe(200);
    expect((await m.api('POST', '/api/v1/servers', { name: 'X' }, { cookie: viewer })).status).toBe(403);
    expect((await m.api('PATCH', `/api/v1/servers/${id}`, { name: 'X' }, { cookie: viewer })).status).toBe(403);
    expect((await m.api('DELETE', `/api/v1/servers/${id}`, undefined, { cookie: viewer })).status).toBe(403);
    expect((await m.api('GET', '/api/v1/audit', undefined, { cookie: viewer })).status).toBe(403);

    expect((await m.api('POST', '/api/v1/servers', { name: 'Jupiter' }, { cookie: operator })).status).toBe(200);
    expect((await m.api('GET', '/api/v1/users', undefined, { cookie: operator })).status).toBe(403);
    expect((await m.api('POST', '/api/v1/users', { username: 'eve', password: 'test-password-3', permissions: ['*'] }, { cookie: operator })).status).toBe(403);

    expect((await m.api('GET', '/api/v1/servers', undefined, { cookie: nobody })).status).toBe(403);
    expect((await m.api('GET', '/api/v1/servers', undefined, { cookie: '' })).status).toBe(401);
    expect((await m.api('GET', '/api/v1/servers')).body.map((s: any) => s.name)).toEqual(['Jupiter', 'Saturn']);
  });

  it('applies the shared request protections: CSRF header, API tokens, login lockout', async () => {
    m = await startManager();
    const noHeader = await fetch(`${m.url}/api/v1/servers`, { method: 'POST', headers: { cookie: m.cookie, 'content-type': 'application/json' }, body: '{"name":"X"}' });
    expect(noHeader.status).toBe(403);
    const crossOrigin = await m.api('POST', '/api/v1/servers', { name: 'X' }, { headers: { origin: 'http://evil.example' } });
    expect(crossOrigin.status).toBe(403);
    expect((await m.api('GET', '/api/v1/servers')).body).toEqual([]);

    const token = (await m.api('POST', '/api/v1/auth/tokens', { name: 'cli' })).body.token;
    const viaToken = await fetch(`${m.url}/api/v1/servers`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"name":"Saturn"}' });
    expect(viaToken.status).toBe(200);
    expect((await fetch(`${m.url}/api/v1/servers`, { headers: { authorization: 'Bearer smt_wrong' } })).status).toBe(401);

    for (let i = 0; i < 5; i++) expect((await m.api('POST', '/api/v1/auth/login', { username: 'admin', password: 'wrong-password-1' }, { cookie: '' })).status).toBe(401);
    expect((await m.api('POST', '/api/v1/auth/login', { username: 'admin', password: 'test-password-1' }, { cookie: '' })).status).toBe(429);
  });

  it('does not accept an agent session, and an agent does not accept a Manager session', async () => {
    m = await startManager();
    const agent = await startServer();
    try {
      const managerToken = m.cookie.split('=')[1];
      const agentToken = agent.cookie.split('=')[1];
      expect(m.cookie.startsWith('smm_session=')).toBe(true);
      expect(agent.cookie.startsWith('sm_session=')).toBe(true);
      // Even under the right cookie name, each service knows only its own sessions.
      expect((await m.api('GET', '/api/v1/servers', undefined, { cookie: `smm_session=${agentToken}` })).status).toBe(401);
      expect((await agent.api('GET', '/api/v1/agent', undefined, { cookie: `sm_session=${managerToken}` })).status).toBe(401);
      // A browser sends both cookies to both ports of one host; each service must pick its own.
      const both = `${agent.cookie}; ${m.cookie}`;
      expect((await m.api('GET', '/api/v1/servers', undefined, { cookie: both })).status).toBe(200);
      expect((await agent.api('GET', '/api/v1/agent', undefined, { cookie: both })).status).toBe(200);
    } finally {
      await agent.stop();
    }
  });
});

describe('manager WebSocket', () => {
  const connect = (t: TestManager, cookie: string) =>
    new Promise<{ ws: WebSocket; messages: any[] }>((resolve, reject) => {
      const ws = new WebSocket(`${t.url.replace('http', 'ws')}/api/v1/ws`, { headers: { cookie, origin: t.url } });
      const messages: any[] = [];
      ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
      ws.on('open', () => resolve({ ws, messages }));
      ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.on('error', reject);
    });

  it('pushes inventory changes to subscribers who may read servers', async () => {
    m = await startManager();
    const { ws, messages } = await connect(m, m.cookie);
    ws.send(JSON.stringify({ type: 'subscribe', id: 'inv', channel: 'inventory' }));
    await waitFor(() => messages, (l) => l.some((x) => x.type === 'subscribed'));
    const id = (await m.api('POST', '/api/v1/servers', { name: 'Saturn' })).body.id;
    await m.api('PATCH', `/api/v1/servers/${id}`, { description: 'gpu' });
    await m.api('DELETE', `/api/v1/servers/${id}`);
    const data = (await waitFor(() => messages.filter((x) => x.type === 'data'), (l) => l.length === 3)).map((x) => `${x.id} ${x.data.type} ${x.data.server.name} ${x.data.server.description}`);
    expect(data).toEqual(['inv inventory.server.created Saturn ', 'inv inventory.server.updated Saturn gpu', 'inv inventory.server.removed Saturn gpu']);
    ws.close();
  });

  it('refuses connections without a session, subscriptions without permission and channels that do not exist', async () => {
    m = await startManager();
    await expect(connect(m, '')).rejects.toThrow('HTTP 401');
    const nobody = await addUser(m, 'nora', []);
    const { ws, messages } = await connect(m, nobody);
    ws.send(JSON.stringify({ type: 'subscribe', id: 'a', channel: 'inventory' }));
    ws.send(JSON.stringify({ type: 'subscribe', id: 'b', channel: 'system.metrics' }));
    ws.send(JSON.stringify({ type: 'subscribe', id: 'c', channel: 'module.status' }));
    const errors = await waitFor(() => messages.filter((x) => x.type === 'error'), (l) => l.length === 3);
    expect(errors.map((e) => `${e.id} ${e.reason}`)).toEqual(['a forbidden', 'b unknown-channel', 'c unknown-channel']);
    await m.api('POST', '/api/v1/servers', { name: 'Saturn' });
    await new Promise((r) => setTimeout(r, 150));
    expect(messages.filter((x) => x.type === 'data')).toEqual([]);
    ws.close();
  });
});

describe('servermin-manager program', () => {
  const bundle = join(ROOT, 'packages/manager/dist/manager.js');
  const run = (env: Record<string, string>) => {
    const child = spawn(process.execPath, [bundle], { env: { PATH: process.env.PATH!, ...env } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const exited = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
    return { child, exited, output: () => out };
  };
  const freePort = () =>
    new Promise<number>((resolve) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const { port } = s.address() as { port: number };
        s.close(() => resolve(port));
      });
    });

  it('runs as its own process, prints the setup token, serves the API and stops cleanly on SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'servermin-mgr-bin-'));
    try {
      const port = await freePort();
      const p = run({ SERVERMIN_MANAGER_CONFIG: join(dir, 'none.json'), SERVERMIN_MANAGER_DATA_DIR: join(dir, 'data'), SERVERMIN_MANAGER_HOST: '127.0.0.1', SERVERMIN_MANAGER_PORT: String(port) });
      const health = await waitFor(() => fetch(`http://127.0.0.1:${port}/api/v1/health`).then((r) => r.json()).catch(() => null), (h) => !!h, 10_000);
      expect(health).toMatchObject({ service: 'manager', status: 'HEALTHY' });
      const token = readFileSync(join(dir, 'data/setup-token'), 'utf8').trim();
      expect(p.output()).toContain(`Create one with this setup token: ${token}`);
      p.child.kill('SIGTERM');
      expect(await p.exited).toBe(0);
      expect(p.output()).toContain('Shutting down');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('exits with a configuration error that names the problem, without a stack trace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'servermin-mgr-bin-'));
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ http: { port: 99999 } }));
      const p = run({ SERVERMIN_MANAGER_CONFIG: join(dir, 'config.json') });
      expect(await p.exited).toBe(78);
      expect(p.output()).toMatch(/^servermin-manager: Invalid Manager configuration:\n {2}http\.port must be 0-65535\n$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says so when its port is taken', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'servermin-mgr-bin-'));
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    try {
      const port = (blocker.address() as { port: number }).port;
      const p = run({ SERVERMIN_MANAGER_CONFIG: join(dir, 'none.json'), SERVERMIN_MANAGER_DATA_DIR: join(dir, 'data'), SERVERMIN_MANAGER_HOST: '127.0.0.1', SERVERMIN_MANAGER_PORT: String(port) });
      expect(await p.exited).toBe(1);
      expect(p.output()).toContain(`port ${port} is already in use`);
    } finally {
      blocker.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('contains nothing that could run a command on a server', () => {
    const code = readFileSync(bundle, 'utf8');
    for (const forbidden of ['servermin-privileged', 'sudo', 'child_process', 'worker_threads']) expect(code, forbidden).not.toContain(forbidden);
  });
});
