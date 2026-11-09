import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { example, fixture, startServer, waitFor, type TestServer } from './helpers';

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const state = async (s: TestServer, id: string) => (await s.api('GET', `/api/v1/platform/modules/${id}`)).body?.state;

describe('mandatory lifecycle scenario (§42)', () => {
  it('start core → install → enable → use → reload → disable → enable → remove', async () => {
    server = await startServer();
    const s = server;
    // Start Core: running with zero modules.
    expect((await s.api('GET', '/api/v1/health')).body.status).toBe('HEALTHY');
    expect((await s.api('GET', '/api/v1/platform/modules')).body).toEqual([]);

    // Install Module (it is enabled and activated as part of installation).
    const install = await s.api('POST', '/api/v1/platform/modules', { source: 'directory', path: example('hello') });
    expect(install.status).toBe(200);
    expect(install.body.module.state).toBe('ACTIVE');
    expect(install.body.module.integrity).toBe('verified');

    // Use Module.
    const post = await s.api('POST', '/api/v1/modules/hello/greeting', { name: 'Grace' });
    expect(post.body.message).toBe('Hello, Grace!');
    const routes = (await s.api('GET', '/api/v1/platform/modules/hello')).body.runtime.routes;
    expect(routes.map((r: any) => `${r.method} ${r.path}`)).toEqual(['GET /greeting', 'POST /greeting']);

    // Reload Module: hot reload without restarting the core; data persists.
    const before = (await s.api('GET', '/api/v1/platform/modules/hello')).body.revision;
    const reload = await s.api('POST', '/api/v1/platform/modules/hello/reload');
    expect(reload.body.state).toBe('ACTIVE');
    expect(reload.body.revision).toBe(before + 1);
    expect((await s.api('GET', '/api/v1/modules/hello/greeting')).body.recent[0].name).toBe('Grace');

    // Disable Module: its routes disappear and the API explains why.
    expect((await s.api('POST', '/api/v1/platform/modules/hello/disable')).body.state).toBe('DISABLED');
    const disabled = await s.api('GET', '/api/v1/modules/hello/greeting');
    expect(disabled.status).toBe(503);
    expect(disabled.body.details.reason).toBe('module-disabled');
    expect((await s.api('GET', '/api/v1/platform/frontend')).body[0].script).toBeNull();

    // Enable Module.
    expect((await s.api('POST', '/api/v1/platform/modules/hello/enable')).body.state).toBe('ACTIVE');
    expect((await s.api('GET', '/api/v1/modules/hello/greeting')).status).toBe(200);

    // Settings are validated, stored and pushed to the running module.
    expect((await s.api('PUT', '/api/v1/platform/modules/hello/config', { greeting: 'x'.repeat(50) })).status).toBe(400);
    expect((await s.api('PUT', '/api/v1/platform/modules/hello/config', { greeting: 'Howdy' })).status).toBe(200);
    expect((await s.api('GET', '/api/v1/modules/hello/greeting')).body.message).toBe('Howdy, world');

    // Remove Module (keeping data), then reinstall: the data is still there.
    const removed = await s.api('DELETE', '/api/v1/platform/modules/hello');
    expect(removed.body).toMatchObject({ removed: 'hello', dataDeleted: false });
    expect((await s.api('GET', '/api/v1/modules/hello/greeting')).body.details.reason).toBe('module-missing');
    await s.api('POST', '/api/v1/platform/modules', { source: 'directory', path: example('hello') });
    expect((await s.api('GET', '/api/v1/modules/hello/greeting')).body.recent[0].name).toBe('Grace');

    // Remove with data deletion.
    await s.api('DELETE', '/api/v1/platform/modules/hello?deleteData=true');
    await s.api('POST', '/api/v1/platform/modules', { source: 'directory', path: example('hello') });
    expect((await s.api('GET', '/api/v1/modules/hello/greeting')).body.recent).toEqual([]);

    // Everything was audited.
    const actions = (await s.api('GET', '/api/v1/audit?limit=100')).body.map((a: any) => a.action);
    for (const a of ['module.install', 'hello.greet', 'module.reload', 'module.disable', 'module.enable', 'module.configure', 'module.remove']) expect(actions).toContain(a);
    expect((await s.api('GET', '/api/v1/health')).body.status).toBe('HEALTHY');
  });
});

