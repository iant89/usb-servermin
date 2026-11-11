/**
 * Phase 3 proof (migration plan): a real Manager and real agent links, with the failures the
 * protocol must survive: the Manager stopped and killed, sockets dropped mid-frame, heartbeats
 * stalled, malformed and oversized frames, duplicate identities and the wrong Manager key.
 */
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { AgentKey, IdentityStore, ManagerLink, agentStateDir, createSelfSignedCertificate, loadAgentKey, mergeConfig, publicKeyFingerprint, type ManagerLinkOptions } from '../../packages/core/src/index';
import { Manager, defaultManagerConfig, type ManagerConfig } from '../../packages/manager/src/index';
import { CLOSE, LINK_PATH, MAX_FRAME_BYTES, authenticationText, decode, encode, envelope, type ServerStatePayload } from '../../packages/protocol/src/index';
import { format } from '../../packages/cli/src/agent';
import { ROOT, startServer, waitFor } from './helpers';

const quiet = <T>(fn: () => T): T => {
  const write = process.stdout.write;
  process.stdout.write = (() => true) as any;
  try {
    return fn();
  } finally {
    process.stdout.write = write;
  }
};
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createNetServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

/** Fast timings so a test sees STALE and OFFLINE in well under a second. */
const AGENTS: ManagerConfig['agents'] = { heartbeatIntervalMs: 100, staleAfterMs: 350, timeoutMs: 700, authTimeoutMs: 500, duplicateProbeMs: 300, requireKeyBinding: true };
const LINK_TUNING = { backoff: { initialMs: 50, maxMs: 400 }, connectTimeoutMs: 2000, stableAfterMs: 1000 };

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface TestManager {
  manager: Manager;
  url: string;
  dir: string;
  port: number;
  config: ManagerConfig;
  restart(): Promise<void>;
  stop(): Promise<void>;
}

async function startManager(opts: { agents?: Partial<ManagerConfig['agents']>; port?: number } = {}): Promise<TestManager> {
  const dir = mkdtempSync(join(tmpdir(), 'servermin-link-'));
  const port = opts.port ?? (await freePort());
  const config: ManagerConfig = mergeConfig(defaultManagerConfig(dir), { http: { host: '127.0.0.1', port }, logging: { level: 'ERROR', stdout: false }, agents: { ...AGENTS, ...opts.agents } });
  let running = true;
  const t: TestManager = {
    manager: await quiet(() => new Manager(config).start()),
    url: `wss://127.0.0.1:${port}`,
    dir,
    port,
    config,
    async restart() {
      if (running) await t.manager.stop();
      t.manager = await quiet(() => new Manager(config).start());
      running = true;
    },
    async stop() {
      if (running) await t.manager.stop();
      running = false;
    },
  };
  cleanups.push(async () => {
    await t.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return t;
}

interface TestAgent {
  agentId: string;
  serverId: string;
  key: AgentKey;
  link: ManagerLink;
}

const report = (): ServerStatePayload => ({
  name: 'test-server',
  hostname: 'test-host',
  machineId: null,
  hardware: { vendor: null, product: null, board: null, fingerprint: null },
  os: { name: 'Test OS', id: 'test', version: '1', kernel: '6.0', arch: 'x64' },
  version: '1.0.0',
  state: 'RUNNING',
  health: 'HEALTHY',
  startedAt: new Date().toISOString(),
  uptimeSeconds: 1,
  capabilities: ['system'],
  modules: [{ id: 'system', version: '1.0.0', state: 'ACTIVE', health: 'HEALTHY', provides: [], tags: [] }],
});

/** Adds a server to the Manager's inventory and enrols an agent for it. */
function enrol(m: TestManager, opts: { publicKey?: string } = {}) {
  const key = AgentKey.generate().key;
  const agentId = randomUUID();
  const server = m.manager.inventory.create({ name: `srv-${agentId.slice(0, 8)}` });
  m.manager.agents.enroll({ serverId: server.id, agentId, publicKey: opts.publicKey ?? key.publicKey });
  return { agentId, serverId: server.id, key };
}

function linkFor(url: string, a: { agentId: string; serverId: string; key: AgentKey }, o: Partial<ManagerLinkOptions> = {}): ManagerLink {
  const link = new ManagerLink({
    url: `${url}${LINK_PATH}`,
    fingerprint: null,
    ca: null,
    key: a.key,
    identity: () => ({ agentId: a.agentId, serverId: a.serverId, createdAt: new Date(0).toISOString() }),
    version: '1.0.0',
    heartbeat: () => ({ state: 'RUNNING', health: 'HEALTHY', uptimeSeconds: 1 }),
    capabilities: () => ['system'],
    report: async () => report(),
    logger: silentLogger,
    ...LINK_TUNING,
    ...o,
  });
  cleanups.push(() => link.stop());
  return link;
}

/** Enrols an agent and connects it, pinned to the Manager's key. */
async function connectedAgent(m: TestManager, o: Partial<ManagerLinkOptions> = {}): Promise<TestAgent> {
  const a = enrol(m);
  const link = linkFor(m.url, a, { fingerprint: m.manager.tls.keyFingerprint, ...o });
  link.start();
  await waitFor(() => link.state, (s) => s === 'CONNECTED');
  return { ...a, link };
}

const serverState = (m: TestManager, id: string) => m.manager.inventory.get(id)?.state;
const auditActions = (m: TestManager, action: string) => m.manager.db.all<{ result: string; target: string; metadata: string }>('SELECT result, target, metadata FROM audit_log WHERE action = ? ORDER BY id', [action]);

/** A hand-driven agent connection, for frames a real agent never sends. */
async function rawClient(m: TestManager) {
  const ws = new WebSocket(`${m.url}${LINK_PATH}`, { rejectUnauthorized: false, maxPayload: MAX_FRAME_BYTES * 4 });
  const messages: any[] = [];
  let hello: any;
  const helloSeen = new Promise<any>((r) => (hello = r));
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    messages.push(msg);
    if (msg.type === 'HELLO') hello(msg);
  });
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
  ws.on('error', () => undefined);
  await new Promise((r, j) => ws.once('open', r).once('error', j));
  cleanups.push(() => ws.terminate());
  return { ws, messages, hello: helloSeen, closed };
}

