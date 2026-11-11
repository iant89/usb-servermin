import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { AgentKey, ManagerLink, type LinkStatus } from '../../packages/core/src/index';
import { AGENT_ENDPOINT, CLOSE, MAX_FRAME_BYTES, authSigningInput, createMessage, encode, type Message } from '../../packages/protocol/src/index';
import { ROOT, fixture, startServer, waitFor, type TestServer } from './helpers';
import { startManager, type TestManager } from './manager-helpers';

const FAST = { agents: { heartbeatSeconds: 0.2, timeoutSeconds: 1, handshakeSeconds: 1 } };
const QUICK = { minMs: 40, maxMs: 200, stableMs: 300, refusedScale: 0.005 };

let m: TestManager | undefined;
let agents: TestServer[] = [];
let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => undefined);
  cleanups = [];
  for (const a of agents) await a.stop().catch(() => undefined);
  agents = [];
  await m?.stop().catch(() => undefined);
  m = undefined;
});

const wsUrl = (t: TestManager) => t.url.replace(/^http/, 'ws');
const server = async (t: TestManager, id: string) => (await t.api('GET', `/api/v1/servers/${id}`)).body;
const untilState = (t: TestManager, id: string, state: string, timeoutMs = 8000) => waitFor(() => server(t, id), (s) => s?.state === state, timeoutMs);

/** A real agent (the core platform) pointed at the Manager. */
async function startAgent(t: TestManager, extra: Record<string, unknown> = {}) {
  const a = await startServer({}, { config: { agent: { stateDir: null, manager: { url: wsUrl(t), fingerprint: null, ca: null, insecure: true, ...extra } } }, linkBackoff: QUICK });
  agents.push(a);
  return a;
}
const link = async (a: TestServer): Promise<LinkStatus> => (await a.api('GET', '/api/v1/agent')).body.manager;

async function enrol(t: TestManager, a: TestServer, name = 'Saturn', id?: string) {
  const created = (await t.api('POST', '/api/v1/servers', { name, ...(id ? { id } : { id: a.platform.agent.identity.serverId }) })).body;
  const r = await t.api('PUT', `/api/v1/servers/${created.id}/agent`, { agentId: a.platform.agent.identity.agentId, publicKey: a.platform.agent.key.publicKey });
  expect(r.status).toBe(200);
  return created.id as string;
}