describe('failure scenario (§42, §60)', () => {
  it('a crashing module does not affect the core or other modules, and recovers on reload', async () => {
    server = await startServer();
    const s = server;
    await s.api('POST', '/api/v1/platform/modules', { source: 'directory', path: example('hello') });
    await s.api('POST', '/api/v1/platform/modules', { source: 'directory', path: fixture('faulty') });
    expect((await s.api('GET', '/api/v1/modules/faulty/ok')).body.ok).toBe(true);

    // Force Module Failure: an uncaught exception in the module's thread.
    await s.api('POST', '/api/v1/modules/faulty/crash');
    await waitFor(() => state(s, 'faulty'), (v) => v === 'ERROR');
    const failed = (await s.api('GET', '/api/v1/platform/modules/faulty')).body;
    expect(failed.error).toMatch(/boom/);

    // Verify Core and other modules.
    expect((await s.api('GET', '/api/v1/health')).body.status).toBe('DEGRADED');
    expect((await s.api('GET', '/api/v1/modules/hello/greeting')).status).toBe(200);
    expect((await s.api('GET', '/api/v1/modules/faulty/ok')).body.details.reason).toBe('module-error');
    // Its logs stay available for repair.
    const logs = (await s.api('GET', '/api/v1/platform/modules/faulty/logs')).body;
    expect(logs.some((l: any) => /boom/.test(l.message))).toBe(true);
    // A notification was raised.
    expect((await s.api('GET', '/api/v1/notifications')).body.items[0].title).toMatch(/Faulty failed/);

    // Reload Failed Module → Verify Recovery.
    expect((await s.api('POST', '/api/v1/platform/modules/faulty/reload')).body.state).toBe('ACTIVE');
    expect((await s.api('GET', '/api/v1/modules/faulty/ok')).body.ok).toBe(true);
    expect((await s.api('GET', '/api/v1/health')).body.status).toBe('HEALTHY');
  });

  it('a module exceeding its memory limit is terminated in isolation', async () => {
    server = await startServer();
    const s = server;
    await s.api('POST', '/api/v1/platform/modules', { source: 'directory', path: fixture('faulty') });
    await s.api('POST', '/api/v1/modules/faulty/leak');
    await waitFor(() => state(s, 'faulty'), (v) => v === 'ERROR', 20_000);
    expect((await s.api('GET', '/api/v1/health')).status).toBe(200);
  });

  it('slow handlers time out and failing start leaves the module in ERROR', async () => {
    server = await startServer();
    const s = server;
    await s.api('POST', '/api/v1/platform/modules', { source: 'directory', path: fixture('faulty') });
    expect((await s.api('GET', '/api/v1/modules/faulty/slow')).status).toBe(504);
    const refused = await s.api('GET', '/api/v1/modules/faulty/undeclared');
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/not declared/);
    await s.api('PUT', '/api/v1/platform/modules/faulty/config', { failOnStart: true });
    const r = await s.api('POST', '/api/v1/platform/modules/faulty/restart');
    expect(r.body.state).toBe('ERROR');
    expect(r.body.error).toMatch(/configured to fail/);
    await s.api('PUT', '/api/v1/platform/modules/faulty/config', { failOnStart: false });
    expect((await s.api('POST', '/api/v1/platform/modules/faulty/reload')).body.state).toBe('ACTIVE');
  });
});

describe('dependencies and services (§18, §61)', () => {
  it('a consumer waits for its capability and stops when the provider goes away', async () => {
    server = await startServer();
    const s = server;
    const consumer = await s.api('POST', '/api/v1/platform/modules', { source: 'directory', path: fixture('echo-consumer') });
    expect(consumer.body.module.state).toBe('BLOCKED');
    expect(consumer.body.module.blockedBy[0]).toMatch(/demo.echo/);
    expect((await s.api('GET', '/api/v1/modules/echo-consumer/echo')).body.details.reason).toBe('dependency-unavailable');

    await s.api('POST', '/api/v1/platform/modules', { source: 'directory', path: fixture('echo-provider') });
    expect(await state(s, 'echo-consumer')).toBe('ACTIVE');
    expect((await s.api('GET', '/api/v1/modules/echo-consumer/echo?v=42')).body).toEqual({ echoed: '42', by: 'echo-provider' });

    await s.api('POST', '/api/v1/platform/modules/echo-provider/disable');
    expect(await state(s, 'echo-consumer')).toBe('BLOCKED');
    await s.api('POST', '/api/v1/platform/modules/echo-provider/enable');
    expect(await state(s, 'echo-consumer')).toBe('ACTIVE');
    expect((await s.api('GET', '/api/v1/health')).body.status).toBe('HEALTHY');
  });
});