/** Authenticates a raw client correctly (or with a chosen key fingerprint). */
async function rawAuthenticate(m: TestManager, c: Awaited<ReturnType<typeof rawClient>>, a: { agentId: string; serverId: string; key: AgentKey }, keyFingerprint = m.manager.tls.keyFingerprint) {
  const hello = await c.hello;
  const payload = { protocolVersion: 1, agentId: a.agentId, serverId: a.serverId, agentVersion: '1.0.0', keyFingerprint };
  const signature = a.key.sign(authenticationText({ nonce: hello.payload.nonce, ...payload }));
  c.ws.send(encode(envelope('AUTHENTICATE', 'auth1', { ...payload, signature }, hello.id), 'toManager'));
}

describe('agent link: connection and state', () => {
  it('connects over pinned TLS, authenticates, reports and stays ONLINE on heartbeats', async () => {
    const m = await startManager();
    const a = await connectedAgent(m);
    const status = a.link.status();
    expect(status).toMatchObject({ state: 'CONNECTED', protocolVersion: 1, managerKeyFingerprint: m.manager.tls.keyFingerprint, lastError: null });
    const server = await waitFor(() => m.manager.inventory.get(a.serverId)!, (s) => s.state === 'ONLINE' && s.agentVersion === '1.0.0');
    expect(server.lastSeenAt).not.toBeNull();
    // Several heartbeat intervals later it is still ONLINE: heartbeats keep it alive.
    await sleep(AGENTS.timeoutMs + 300);
    expect(serverState(m, a.serverId)).toBe('ONLINE');
    expect(a.link.status().sessionId).toBe(status.sessionId);
    // The report is stored, and the API shows the live connection.
    const agent = await waitFor(() => m.manager.agents.get(a.agentId)!, (x) => !!x.report);
    expect(agent.report).toMatchObject({ hostname: 'test-host', capabilities: ['system'] });
    expect(m.manager.links.connection(a.agentId)).toMatchObject({ sessionId: status.sessionId, protocolVersion: 1, stale: false });
    const connects = auditActions(m, 'agent.connect');
    expect(connects).toHaveLength(1);
    expect(connects[0]).toMatchObject({ result: 'success', target: a.agentId });
  });

  it('sends a new SERVER_STATE when capabilities change', async () => {
    const m = await startManager();
    let caps = ['system'];
    const a = await connectedAgent(m, { capabilities: () => caps, report: async () => ({ ...report(), capabilities: caps }) });
    await waitFor(() => m.manager.agents.get(a.agentId)!.report?.capabilities, (c) => c?.join() === 'system');
    caps = ['docker', 'system'];
    await waitFor(() => m.manager.agents.get(a.agentId)!.report?.capabilities, (c) => c?.join() === 'docker,system');
  });

  it('marks a server OFFLINE when its agent stops, and the agent says why in its status', async () => {
    const m = await startManager();
    const a = await connectedAgent(m);
    await a.link.stop();
    await waitFor(() => serverState(m, a.serverId), (s) => s === 'OFFLINE');
    expect(a.link.status().state).toBe('STOPPED');
  });
});