describe('agent and manager', () => {
  it('connects on its own once enrolled, and the Manager shows the server online with its version and capabilities', async () => {
    m = await startManager({ config: FAST });
    const a = await startAgent(m);
    // Not enrolled yet: refused, and it keeps trying.
    const waiting = await waitFor(() => link(a), (l) => l.attempts >= 2);
    expect(waiting).toMatchObject({ configured: true, state: expect.stringMatching(/WAITING|CONNECTING|AUTHENTICATING/), connectedSince: null });
    expect(waiting.lastError).toMatch(/refused: Not authorized \(unauthorized\)|Not authorized/);
    expect(waiting.url).toBe(`${wsUrl(m)}${AGENT_ENDPOINT}`);

    const id = await enrol(m, a);
    expect((await server(m, id)).state).toBe('OFFLINE'); // enrolled, not yet seen
    const online = await untilState(m, id, 'ONLINE');
    expect(online).toMatchObject({ agentId: a.platform.agent.identity.agentId, agentVersion: (await a.api('GET', '/api/v1/health')).body.version, agentKeyFingerprint: a.platform.agent.key.fingerprint, capabilities: [] });
    expect(online.lastSeenAt).toBeTruthy();
    expect(await link(a)).toMatchObject({ state: 'CONNECTED', protocolVersion: 1, lastError: null });

    // Capabilities follow the agent's modules without anyone asking.
    await a.api('POST', '/api/v1/platform/modules', { source: 'directory', path: fixture('echo-provider') });
    expect((await waitFor(() => server(m!, id), (s) => s.capabilities.length > 0)).capabilities).toEqual(['demo.echo', 'echo-provider']);
    expect((await m.api('GET', '/api/v1/manager')).body.agents).toEqual({ authenticated: 1, pending: 0 });

    const audit = (await m.api('GET', '/api/v1/audit?action=agent.authenticate')).body;
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]).toMatchObject({ result: 'failure', target: a.platform.agent.identity.agentId, metadata: { reason: 'agent is not enrolled' } });
  });

  it('survives the Manager going away and coming back, without anyone touching the agent', async () => {
    m = await startManager({ config: FAST });
    const a = await startAgent(m);
    const id = await enrol(m, a);
    await untilState(m, id, 'ONLINE');

    await m.manager.stop();
    const down = await waitFor(() => link(a), (l) => l.state !== 'CONNECTED' && l.attempts >= 2);
    expect(down.lastError).toMatch(/connection refused|connection lost|Manager stopping|Manager is stopping/);
    expect(down.nextAttemptAt === null || Date.parse(down.nextAttemptAt) > Date.now() - 1000).toBe(true);
    // The server itself is unaffected by losing its Manager.
    expect((await a.api('GET', '/api/v1/health')).body.status).toBe('HEALTHY');

    await m.restart();
    expect((await server(m, id)).state).toMatch(/OFFLINE|ONLINE/); // never a stale ONLINE from before the restart
    await untilState(m, id, 'ONLINE');
    expect(await link(a)).toMatchObject({ state: 'CONNECTED', lastError: null });
  });

  it('shows a server offline as soon as its agent stops, and online again when it returns', async () => {
    m = await startManager({ config: FAST });
    const a = await startAgent(m);
    const id = await enrol(m, a);
    await untilState(m, id, 'ONLINE');
    a.platform.link.stop();
    await untilState(m, id, 'OFFLINE', 2000);
    a.platform.link.start();
    await untilState(m, id, 'ONLINE');
  });

  it('reports a degraded server as DEGRADED', async () => {
    m = await startManager({ config: FAST });
    const a = await startAgent(m);
    const id = await enrol(m, a);
    await untilState(m, id, 'ONLINE');
    await a.api('POST', '/api/v1/platform/modules', { source: 'directory', path: fixture('faulty') });
    await waitFor(() => server(m!, id), (s) => s.capabilities.includes('faulty'));
    await a.api('POST', '/api/v1/modules/faulty/crash').catch(() => undefined);
    const degraded = await untilState(m, id, 'DEGRADED');
    expect(degraded.capabilities).not.toContain('faulty');
  });

  it('cuts off a revoked agent at once and does not let it back in', async () => {
    m = await startManager({ config: FAST });
    const a = await startAgent(m);
    const id = await enrol(m, a);
    await untilState(m, id, 'ONLINE');
    const revoked = await m.api('DELETE', `/api/v1/servers/${id}/agent`);
    expect(revoked.body).toMatchObject({ state: 'UNKNOWN', agentId: null, agentKeyFingerprint: null, capabilities: [] });
    await waitFor(() => link(a), (l) => l.state !== 'CONNECTED' && /Not authorized|no longer enrolled/.test(l.lastError ?? ''));
    await new Promise((r) => setTimeout(r, 600));
    expect((await server(m, id)).state).toBe('UNKNOWN');
    expect((await m.api('GET', '/api/v1/manager')).body.agents.authenticated).toBe(0);
    expect((await m.api('DELETE', `/api/v1/servers/${id}/agent`)).status).toBe(409);
    const actions = (await m.api('GET', '/api/v1/audit?search=agent.')).body.map((x: any) => `${x.action}:${x.result}`);
    expect(actions).toEqual(expect.arrayContaining(['agent.enrol:success', 'agent.revoke:success', 'agent.revoke:failure', 'agent.authenticate:failure']));
  });

  it('drops the connection when the server is removed from the inventory', async () => {
    m = await startManager({ config: FAST });
    const a = await startAgent(m);
    const id = await enrol(m, a);
    await untilState(m, id, 'ONLINE');
    await m.api('DELETE', `/api/v1/servers/${id}`);
    await waitFor(() => link(a), (l) => l.state !== 'CONNECTED');
    expect((await m.api('GET', '/api/v1/manager')).body.agents.authenticated).toBe(0);
  });

  it('makes the agent adopt the server id the Manager knows it by, and keeps it', async () => {
    m = await startManager({ config: FAST });
    const a = await startAgent(m);
    const own = a.platform.agent.identity.serverId;
    const known = '0b9f3c1e-2d4a-4f6b-8c7d-9e0f1a2b3c4d';
    await enrol(m, a, 'Saturn', known);
    await untilState(m, known, 'ONLINE');
    await waitFor(() => a.platform.agent.identity.serverId, (s) => s === known);
    expect(own).not.toBe(known);
    expect(JSON.parse(readFileSync(join(a.dir, 'var/lib/servermin/agent/identity.json'), 'utf8'))).toMatchObject({ serverId: known, agentId: a.platform.agent.identity.agentId });
  });

  it('refuses to enrol what is not an agent key, or an agent that belongs to another server', async () => {
    m = await startManager({ config: FAST });
    const a = await startAgent(m);
    const id = await enrol(m, a);
    const other = (await m.api('POST', '/api/v1/servers', { name: 'Jupiter' })).body.id;
    const agentId = a.platform.agent.identity.agentId;
    const rsa = (generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
    for (const [body, status] of [
      [{ agentId, publicKey: a.platform.agent.key.publicKey }, 409],
      [{ agentId: 'saturn', publicKey: a.platform.agent.key.publicKey }, 400],
      [{ agentId: '3f0e7a52-4a67-4c0e-9d6b-0f3c5a1b2c3d', publicKey: 'AAAA' }, 400],
      [{ agentId: '3f0e7a52-4a67-4c0e-9d6b-0f3c5a1b2c3d', publicKey: rsa }, 400],
      [{ agentId: '3f0e7a52-4a67-4c0e-9d6b-0f3c5a1b2c3d' }, 400],
    ] as const)
      expect((await m.api('PUT', `/api/v1/servers/${other}/agent`, body)).status, JSON.stringify(body).slice(0, 60)).toBe(status);
    expect((await server(m, other)).agentId).toBeNull();
    const viewer = await (async () => {
      await m!.api('POST', '/api/v1/users', { username: 'vera', password: 'test-password-2', permissions: ['servers.read'] });
      return (await m!.api('POST', '/api/v1/auth/login', { username: 'vera', password: 'test-password-2' }, { cookie: '' })).setCookie!.split(';')[0];
    })();
    expect((await m.api('PUT', `/api/v1/servers/${other}/agent`, { agentId: '3f0e7a52-4a67-4c0e-9d6b-0f3c5a1b2c3d', publicKey: a.platform.agent.key.publicKey }, { cookie: viewer })).status).toBe(403);
    expect((await m.api('DELETE', `/api/v1/servers/${id}/agent`, undefined, { cookie: viewer })).status).toBe(403);
  });
});