describe('routing', () => {
  it('serves shell routes under /modules/ and only module assets under /modules/<id>/assets/', async () => {
    server = await startServer();
    const s = server;
    await s.api('POST', '/api/v1/platform/modules', { source: 'directory', path: example('hello') });
    // No shell is built in the test server, so the SPA fallback answers 503 — but it must not be a 404 from the asset handler.
    expect((await fetch(`${s.url}/modules/hello`)).status).toBe(503);
    expect((await fetch(`${s.url}/modules/hello/assets/dist/frontend.js`, { headers: { cookie: s.cookie } })).status).toBe(200);
    expect((await fetch(`${s.url}/modules/hello/assets/dist/frontend.js`)).status).toBe(401);
    expect((await fetch(`${s.url}/modules/hello/assets/module.json`, { headers: { cookie: s.cookie } })).status).toBe(404);
  });
});

describe('permissions (§19)', () => {
  it('enforces route permissions per user', async () => {
    server = await startServer();
    const s = server;
    await s.api('POST', '/api/v1/platform/modules', { source: 'directory', path: example('hello') });
    expect((await s.api('POST', '/api/v1/users', { username: 'viewer', password: 'viewer-pass-1', permissions: ['hello.read'] })).status).toBe(200);
    const login = await fetch(`${s.url}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-servermin-request': '1' }, body: JSON.stringify({ username: 'viewer', password: 'viewer-pass-1' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    expect((await s.api('GET', '/api/v1/modules/hello/greeting', undefined, { cookie })).status).toBe(200);
    const denied = await s.api('POST', '/api/v1/modules/hello/greeting', { name: 'x' }, { cookie });
    expect(denied.status).toBe(403);
    expect((await s.api('POST', '/api/v1/platform/modules/hello/disable', undefined, { cookie })).status).toBe(403);
    expect((await s.api('GET', '/api/v1/users', undefined, { cookie })).status).toBe(403);
    expect((await s.api('GET', '/api/v1/modules/hello/greeting', undefined, { cookie: '' })).status).toBe(401);
  });

  it('locks out repeated failed logins', async () => {
    server = await startServer();
    const s = server;
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await s.api('POST', '/api/v1/auth/login', { username: 'admin', password: 'wrong' }, { cookie: '' })).status;
    expect(last).toBe(429);
  });
});

describe('WebSocket channels (§28)', () => {
  it('delivers channel data and closes subscriptions when the module unloads', async () => {
    server = await startServer();
    const s = server;
    await s.api('POST', '/api/v1/platform/modules', { source: 'directory', path: example('hello') });
    await s.api('PUT', '/api/v1/platform/modules/hello/config', { tickMs: 250 });
    const ws = new WebSocket(`${s.url.replace('http', 'ws')}/api/v1/ws`, { headers: { cookie: s.cookie, origin: s.url } });
    const messages: any[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'subscribe', id: 'a', channel: 'hello.ticks' }));
    ws.send(JSON.stringify({ type: 'subscribe', id: 'b', channel: 'nope.channel' }));
    await waitFor(() => messages.filter((m) => m.type === 'data' && m.id === 'a').length, (n) => n >= 2);
    expect(messages.find((m) => m.id === 'b')).toMatchObject({ type: 'error' });
    await s.api('POST', '/api/v1/platform/modules/hello/disable');
    await waitFor(() => messages.find((m) => m.type === 'closed' && m.id === 'a'), Boolean);
    ws.close();
  });

  it('rejects unauthenticated and cross-origin connections', async () => {
    server = await startServer();
    const s = server;
    const attempt = (headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(`${s.url.replace('http', 'ws')}/api/v1/ws`, { headers });
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('open', () => (ws.close(), resolve(101)));
      });
    expect(await attempt({})).toBe(401);
    expect(await attempt({ cookie: s.cookie, origin: 'http://evil.example' })).toBe(403);
    expect(await attempt({ cookie: s.cookie, origin: s.url })).toBe(101);
  });
});