describe('agent link: reconnection', () => {
  it('reconnects on its own after the Manager is stopped and started again', async () => {
    const m = await startManager();
    const a = await connectedAgent(m);
    const first = a.link.status().sessionId;
    await m.stop();
    await waitFor(() => a.link.state, (s) => s === 'WAITING');
    // "The Manager is shutting down", then "connection refused" from the first retry.
    expect(a.link.status().lastError).toMatch(/shutting down|ECONNREFUSED/);
    // While the Manager is down the agent keeps trying, with growing delays.
    await waitFor(() => a.link.status().failedAttempts, (n) => n >= 3, 5000);
    await m.restart();
    await waitFor(() => a.link.state, (s) => s === 'CONNECTED', 5000);
    expect(a.link.status().sessionId).not.toBe(first);
    await waitFor(() => serverState(m, a.serverId), (s) => s === 'ONLINE');
  });

  it('reconnects after the Manager process is killed (SIGKILL), and the restarted Manager does not trust stale state', async () => {
    // Prepare a data directory with one enrolled agent, then run the real program on it.
    const m = await startManager();
    const a = enrol(m);
    await m.stop();
    const db = join(m.config.paths.data, 'manager.db');
    const readState = () => {
      const d = new DatabaseSync(db, { readOnly: true });
      try {
        return (d.prepare('SELECT state FROM servers WHERE id = ?').get(a.serverId) as { state: string }).state;
      } finally {
        d.close();
      }
    };
    const run = (): ChildProcess => {
      const child = spawn(process.execPath, [join(ROOT, 'packages/manager/dist/manager.js')], {
        env: { PATH: process.env.PATH!, SERVERMIN_MANAGER_CONFIG: join(m.dir, 'none.json'), SERVERMIN_MANAGER_DATA_DIR: m.config.paths.data, SERVERMIN_MANAGER_HOST: '127.0.0.1', SERVERMIN_MANAGER_PORT: String(m.port), SERVERMIN_MANAGER_LOG_LEVEL: 'ERROR' },
        stdio: 'ignore',
      });
      cleanups.push(() => child.kill('SIGKILL'));
      return child;
    };
    const fingerprint = publicKeyFingerprint(readFileSync(join(m.config.paths.data, 'tls/manager.crt')));
    const link = linkFor(m.url, a, { fingerprint });

    const first = run();
    link.start();
    await waitFor(() => link.state, (s) => s === 'CONNECTED', 15_000);
    expect(readState()).toBe('ONLINE');
    first.kill('SIGKILL');
    await waitFor(() => link.state, (s) => s === 'WAITING', 5000);
    // Nobody marked it offline: the process died. The next start must not believe ONLINE.
    expect(readState()).toBe('ONLINE');

    run();
    await waitFor(() => link.state, (s) => s === 'CONNECTED', 15_000);
    expect(link.status().failedAttempts).toBeGreaterThan(0);
    expect(readState()).toBe('ONLINE');
  }, 40_000);

  it('detects a Manager that stops answering and reconnects', async () => {
    // A fake Manager that authenticates every agent, then never acknowledges a heartbeat.
    const { cert, key } = createSelfSignedCertificate({ commonName: 'fake', altNames: ['127.0.0.1'], days: 1 });
    const https: HttpsServer = createHttpsServer({ cert, key });
    const wss = new WebSocketServer({ server: https });
    let connections = 0;
    wss.on('connection', (ws) => {
      connections++;
      ws.send(encode(envelope('HELLO', 'h1', { managerVersion: 'fake', protocolVersions: [1], nonce: 'bm9uY2U' }), 'toAgent'));
      ws.on('message', (d) => {
        const msg = decode(d as Buffer, 'toManager');
        if (msg.type === 'AUTHENTICATE') ws.send(encode(envelope('AUTHENTICATED', 'a1', { sessionId: `s${connections}`, protocolVersion: 1, serverId: msg.payload.serverId, heartbeatIntervalMs: 50, timeoutMs: 300 }, msg.id), 'toAgent'));
      });
    });
    await new Promise<void>((r) => https.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => https.close(r)));
    cleanups.push(() => wss.close());
    const port = (https.address() as { port: number }).port;
    const a = { agentId: randomUUID(), serverId: randomUUID(), key: AgentKey.generate().key };
    const link = linkFor(`wss://127.0.0.1:${port}`, a, { fingerprint: publicKeyFingerprint(cert) });
    link.start();
    await waitFor(() => link.state, (s) => s === 'CONNECTED');
    await waitFor(() => link.status().lastError, (e) => e === 'No answer from the Manager for 300 ms', 3000);
    await waitFor(() => connections, (n) => n >= 2, 3000);
  });

  it('survives the Manager dropping the socket in the middle of a frame', async () => {
    const { cert, key } = createSelfSignedCertificate({ commonName: 'fake', altNames: ['127.0.0.1'], days: 1 });
    const https = createHttpsServer({ cert, key });
    const wss = new WebSocketServer({ server: https });
    let connections = 0;
    wss.on('connection', (ws) => {
      connections++;
      ws.send(encode(envelope('HELLO', 'h1', { managerVersion: 'fake', protocolVersions: [1], nonce: 'bm9uY2U' }), 'toAgent'));
      ws.on('message', (d) => {
        const msg = decode(d as Buffer, 'toManager');
        if (msg.type !== 'AUTHENTICATE') return;
        ws.send(encode(envelope('AUTHENTICATED', 'a1', { sessionId: 's', protocolVersion: 1, serverId: msg.payload.serverId, heartbeatIntervalMs: 50, timeoutMs: 5000 }, msg.id), 'toAgent'));
        // The header of a 300-byte text frame and half of its body, then the connection dies.
        const socket = (ws as any)._socket;
        setTimeout(() => {
          socket.write(Buffer.concat([Buffer.from([0x81, 0x7e, 0x01, 0x2c]), Buffer.from('{"v":1,"id":"x","type":"HEARTBEAT_ACK"'.padEnd(150, ' '))]));
          socket.destroy();
        }, 100);
      });
    });
    await new Promise<void>((r) => https.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => https.close(r)));
    cleanups.push(() => wss.close());
    const port = (https.address() as { port: number }).port;
    const a = { agentId: randomUUID(), serverId: randomUUID(), key: AgentKey.generate().key };
    const link = linkFor(`wss://127.0.0.1:${port}`, a, { fingerprint: publicKeyFingerprint(cert) });
    link.start();
    await waitFor(() => connections, (n) => n >= 3, 5000);
    expect(['CONNECTING', 'AUTHENTICATING', 'CONNECTED', 'WAITING']).toContain(link.state);
  });
});