// ── The Manager against clients that do not behave ───────────────────────────────

interface Raw {
  ws: WebSocket;
  messages: Message[];
  closed: Promise<{ code: number; reason: string }>;
  next(type: string, timeoutMs?: number): Promise<Message>;
}
function raw(url: string, opts: Record<string, unknown> = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url + AGENT_ENDPOINT, { rejectUnauthorized: false, ...opts });
    const messages: Message[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
    const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
    const r: Raw = { ws, messages, closed, next: (type, timeoutMs = 3000) => waitFor(() => messages.find((x) => x.type === type), (x) => !!x, timeoutMs) as Promise<Message> };
    ws.on('open', () => resolve(r));
    ws.on('unexpected-response', (_q, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
    cleanups.push(() => ws.terminate());
  });
}

/** Enrols a key directly and returns what a client needs to authenticate with it. */
function enrolKey(t: TestManager, name: string) {
  const dir = mkdtempSync(join(tmpdir(), 'servermin-key-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const { key } = AgentKey.load(dir);
  const agentId = crypto.randomUUID();
  const s = t.manager.inventory.create({ name });
  t.manager.inventory.enrolAgent(s.id, { agentId, publicKey: key.publicKey });
  const auth = (hello: Message, over: Record<string, unknown> = {}, tlsFingerprint = '') => {
    const nonce = (hello.payload as any).nonce;
    return createMessage('AUTHENTICATION', { agentId, serverId: s.id, version: 1, signature: key.sign(authSigningInput({ nonce, agentId, serverId: s.id, version: 1, tlsFingerprint })), ...over } as any);
  };
  return { key, agentId, serverId: s.id, auth };
}
async function authenticated(t: TestManager, name = 'Saturn') {
  const e = enrolKey(t, name);
  const c = await raw(wsUrl(t));
  c.ws.send(encode(e.auth(await c.next('HELLO'))));
  await c.next('AUTHENTICATED');
  return { ...e, c };
}

describe('manager agent endpoint', () => {
  it('speaks first, with a fresh nonce per connection, and answers heartbeats by id', async () => {
    m = await startManager({ config: FAST });
    const { c, serverId } = await authenticated(m);
    const other = await raw(wsUrl(m));
    const [h1, h2] = [await c.next('HELLO'), await other.next('HELLO')];
    expect((h1.payload as any).nonce).not.toBe((h2.payload as any).nonce);
    expect(h1.payload).toMatchObject({ versions: [1], manager: { version: expect.any(String) } });
    expect((c.messages.find((x) => x.type === 'AUTHENTICATED')!.payload as any)).toMatchObject({ serverId, heartbeatIntervalMs: 200, heartbeatTimeoutMs: 1000 });
    const beat = createMessage('HEARTBEAT', { seq: 7 });
    c.ws.send(encode(beat));
    const ack = await c.next('HEARTBEAT');
    expect(ack).toMatchObject({ correlationId: beat.id, payload: { seq: 7 } });
    expect((await server(m, serverId)).state).toBe('ONLINE');
  });

  it('gives the same answer to a wrong key, an unknown agent and a replayed signature', async () => {
    m = await startManager({ config: FAST });
    const e = enrolKey(m, 'Saturn');
    const outcomes: string[] = [];
    const attempt = async (build: (hello: Message) => Message) => {
      const c = await raw(wsUrl(m!));
      c.ws.send(encode(build(await c.next('HELLO'))));
      const closed = await c.closed;
      const error = c.messages.find((x) => x.type === 'ERROR')!.payload as any;
      outcomes.push(`${closed.code} ${error.code} ${error.message}`);
      expect(c.messages.some((x) => x.type === 'AUTHENTICATED')).toBe(false);
    };
    const stranger = generateKeyPairSync('ed25519').privateKey;
    // Signed with a key that is not the enrolled one.
    await attempt((hello) => e.auth(hello, { signature: sign(null, authSigningInput({ nonce: (hello.payload as any).nonce, agentId: e.agentId, serverId: e.serverId, version: 1, tlsFingerprint: '' }), stranger).toString('base64') }));
    // An agent id nobody enrolled.
    await attempt((hello) => e.auth(hello, { agentId: crypto.randomUUID() }));
    // A valid signature captured from one connection, presented on another.
    const first = await raw(wsUrl(m));
    const captured = e.auth(await first.next('HELLO'));
    await attempt(() => captured);
    // The right key, claiming to be a different server than it signed for.
    await attempt((hello) => e.auth(hello, { serverId: crypto.randomUUID() }));
    expect(new Set(outcomes)).toEqual(new Set([`${CLOSE.unauthorized} unauthorized Not authorized`]));
    expect((await server(m, e.serverId)).state).toBe('OFFLINE');
    const reasons = (await m.api('GET', '/api/v1/audit?action=agent.authenticate')).body.map((x: any) => x.metadata.reason);
    expect(reasons.sort()).toEqual(['agent is not enrolled', 'signature does not match the enrolled key', 'signature does not match the enrolled key', 'signature does not match the enrolled key']);
  });

  it('accepts nothing before authentication and gives up on a silent connection', async () => {
    m = await startManager({ config: FAST });
    const early = await raw(wsUrl(m));
    await early.next('HELLO');
    early.ws.send(encode(createMessage('HEARTBEAT', { seq: 1 })));
    expect((await early.closed).code).toBe(CLOSE.unauthorized);
    const junk = await raw(wsUrl(m));
    junk.ws.send('{"type":"COMMAND"');
    expect((await junk.closed).code).toBe(CLOSE.unauthorized);
    const silent = await raw(wsUrl(m));
    const started = Date.now();
    expect((await silent.closed).code).toBe(CLOSE.timeout);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect((await m.api('GET', '/api/v1/manager')).body.agents).toEqual({ authenticated: 0, pending: 0 });
  });

  it('refuses a protocol version it does not speak, and a browser', async () => {
    m = await startManager({ config: FAST });
    const e = enrolKey(m, 'Saturn');
    const c = await raw(wsUrl(m));
    c.ws.send(encode(e.auth(await c.next('HELLO'), { version: 99 })));
    expect((await c.closed).code).toBe(CLOSE.protocolVersion);
    expect((c.messages.find((x) => x.type === 'ERROR')!.payload as any).code).toBe('protocol-version');
    await expect(raw(wsUrl(m), { headers: { origin: m.url, cookie: m.cookie } })).rejects.toThrow('HTTP 403');
  });

  it('marks a server STALE when heartbeats stop, then OFFLINE, and closes the connection', async () => {
    m = await startManager({ config: FAST });
    const { c, serverId } = await authenticated(m);
    expect((await server(m, serverId)).state).toBe('ONLINE');
    await untilState(m, serverId, 'STALE', 2000);
    // A heartbeat in time brings it back.
    c.ws.send(encode(createMessage('HEARTBEAT', { seq: 1 })));
    await untilState(m, serverId, 'ONLINE', 1000);
    await untilState(m, serverId, 'STALE', 2000);
    await untilState(m, serverId, 'OFFLINE', 3000);
    expect((await c.closed).code).toBe(CLOSE.timeout);
  });

  it('ends a connection that sends malformed, binary or oversized frames, but only answers an unknown type', async () => {
    m = await startManager({ config: FAST });
    const a = await authenticated(m, 'A');
    a.c.ws.send(encode(createMessage('METRIC', { cpu: 1 } as any)));
    expect(((await a.c.next('ERROR')).payload as any).code).toBe('unsupported');
    a.c.ws.send(JSON.stringify({ ...createMessage('HEARTBEAT', { seq: 1 }), type: 'RUN_SHELL' }));
    await waitFor(() => a.c.messages.filter((x) => x.type === 'ERROR'), (l) => l.length === 2);
    expect(a.c.ws.readyState).toBe(WebSocket.OPEN);
    expect((await server(m, a.serverId)).state).toBe('ONLINE');
    a.c.ws.send('{"v":1,"id":"x","type":"HEARTBEAT","ts":"nope","payload":{}}');
    expect((await a.c.closed).code).toBe(CLOSE.malformed);
    await untilState(m, a.serverId, 'OFFLINE', 1000);

    const b = await authenticated(m, 'B');
    b.c.ws.send(Buffer.from([1, 2, 3]));
    expect((await b.c.closed).code).toBe(CLOSE.malformed);

    const c = await authenticated(m, 'C');
    c.c.ws.send(JSON.stringify({ ...createMessage('HEARTBEAT', { seq: 1 }), pad: 'x'.repeat(MAX_FRAME_BYTES) }));
    expect([1009, 1006]).toContain((await c.c.closed).code);
    await untilState(m, c.serverId, 'OFFLINE', 1000);
  });

  it('closes a connection that floods it', async () => {
    m = await startManager({ config: FAST });
    const { c } = await authenticated(m);
    for (let i = 0; i < 400; i++) c.ws.send(encode(createMessage('HEARTBEAT', { seq: i })));
    expect((await c.closed).code).toBe(CLOSE.rateLimited);
  });

  it('keeps one connection per agent: a second one replaces the first and the server stays online', async () => {
    m = await startManager({ config: FAST });
    const first = await authenticated(m);
    const second = await raw(wsUrl(m));
    second.ws.send(encode(first.auth(await second.next('HELLO'))));
    await second.next('AUTHENTICATED');
    expect((await first.c.closed).code).toBe(CLOSE.replaced);
    expect((await server(m, first.serverId)).state).toBe('ONLINE');
    expect((await m.api('GET', '/api/v1/manager')).body.agents.authenticated).toBe(1);
  });

  it('starts every server OFFLINE or UNKNOWN after a restart, never ONLINE from memory', async () => {
    m = await startManager({ config: FAST });
    const { serverId, c } = await authenticated(m);
    const bare = m.manager.inventory.create({ name: 'Bare' });
    c.ws.terminate();
    m.manager.inventory.setConnection(serverId, { state: 'ONLINE' }); // as if the Manager had been killed while connected
    expect(m.manager.inventory.setConnection(bare.id, { state: 'ONLINE' })!.state).toBe('UNKNOWN'); // no agent, no connection state
    await m.restart();
    expect((await server(m, serverId)).state).toBe('OFFLINE');
    expect((await server(m, bare.id)).state).toBe('UNKNOWN');
  });
});

// ── The agent against a Manager that does not behave ─────────────────────────────

describe('agent link', () => {
  async function fakeManager(onConnection: (ws: WebSocket, n: number) => void) {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    let n = 0;
    wss.on('connection', (ws) => onConnection(ws, ++n));
    cleanups.push(() => new Promise((r) => (wss.clients.forEach((c) => c.terminate()), wss.close(() => r(undefined)))));
    return { url: `ws://127.0.0.1:${(wss.address() as any).port}`, count: () => n };
  }
  function makeLink(url: string, over: Record<string, unknown> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'servermin-link-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const warnings: string[] = [];
    const identity: { agentId: string; serverId: string; createdAt: string } = { agentId: crypto.randomUUID(), serverId: crypto.randomUUID(), createdAt: new Date().toISOString() };
    const l = new ManagerLink({
      url,
      identity: () => identity,
      key: AgentKey.load(dir).key,
      serverState: async () => ({ name: 'n', hostname: 'h', agentVersion: '1.0.0', os: 'os', health: 'HEALTHY', state: 'RUNNING' }),
      capabilities: () => [],
      adoptServerId: (id) => void (identity.serverId = id),
      logger: { debug() {}, info() {}, warn: (x) => void warnings.push(x), error() {} },
      backoff: { minMs: 20, maxMs: 160, stableMs: 200, refusedScale: 0.001 },
      handshakeTimeoutMs: 250,
      random: () => 1,
      ...over,
    });
    cleanups.push(() => l.stop());
    return { link: l, warnings, identity };
  }
  const hello = (versions = [1]) => encode(createMessage('HELLO', { versions, nonce: Buffer.alloc(32, 1).toString('base64'), manager: { version: '9.9.9' } }));

  it('is disabled without a URL and builds the endpoint from any spelling of one', () => {
    const { link: none } = makeLink(null as any);
    none.start();
    expect(none.status()).toMatchObject({ configured: false, state: 'DISABLED', url: null });
    expect(ManagerLink.endpointFor('https://m.example:8480/')).toBe('wss://m.example:8480/api/v1/agents/ws');
    expect(ManagerLink.endpointFor('wss://m.example/some/path?x=1#y')).toBe('wss://m.example/api/v1/agents/ws');
    expect(ManagerLink.endpointFor('http://127.0.0.1:8480')).toBe('ws://127.0.0.1:8480/api/v1/agents/ws');
  });

  it('backs off exponentially up to the limit while nothing answers, and stops when told to', async () => {
    const port = await new Promise<number>((r) => {
      const s = createNetServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as any).port;
        s.close(() => r(p));
      });
    });
    const { link: l } = makeLink(`ws://127.0.0.1:${port}`);
    l.start();
    const delays: number[] = [];
    let seen = 0;
    await waitFor(() => {
      const s = l.status();
      if (s.state === 'WAITING' && s.attempts > seen && s.nextAttemptAt) (seen = s.attempts), delays.push(Date.parse(s.nextAttemptAt) - Date.now());
      return s.attempts;
    }, (n) => n >= 6, 5000);
    expect(l.status().lastError).toMatch(/connection refused/);
    // 20, 40, 80, 160, 160 … with the jitter fixed at its maximum.
    expect(delays[0]).toBeLessThanOrEqual(25);
    expect(Math.max(...delays)).toBeLessThanOrEqual(165);
    expect(delays.at(-1)).toBeGreaterThan(100);
    l.stop();
    const attempts = l.status().attempts;
    await new Promise((r) => setTimeout(r, 400));
    expect(l.status()).toMatchObject({ state: 'STOPPED', attempts, nextAttemptAt: null });
  });

  it('gives up on something that accepts the connection but is not a Manager', async () => {
    const fake = await fakeManager(() => undefined);
    const { link: l } = makeLink(fake.url);
    l.start();
    await waitFor(() => fake.count(), (n) => n >= 3, 5000);
    expect(l.status().lastError).toMatch(/did not complete the handshake/);
    expect(l.status().connectedSince).toBeNull();
  });

  it('drops a Manager that sends rubbish and one that speaks no common protocol version', async () => {
    const rubbish = await fakeManager((ws) => ws.send('{"hello":'));
    const a = makeLink(rubbish.url);
    a.link.start();
    await waitFor(() => rubbish.count(), (n) => n >= 2, 5000);
    expect(a.warnings.join('\n')).toMatch(/invalid message: Frame is not JSON/);

    const future = await fakeManager((ws) => ws.send(hello([98, 99])));
    const b = makeLink(future.url);
    b.link.start();
    await waitFor(() => b.link.status(), (s) => /protocol versions 98, 99/.test(s.lastError ?? '') || b.warnings.some((w) => /protocol versions 98, 99/.test(w)), 5000);
    expect(b.link.status().connectedSince).toBeNull();
  });

  it('reconnects when the Manager stops answering heartbeats or cuts the connection mid-message', async () => {
    const authenticated = (ws: WebSocket, serverId: string) => {
      ws.send(hello());
      ws.once('message', (d) => ws.send(encode(createMessage('AUTHENTICATED', { serverId, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 300 }, JSON.parse(d.toString()).id))));
    };
    // Never acknowledges a heartbeat.
    const deaf = await fakeManager((ws) => authenticated(ws, crypto.randomUUID()));
    const a = makeLink(deaf.url);
    a.link.start();
    await waitFor(() => deaf.count(), (n) => n >= 2, 5000);
    expect(a.warnings.join('\n')).toMatch(/stopped answering heartbeats/);

    // Sends half a frame and resets the socket, every other time.
    const flaky = await fakeManager((ws, n) => {
      if (n % 2 === 1) {
        (ws as any)._socket.write(Buffer.from([0x81, 0x7e, 0x01, 0x00, 0x7b])); // text frame header announcing 256 bytes, then one byte
        return setTimeout(() => (ws as any)._socket.destroy(), 30);
      }
      authenticated(ws, crypto.randomUUID());
      ws.on('message', (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.type === 'HEARTBEAT') ws.send(encode(createMessage('HEARTBEAT', { seq: msg.payload.seq }, msg.id)));
      });
    });
    const b = makeLink(flaky.url);
    b.link.start();
    await waitFor(() => b.link.status(), (s) => s.state === 'CONNECTED', 5000);
    expect(flaky.count()).toBe(2);
    await new Promise((r) => setTimeout(r, 500));
    expect(b.link.status()).toMatchObject({ state: 'CONNECTED', lastError: null });
  });

  it('adopts the server id from AUTHENTICATED and keeps backing off after a connection that does not last', async () => {
    const known = crypto.randomUUID();
    const fake = await fakeManager((ws) => {
      ws.send(hello());
      ws.once('message', (d) => {
        ws.send(encode(createMessage('AUTHENTICATED', { serverId: known, heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 3000 }, JSON.parse(d.toString()).id)));
        setTimeout(() => ws.close(1001), 20); // accepted, then dropped at once
      });
    });
    const { link: l, identity } = makeLink(fake.url);
    l.start();
    await waitFor(() => fake.count(), (n) => n >= 4, 5000);
    expect(identity.serverId).toBe(known);
    // Never connected long enough to count as stable, so the attempt counter keeps growing.
    expect(l.status().attempts).toBeGreaterThanOrEqual(3);
  });
});