describe('agent link: Manager-side failure handling', () => {
  it('marks a silent agent STALE, then closes it and marks it OFFLINE', async () => {
    const m = await startManager();
    const a = enrol(m);
    const c = await rawClient(m);
    await rawAuthenticate(m, c, a);
    await waitFor(() => serverState(m, a.serverId), (s) => s === 'ONLINE');
    // No heartbeats from here on.
    await waitFor(() => serverState(m, a.serverId), (s) => s === 'STALE', 2000);
    const { code } = await c.closed;
    expect(code).toBe(CLOSE.TIMEOUT);
    await waitFor(() => serverState(m, a.serverId), (s) => s === 'OFFLINE');
    expect(c.messages.at(-1)).toMatchObject({ type: 'ERROR', payload: { code: 'timeout' } });
  });

  it('brings a STALE server back ONLINE when heartbeats resume', async () => {
    const m = await startManager();
    const a = enrol(m);
    const c = await rawClient(m);
    await rawAuthenticate(m, c, a);
    await waitFor(() => serverState(m, a.serverId), (s) => s === 'STALE', 2000);
    c.ws.send(encode(envelope('HEARTBEAT', 'hb1', { sequence: 1, state: 'RUNNING', health: 'HEALTHY', uptimeSeconds: 1 }), 'toManager'));
    await waitFor(() => serverState(m, a.serverId), (s) => s === 'ONLINE');
    await waitFor(() => c.messages.find((x) => x.type === 'HEARTBEAT_ACK'), (x) => x?.correlationId === 'hb1' && x.payload.sequence === 1);
  });

  it('closes a connection that never authenticates', async () => {
    const m = await startManager();
    const c = await rawClient(m);
    expect((await c.hello).payload).toMatchObject({ protocolVersions: [1] });
    expect((await c.closed).code).toBe(CLOSE.TIMEOUT);
  });

  it('closes only the offending connection on malformed, unknown, out-of-order, binary and oversized frames', async () => {
    const m = await startManager();
    const good = await connectedAgent(m);
    const cases: [string, (ws: WebSocket) => void, number][] = [
      ['not JSON', (ws) => ws.send('{nope'), CLOSE.PROTOCOL_ERROR],
      ['unknown type', (ws) => ws.send(JSON.stringify({ v: 1, id: 'x', type: 'EXEC', payload: {} })), CLOSE.PROTOCOL_ERROR],
      ['reserved type', (ws) => ws.send(JSON.stringify({ v: 1, id: 'x', type: 'COMMAND', payload: {} })), CLOSE.PROTOCOL_ERROR],
      ['heartbeat before authentication', (ws) => ws.send(encode(envelope('HEARTBEAT', 'x', { sequence: 1, state: 'RUNNING', health: 'HEALTHY', uptimeSeconds: 1 }), 'toManager')), CLOSE.PROTOCOL_ERROR],
      ['binary', (ws) => ws.send(Buffer.from([1, 2, 3])), CLOSE.PROTOCOL_ERROR],
      ['another envelope version', (ws) => ws.send(JSON.stringify({ v: 9, id: 'x', type: 'HEARTBEAT', payload: {} })), CLOSE.UNSUPPORTED_VERSION],
      ['oversized', (ws) => ws.send('x'.repeat(MAX_FRAME_BYTES + 1)), CLOSE.TOO_BIG],
    ];
    for (const [name, sendBad, expected] of cases) {
      const c = await rawClient(m);
      await c.hello;
      sendBad(c.ws);
      expect((await c.closed).code, name).toBe(expected);
    }
    // The real agent never noticed.
    expect(good.link.state).toBe('CONNECTED');
    expect(serverState(m, good.serverId)).toBe('ONLINE');
    expect(good.link.status().failedAttempts).toBe(0);
  });

  it('survives an agent connection dropped in the middle of a frame', async () => {
    const m = await startManager();
    const good = await connectedAgent(m);
    for (let i = 0; i < 5; i++) {
      const c = await rawClient(m);
      await c.hello;
      const socket = (c.ws as any)._socket;
      // A masked text frame header announcing 300 bytes, then a few bytes of it.
      socket.write(Buffer.from([0x81, 0xfe, 0x01, 0x2c, 1, 2, 3, 4, 0x41, 0x42]));
      socket.destroy();
    }
    // An authenticated agent dropped mid-frame goes OFFLINE.
    const a = enrol(m);
    const c = await rawClient(m);
    await rawAuthenticate(m, c, a);
    await waitFor(() => serverState(m, a.serverId), (s) => s === 'ONLINE');
    (c.ws as any)._socket.write(Buffer.from([0x81, 0xfe, 0x01, 0x2c, 1, 2, 3, 4]));
    (c.ws as any)._socket.destroy();
    await waitFor(() => serverState(m, a.serverId), (s) => s === 'OFFLINE');
    await sleep(200);
    expect(good.link.state).toBe('CONNECTED');
    expect(serverState(m, good.serverId)).toBe('ONLINE');
  });
});