// ── TLS ──────────────────────────────────────────────────────────────────────────

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
describe.skipIf(!hasOpenssl)('agent and manager over TLS', () => {
  function certificate() {
    const dir = mkdtempSync(join(tmpdir(), 'servermin-tls-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=servermin-manager', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'tls.key'), '-out', join(dir, 'tls.crt')], { stdio: 'ignore' });
    const fingerprint = new X509Certificate(readFileSync(join(dir, 'tls.crt'))).fingerprint256;
    return { cert: join(dir, 'tls.crt'), key: join(dir, 'tls.key'), fingerprint };
  }
  async function tlsManager() {
    const tls = certificate();
    m = await startManager({ setup: false, config: { ...FAST, http: { host: '127.0.0.1', port: 0, tls: { cert: tls.cert, key: tls.key } } } });
    return tls;
  }
  const enrolDirect = (a: TestServer, name = 'Saturn') => {
    const s = m!.manager.inventory.create({ name, id: a.platform.agent.identity.serverId });
    m!.manager.inventory.enrolAgent(s.id, { agentId: a.platform.agent.identity.agentId, publicKey: a.platform.agent.key.publicKey });
    return s.id;
  };
  const stateOf = (id: string) => m!.manager.inventory.get(id)!.state;

  it('connects to a self-signed Manager whose certificate fingerprint is pinned', async () => {
    const tls = await tlsManager();
    expect(m!.manager.tlsFingerprint).toBe(tls.fingerprint.replace(/:/g, '').toLowerCase());
    const a = await startAgent(m!, { url: m!.url, fingerprint: tls.fingerprint, insecure: false });
    const id = enrolDirect(a);
    await waitFor(() => stateOf(id), (s) => s === 'ONLINE', 8000);
    expect(await link(a)).toMatchObject({ state: 'CONNECTED', url: `${m!.url.replace('https', 'wss')}${AGENT_ENDPOINT}` });
  });

  it('refuses to authenticate to a Manager with a different certificate, or an untrusted one without a pin', async () => {
    await tlsManager();
    const wrong = await startAgent(m!, { url: m!.url, fingerprint: 'ab'.repeat(32), insecure: false });
    const unpinned = await startAgent(m!, { url: m!.url, insecure: false });
    enrolDirect(wrong, 'Wrong');
    enrolDirect(unpinned, 'Unpinned');
    expect((await waitFor(() => link(wrong), (l) => l.attempts >= 2)).lastError).toMatch(/is not the pinned one; refusing to authenticate/);
    expect((await waitFor(() => link(unpinned), (l) => l.attempts >= 2)).lastError).toMatch(/certificate is not trusted; set agent\.manager\.fingerprint/);
    // Neither sent its proof: the Manager saw no authentication at all.
    expect(m!.manager.audit.query({ action: 'agent.authenticate' })).toEqual([]);
    expect(m!.manager.inventory.list().map((s) => s.state)).toEqual(['OFFLINE', 'OFFLINE']);
  });

  it('connects through a CA file when the certificate matches the host name', async () => {
    const tls = await tlsManager();
    const a = await startAgent(m!, { url: m!.url.replace('127.0.0.1', 'localhost'), ca: tls.cert, insecure: false });
    const id = enrolDirect(a);
    await waitFor(() => stateOf(id), (s) => s === 'ONLINE', 8000);
  });

  it('rejects a proof that was not made for this Manager\'s certificate', async () => {
    await tlsManager();
    const e = enrolKey(m!, 'Saturn');
    // As relayed by a machine in the middle: the agent signed for the certificate it saw there.
    for (const seen of ['', 'cd'.repeat(32)]) {
      const c = await raw(m!.url.replace('https', 'wss'));
      c.ws.send(encode(e.auth(await c.next('HELLO'), {}, seen)));
      expect((await c.closed).code).toBe(CLOSE.unauthorized);
    }
    const ok = await raw(m!.url.replace('https', 'wss'));
    ok.ws.send(encode(e.auth(await ok.next('HELLO'), {}, m!.manager.tlsFingerprint)));
    await ok.next('AUTHENTICATED');
  });
});