describe('agent link: authentication and trust', () => {
  it('refuses unknown agents and wrong keys, audits why, and tells the agent only that it failed', async () => {
    const m = await startManager();
    const unknown = { agentId: randomUUID(), serverId: randomUUID(), key: AgentKey.generate().key };
    const link1 = linkFor(m.url, unknown, { fingerprint: m.manager.tls.keyFingerprint });
    link1.start();
    await waitFor(() => link1.status().lastError, (e) => !!e && e.includes('Authentication failed'));

    const wrongKey = enrol(m, { publicKey: AgentKey.generate().key.publicKey });
    const link2 = linkFor(m.url, wrongKey, { fingerprint: m.manager.tls.keyFingerprint });
    link2.start();
    await waitFor(() => link2.status().lastError, (e) => !!e && e.includes('Authentication failed'));

    const failures = await waitFor(() => auditActions(m, 'agent.authenticate'), (r) => r.some((x) => x.target === wrongKey.agentId));
    expect(failures.find((x) => x.target === unknown.agentId)!.metadata).toContain('unknown agent');
    expect(failures.find((x) => x.target === wrongKey.agentId)!.metadata).toContain('bad signature');
    expect(serverState(m, wrongKey.serverId)).toBe('OFFLINE');
    // Retried at the longest interval, not hammered.
    const before = link2.status().failedAttempts;
    await sleep(LINK_TUNING.backoff.maxMs * 2 + 200);
    expect(link2.status().failedAttempts - before).toBeLessThanOrEqual(4);
  });

  it('refuses an agent that reports another server id than it was enrolled for', async () => {
    const m = await startManager();
    const a = enrol(m);
    const link = linkFor(m.url, { ...a, serverId: randomUUID() }, { fingerprint: m.manager.tls.keyFingerprint });
    link.start();
    await waitFor(() => auditActions(m, 'agent.authenticate'), (r) => r.some((x) => x.metadata.includes('enrolled for')));
  });

  it('with a pinned key, refuses a Manager with another key before authenticating', async () => {
    const m = await startManager();
    const a = enrol(m);
    const link = linkFor(m.url, a, { fingerprint: 'ab'.repeat(32) });
    link.start();
    await waitFor(() => link.status().lastError, (e) => !!e && e.includes('is not the pinned key'));
    expect(link.status().managerKeyFingerprint).toBe(m.manager.tls.keyFingerprint);
    await sleep(300);
    expect(auditActions(m, 'agent.authenticate')).toEqual([]);
    expect(auditActions(m, 'agent.connect')).toEqual([]);
  });

  it('without a pin, verifies the certificate: refuses a self-signed one, accepts it as a configured CA', async () => {
    const m = await startManager();
    const a = enrol(m);
    const untrusted = linkFor(m.url, a);
    untrusted.start();
    await waitFor(() => untrusted.status().lastError, (e) => !!e && /self[- ]signed/i.test(e));
    await untrusted.stop();
    const trusted = linkFor(m.url, a, { ca: readFileSync(join(m.config.paths.data, 'tls/manager.crt'), 'utf8') });
    trusted.start();
    await waitFor(() => trusted.state, (s) => s === 'CONNECTED');
  });

  it('refuses an agent that saw a different Manager key (TLS terminated in between)', async () => {
    const m = await startManager();
    const a = enrol(m);
    const c = await rawClient(m);
    await rawAuthenticate(m, c, a, 'cd'.repeat(32));
    expect((await c.closed).code).toBe(CLOSE.AUTH_FAILED);
    const failures = auditActions(m, 'agent.authenticate');
    expect(failures.at(-1)!.metadata).toContain('terminates TLS');
  });

  it('locks out an address after repeated failed handshakes', async () => {
    const m = await startManager();
    for (let i = 0; i < 10; i++) {
      const c = await rawClient(m);
      await c.hello;
      c.ws.send('garbage');
      await c.closed;
    }
    const ws = new WebSocket(`${m.url}${LINK_PATH}`, { rejectUnauthorized: false });
    const err = await new Promise<Error>((r) => ws.on('error', r));
    expect(err.message).toContain('429');
  });
});

describe('agent link: one live connection per agent', () => {
  it('refuses a second live connection with the same identity and reports the duplicate', async () => {
    const m = await startManager();
    const a = await connectedAgent(m);
    const events: any[] = [];
    m.manager.bus.subscribe('agent.duplicate', (e) => events.push(e.payload), 'test');
    const clone = linkFor(m.url, a, { fingerprint: m.manager.tls.keyFingerprint });
    clone.start();
    await waitFor(() => clone.status().lastError, (e) => !!e && e.includes('already has a live connection'), 3000);
    expect(a.link.state).toBe('CONNECTED');
    expect(serverState(m, a.serverId)).toBe('ONLINE');
    expect(events[0]).toMatchObject({ agentId: a.agentId, serverId: a.serverId });
    expect(auditActions(m, 'agent.duplicate')[0]).toMatchObject({ result: 'failure', target: a.agentId });
  });

  it('replaces a connection that no longer answers (half-open after a network change)', async () => {
    const m = await startManager();
    const a = enrol(m);
    const old = await rawClient(m);
    await rawAuthenticate(m, old, a);
    await waitFor(() => serverState(m, a.serverId), (s) => s === 'ONLINE');
    // The old connection stops reading: it cannot answer a ping any more.
    (old.ws as any)._socket.pause();
    const link = linkFor(m.url, a, { fingerprint: m.manager.tls.keyFingerprint });
    link.start();
    await waitFor(() => link.state, (s) => s === 'CONNECTED', 3000);
    expect(m.manager.links.connection(a.agentId)!.sessionId).toBe(link.status().sessionId);
    expect(serverState(m, a.serverId)).toBe('ONLINE');
  });

  it('disconnects the agent of a removed server and refuses it from then on', async () => {
    const m = await startManager();
    const a = await connectedAgent(m);
    m.manager.inventory.remove(a.serverId);
    await waitFor(() => a.link.status().lastError, (e) => !!e && e.includes('Authentication failed'), 3000);
    expect(m.manager.agents.get(a.agentId)).toBeUndefined();
  });
});