// ── Real processes ───────────────────────────────────────────────────────────────

describe('agent and manager as separate processes', () => {
  it('reconnects by itself after the Manager process is killed and started again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'servermin-procs-'));
    const children: ChildProcess[] = [];
    cleanups.push(() => {
      for (const c of children) c.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    });
    const freePort = () =>
      new Promise<number>((r) => {
        const s = createNetServer().listen(0, '127.0.0.1', () => {
          const p = (s.address() as any).port;
          s.close(() => r(p));
        });
      });
    const [mport, aport] = [await freePort(), await freePort()];
    const M = `http://127.0.0.1:${mport}`;
    const startManagerProcess = () => {
      const c = spawn(process.execPath, [join(ROOT, 'packages/manager/dist/manager.js')], {
        env: { PATH: process.env.PATH!, SERVERMIN_MANAGER_CONFIG: join(dir, 'none.json'), SERVERMIN_MANAGER_DATA_DIR: join(dir, 'manager'), SERVERMIN_MANAGER_HOST: '127.0.0.1', SERVERMIN_MANAGER_PORT: String(mport) },
        stdio: 'ignore',
      });
      children.push(c);
      return c;
    };
    const up = () => waitFor(() => fetch(`${M}/api/v1/health`).then((r) => r.ok).catch(() => false), (ok) => ok, 10_000);

    let manager = startManagerProcess();
    await up();
    const setup = await fetch(`${M}/api/v1/auth/setup`, { method: 'POST', headers: { 'x-servermin-request': '1', 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: readFileSync(join(dir, 'manager/setup-token'), 'utf8').trim(), username: 'admin', password: 'test-password-1' }) });
    const cookie = setup.headers.get('set-cookie')!.split(';')[0];
    const api = (method: string, path: string, body?: unknown) =>
      fetch(M + path, { method, headers: { 'x-servermin-request': '1', 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

    // The agent: the real server program, told where its Manager is.
    const agentConfig = join(dir, 'agent.json');
    const { writeFileSync } = await import('node:fs');
    const root = join(dir, 'agent');
    writeFileSync(
      agentConfig,
      JSON.stringify({
        http: { host: '127.0.0.1', port: aport },
        paths: { app: root, data: join(root, 'data'), modules: join(root, 'data/modules'), logs: join(root, 'logs'), tmp: join(root, 'tmp'), shell: join(root, 'shell') },
        modules: { preinstall: [], sources: [] },
        privileged: { mode: 'simulate' },
        logging: { stdout: false },
        updates: { enabled: false },
        agent: { manager: { url: M, insecure: true } },
      }),
    );
    children.push(spawn(process.execPath, [join(ROOT, '.vitest-tmp/core/server.js')], { env: { PATH: process.env.PATH!, SERVERMIN_CONFIG: agentConfig }, stdio: 'ignore' }));
    const identityFile = join(dir, 'agent/data/agent/identity.json');
    const identity = await waitFor(() => { try { return JSON.parse(readFileSync(identityFile, 'utf8')); } catch { return null; } }, (i) => !!i, 15_000);
    const publicKey = readFileSync(join(dir, 'agent/data/agent/agent-key.pub'), 'utf8').trim();

    await api('POST', '/api/v1/servers', { name: 'Saturn', id: identity.serverId });
    await api('PUT', `/api/v1/servers/${identity.serverId}/agent`, { agentId: identity.agentId, publicKey });
    const state = () => api('GET', `/api/v1/servers/${identity.serverId}`).then((s) => s.state).catch(() => 'unreachable');
    await waitFor(state, (s) => s === 'ONLINE', 40_000);

    // Kill the Manager outright: no goodbye, no close frame.
    manager.kill('SIGKILL');
    await waitFor(() => fetch(`${M}/api/v1/health`).then(() => true).catch(() => false), (reachable) => !reachable, 5000);
    await new Promise((r) => setTimeout(r, 1500));
    manager = startManagerProcess();
    await up();
    await waitFor(state, (s) => s === 'ONLINE', 60_000);

    // And the other way round: the agent process dies, the Manager notices.
    children[1].kill('SIGKILL');
    await waitFor(state, (s) => s === 'OFFLINE', 15_000);
  }, 150_000);
});