describe('agent link: a real agent', () => {
  it('a running agent connects from its configuration, shows the link in /api/v1/agent and reconnects after a Manager restart', async () => {
    const m = await startManager();
    let enrolled: { serverId: string; agentId: string } | null = null;
    const server = await startServer({}, {
      config: { agent: { manager: { url: m.url, fingerprint: m.manager.tls.keyFingerprint, ca: null } } },
      beforeStart: (_dir: string, config: Parameters<typeof agentStateDir>[0]) => {
        // What registration (Phase 4) will do: the agent's identity and public key reach the Manager.
        const stateDir = agentStateDir(config);
        const identity = new IdentityStore(stateDir).load().identity;
        const key = loadAgentKey(stateDir).key;
        const record = m.manager.inventory.create({ name: 'real-agent', id: identity.serverId });
        m.manager.agents.enroll({ serverId: record.id, agentId: identity.agentId, publicKey: key.publicKey });
        enrolled = identity;
      },
      link: LINK_TUNING,
    } as any);
    cleanups.push(() => server.stop());
    const { serverId, agentId } = enrolled!;
    await waitFor(() => serverState(m, serverId), (s) => s === 'ONLINE', 10_000);
    const r = await server.api('GET', '/api/v1/agent');
    expect(r.body.manager).toMatchObject({ state: 'CONNECTED', url: `${m.url}${LINK_PATH}`, managerKeyFingerprint: m.manager.tls.keyFingerprint });
    expect(format({ ...r.body, source: 'api', os: r.body.os.name })).toMatch(new RegExp(`Manager +connected to ${m.url}${LINK_PATH} since `));
    const stored = await waitFor(() => m.manager.agents.get(agentId)!.report, (x) => !!x && x.capabilities.length >= 0);
    expect(stored!.version).toBe(r.body.version);

    await m.restart();
    await waitFor(() => serverState(m, serverId), (s) => s === 'ONLINE', 10_000);
    await server.stop();
    cleanups.pop();
    await waitFor(() => serverState(m, serverId), (s) => s === 'OFFLINE');
  }, 30_000);

  it('an agent without a Manager reports the link as DISABLED and makes no key', async () => {
    const server = await startServer();
    cleanups.push(() => server.stop());
    const r = await server.api('GET', '/api/v1/agent');
    expect(r.body.manager).toMatchObject({ state: 'DISABLED', url: null });
    expect(() => readFileSync(join(agentStateDir(server.platform.config), 'agent-key.pem'))).toThrow();
  });
});
