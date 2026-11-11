/**
 * Phase 4 proof: code → install → `servermin-agent register CODE` → approve → managed, with a
 * real Manager over TLS, a real agent, and the real `servermin-agent` program.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CliError } from '../../packages/cli/src/agent';
import { leave, register } from '../../packages/cli/src/register';
import { AgentKey } from '../../packages/core/src/index';
import { normalizeCode } from '../../packages/manager/src/index';
import { ROOT, startServer, waitFor, type TestServer } from './helpers';
import { httpRequest, startManager, type TestManager } from './manager-helpers';

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
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

function certificate() {
  const dir = mkdtempSync(join(tmpdir(), 'servermin-tls-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=servermin-manager', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'tls.key'), '-out', join(dir, 'tls.crt')], { stdio: 'ignore' });
  return { cert: join(dir, 'tls.crt'), key: join(dir, 'tls.key'), fingerprint: new X509Certificate(readFileSync(join(dir, 'tls.crt'))).fingerprint256.replace(/:/g, '').toLowerCase() };
}

async function tlsManager() {
  const tls = certificate();
  m = await startManager({ config: { ...FAST, http: { host: '127.0.0.1', port: 0, tls: { cert: tls.cert, key: tls.key } } } });
  return tls;
}

/** A real agent with no Manager configured: a freshly installed server. */
async function newServer() {
  const a = await startServer({}, { linkBackoff: QUICK, registrationPollMs: 50 });
  agents.push(a);
  return a;
}
/** The environment `servermin-agent` would see on that server. */
const envOf = (a: TestServer) => ({ SERVERMIN_CONFIG: join(a.dir, 'no-config.json'), SERVERMIN_DATA_DIR: a.platform.config.paths.data, SERVERMIN_APP: join(a.dir, 'app') });
const stateDir = (a: TestServer) => join(a.platform.config.paths.data, 'agent');
const link = async (a: TestServer) => (await a.api('GET', '/api/v1/agent')).body.manager;

async function createCode(body: Record<string, unknown> = {}) {
  const r = await m!.api('POST', '/api/v1/registration-codes', body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { id: string; code: string; command: string; fingerprint: string; managerUrl: string; expiresAt: string; status: string };
}
/** The arguments of the command the Manager printed, after `servermin-agent register`. */
const argsOf = (command: string) => command.split(' ').slice(2);

/** Presents a code straight to the public endpoint, as a hand-written client would. */
async function submit(body: Record<string, unknown>, headers: Record<string, string> = { 'x-servermin-request': '1' }) {
  const cfg = m!.manager.config.http.tls;
  const res = await httpRequest(`${m!.url}/api/v1/registrations`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close', ...headers }, body: JSON.stringify(body), ca: cfg ? readFileSync(cfg.cert) : undefined });
  let parsed: any = null;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed };
}
const someAgent = () => ({ agentId: crypto.randomUUID(), serverId: crypto.randomUUID(), publicKey: AgentKey.load(mkdtempSync(join(tmpdir(), 'servermin-key-'))).key.publicKey, hostname: 'jupiter' });
const audit = async (action: string) => (await m!.api('GET', `/api/v1/audit?action=${action}`)).body as any[];

describe('registration codes', () => {
  it('look like SMR-XXXXX-…, are forgiving to type, and are stored only as a hash', async () => {
    m = await startManager({ config: FAST });
    const c = await createCode({ name: 'Saturn', expiresInMinutes: 30 });
    expect(c.code).toMatch(/^SMR(-[0-9A-HJKMNP-TV-Z]{5}){5}$/);
    expect(normalizeCode(c.code.toLowerCase().replace(/-/g, ' '))).toBe(normalizeCode(c.code));
    expect(normalizeCode(c.code.replace(/0/g, 'O'))).toBe(normalizeCode(c.code));
    expect(c.status).toBe('ACTIVE');
    expect(Date.parse(c.expiresAt) - Date.now()).toBeGreaterThan(29 * 60_000);
    // Without TLS the printed command says so instead of inventing a fingerprint.
    expect(c.command).toBe(`servermin-agent register ${c.code} --manager ${m.url} --insecure`);
    expect((c as any).runAs).toBe('root');
    const db = readFileSync(join(m.manager.config.paths.data, 'manager.db'));
    expect(db.includes(Buffer.from(normalizeCode(c.code)!))).toBe(false);
    const listed = (await m.api('GET', '/api/v1/registration-codes')).body;
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(normalizeCode(c.code));
  });

  it('are refused for bad input, and only administrators of servers may make or list them', async () => {
    m = await startManager({ config: FAST });
    for (const body of [{ expiresInMinutes: 0 }, { expiresInMinutes: 7 * 24 * 60 + 1 }, { expiresInMinutes: 1.5 }, { serverId: 'nope' }, { serverId: crypto.randomUUID() }, { autoApprove: 'yes' }, { name: '' + '\u0000' }])
      expect((await m.api('POST', '/api/v1/registration-codes', body)).status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
    await m.api('POST', '/api/v1/users', { username: 'vera', password: 'test-password-2', permissions: ['servers.read'] });
    const viewer = (await m.api('POST', '/api/v1/auth/login', { username: 'vera', password: 'test-password-2' }, { cookie: '' })).setCookie!.split(';')[0];
    expect((await m.api('POST', '/api/v1/registration-codes', {}, { cookie: viewer })).status).toBe(403);
    expect((await m.api('GET', '/api/v1/registration-codes', undefined, { cookie: viewer })).status).toBe(403);
    expect((await m.api('GET', '/api/v1/registrations', undefined, { cookie: viewer })).status).toBe(200);
    const c = await createCode();
    const r = await submit({ code: c.code, ...someAgent() });
    expect((await m.api('POST', `/api/v1/registrations/${r.body.registrationId}/approve`, {}, { cookie: viewer })).status).toBe(403);
  });

  it('work once, and not after they expired or were revoked; a malformed request does not use one up', async () => {
    m = await startManager({ config: FAST });
    const c = await createCode();
    expect((await submit({ code: c.code, ...someAgent(), publicKey: 'not-a-key' })).status).toBe(400);
    expect((await submit({ code: c.code, ...someAgent() })).status).toBe(200);
    const again = await submit({ code: c.code, ...someAgent() });
    expect(again).toMatchObject({ status: 403, body: { error: expect.stringMatching(/is used; ask for a new one/) } });

    const expiring = await createCode({ expiresInMinutes: 1 });
    m.manager.db.run('UPDATE registration_codes SET expires_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), expiring.id]);
    expect((await submit({ code: expiring.code, ...someAgent() })).body.error).toMatch(/is expired/);

    const revoked = await createCode();
    expect((await m.api('DELETE', `/api/v1/registration-codes/${revoked.id}`)).body.status).toBe('REVOKED');
    expect((await m.api('DELETE', `/api/v1/registration-codes/${revoked.id}`)).status).toBe(409);
    expect((await submit({ code: revoked.code, ...someAgent() })).body.error).toMatch(/is revoked/);

    expect((await submit({ code: 'SMR-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA', ...someAgent() })).body.error).toBe('This registration code is not valid');
    // The endpoint is public but still wants the request header (no cross-site form posts).
    expect((await submit({ code: c.code, ...someAgent() }, {})).status).toBe(403);
    const reasons = (await audit('registration.submit')).filter((x) => x.result === 'failure').map((x) => x.metadata.reason);
    expect(reasons).toEqual(expect.arrayContaining(['code used', 'code expired', 'code revoked', 'unknown code']));
    expect((await m.api('GET', '/api/v1/registration-codes')).body.map((x: any) => x.status).sort()).toEqual(['EXPIRED', 'REVOKED', 'USED']);
  });

  it('locks out an address after ten wrong codes, even for a right one', async () => {
    m = await startManager({ config: FAST });
    for (let i = 0; i < 10; i++) expect((await submit({ code: `SMR-${'ABCDE'.repeat(4)}-${String(i).padStart(5, '0')}`, ...someAgent() })).status).toBe(403);
    const c = await createCode();
    expect((await submit({ code: c.code, ...someAgent() })).status).toBe(429);
    // The code was not used up by the refused attempt.
    expect((await m.api('GET', '/api/v1/registration-codes')).body[0].status).toBe('ACTIVE');
  });
});

describe.skipIf(!hasOpenssl)('registering a server', () => {
  it('code → register → approve → online, with the real servermin-agent program, and no restart', async () => {
    const tls = await tlsManager();
    const a = await newServer();
    expect(await link(a)).toMatchObject({ configured: false, state: 'DISABLED' });
    const c = await createCode();
    expect(c.fingerprint).toBe(tls.fingerprint);
    expect(c.command).toBe(`servermin-agent register ${c.code} --manager ${m!.url} --fingerprint ${tls.fingerprint}`);

    // Exactly the command the Manager printed, run as a program.
    // Asynchronously: the Manager runs in this process and must keep answering.
    const cli = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [join(ROOT, 'packages/cli/dist/servermin-agent.js'), 'register', ...argsOf(c.command)], { env: { PATH: process.env.PATH!, ...envOf(a) } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    expect(cli.stderr).toBe('');
    expect(cli.status).toBe(0);
    expect(cli.stdout).toMatch(/Registered with the Servermin Manager at https:\/\/127\.0\.0\.1:\d+ \(registration [0-9a-f-]{36}\)\.\nWaiting for approval/);
    const file = join(stateDir(a), 'manager.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ url: m!.url, fingerprint: tls.fingerprint, ca: null, insecure: false });

    // The running agent picked the registration up by itself and is refused until approved.
    const waiting = await waitFor(() => link(a), (l) => l.configured && l.attempts >= 1, 5000);
    expect(waiting).toMatchObject({ source: 'registration' });
    const [pending] = (await m!.api('GET', '/api/v1/registrations?status=pending')).body;
    expect(pending).toMatchObject({ status: 'PENDING', agentId: a.platform.agent.identity.agentId, claimedServerId: a.platform.agent.identity.serverId, keyFingerprint: a.platform.agent.key.fingerprint, codeId: c.id });
    expect((await m!.api('GET', '/api/v1/servers')).body).toEqual([]);

    const approved = await m!.api('POST', `/api/v1/registrations/${pending.id}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const serverId = approved.body.server.id;
    // A new server keeps the id the agent already had, so nothing changes on the agent.
    expect(serverId).toBe(a.platform.agent.identity.serverId);
    expect(approved.body.server).toMatchObject({ name: expect.any(String), agentId: a.platform.agent.identity.agentId, agentKeyFingerprint: a.platform.agent.key.fingerprint });
    await waitFor(async () => (await m!.api('GET', `/api/v1/servers/${serverId}`)).body.state, (s) => s === 'ONLINE', 8000);
    expect(await link(a)).toMatchObject({ state: 'CONNECTED', source: 'registration' });

    const actions = ((await m!.api('GET', '/api/v1/audit')).body as any[]).map((x) => `${x.action}:${x.result}`);
    expect(actions).toEqual(expect.arrayContaining(['registration.code.create:success', 'registration.submit:success', 'registration.approve:success']));
    expect((await m!.api('GET', `/api/v1/registrations/${pending.id}`)).body).toMatchObject({ status: 'APPROVED', decidedBy: 'admin', serverId });
  }, 30_000);

  it('an auto-approving code makes the server managed without a person', async () => {
    const tls = await tlsManager();
    const a = await newServer();
    const c = await createCode({ autoApprove: true, name: 'Neptune' });
    const out = await register(argsOf(c.command), envOf(a));
    expect(out).toMatch(/Approved: this server is [0-9a-f-]{36} in the Manager/);
    const server = (await m!.api('GET', '/api/v1/servers')).body[0];
    expect(server).toMatchObject({ name: 'Neptune', agentId: a.platform.agent.identity.agentId });
    await waitFor(async () => (await m!.api('GET', `/api/v1/servers/${server.id}`)).body.state, (s) => s === 'ONLINE', 8000);
    expect((await audit('registration.approve'))[0]).toMatchObject({ user: `code:${c.id}`, result: 'success' });
    expect(tls.fingerprint).toBe(c.fingerprint);
  }, 20_000);

  it('a code for an existing server re-registers a reinstalled agent: new key, same server, id adopted', async () => {
    await tlsManager();
    const old = await newServer();
    const first = await createCode({ autoApprove: true, name: 'Mars' });
    await register(argsOf(first.command), envOf(old));
    const server = (await m!.api('GET', '/api/v1/servers')).body[0];
    await waitFor(async () => (await m!.api('GET', `/api/v1/servers/${server.id}`)).body.state, (s) => s === 'ONLINE', 8000);
    await old.stop();
    agents = agents.filter((x) => x !== old);

    // The machine is reinstalled: a new agent id, a new key, a new local server id.
    const fresh = await newServer();
    expect(fresh.platform.agent.identity.serverId).not.toBe(server.id);
    const again = await createCode({ serverId: server.id });
    await register(argsOf(again.command), envOf(fresh));
    const [pending] = (await m!.api('GET', '/api/v1/registrations?status=pending')).body;
    expect((await m!.api('POST', `/api/v1/registrations/${pending.id}/approve`, { name: 'Renamed' })).status).toBe(400);
    const approved = await m!.api('POST', `/api/v1/registrations/${pending.id}/approve`, {});
    expect(approved.body.server).toMatchObject({ id: server.id, name: 'Mars', agentId: fresh.platform.agent.identity.agentId, agentKeyFingerprint: fresh.platform.agent.key.fingerprint });
    await waitFor(async () => (await m!.api('GET', `/api/v1/servers/${server.id}`)).body.state, (s) => s === 'ONLINE', 8000);
    // The agent took on the server id the Manager knows it by.
    await waitFor(() => fresh.platform.agent.identity.serverId, (id) => id === server.id, 5000);
    expect((await m!.api('GET', '/api/v1/servers')).body).toHaveLength(1);
  }, 30_000);

  it('a code without a server never attaches the agent to an existing one', async () => {
    await tlsManager();
    const a = await newServer();
    // Someone already created a server with this agent's local server id (or the agent claims one).
    const existing = (await m!.api('POST', '/api/v1/servers', { name: 'Existing', id: a.platform.agent.identity.serverId })).body;
    const c = await createCode();
    await register(argsOf(c.command), envOf(a));
    const [pending] = (await m!.api('GET', '/api/v1/registrations?status=pending')).body;
    const approved = (await m!.api('POST', `/api/v1/registrations/${pending.id}/approve`, { name: 'New one' })).body;
    expect(approved.server.id).not.toBe(existing.id);
    expect((await m!.api('GET', `/api/v1/servers/${existing.id}`)).body.agentId).toBeNull();
    // The agent connects as the new server and adopts its id.
    await waitFor(async () => (await m!.api('GET', `/api/v1/servers/${approved.server.id}`)).body.state, (s) => s === 'ONLINE', 8000);
    await waitFor(() => a.platform.agent.identity.serverId, (id) => id === approved.server.id, 5000);

    // Registering the same agent again with another unbound code is refused at approval.
    const c2 = await createCode();
    await register(argsOf(c2.command), envOf(a));
    const [second] = (await m!.api('GET', '/api/v1/registrations?status=pending')).body;
    const refused = await m!.api('POST', `/api/v1/registrations/${second.id}/approve`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/already enrolled for server .* create a code for that server/);
    expect((await m!.api('GET', '/api/v1/servers')).body).toHaveLength(2);
  }, 30_000);

  it('a rejected registration stays refused, and cannot be approved later', async () => {
    await tlsManager();
    const a = await newServer();
    const c = await createCode();
    await register(argsOf(c.command), envOf(a));
    const [pending] = (await m!.api('GET', '/api/v1/registrations?status=pending')).body;
    expect((await m!.api('POST', `/api/v1/registrations/${pending.id}/reject`, { reason: 'not ours' })).body).toMatchObject({ status: 'REJECTED', reason: 'not ours', decidedBy: 'admin' });
    expect((await m!.api('POST', `/api/v1/registrations/${pending.id}/approve`, {})).status).toBe(409);
    await waitFor(() => link(a), (l) => l.attempts >= 2, 5000);
    expect((await link(a)).state).not.toBe('CONNECTED');
    expect((await m!.api('GET', '/api/v1/servers')).body).toEqual([]);
  }, 20_000);

  it('sends nothing to a Manager with another certificate, and explains an untrusted one', async () => {
    const tls = await tlsManager();
    const a = await newServer();
    const c = await createCode();
    const wrong = argsOf(c.command).map((x) => (x === tls.fingerprint ? 'ab'.repeat(32) : x));
    await expect(register(wrong, envOf(a))).rejects.toThrow(/presented certificate [0-9a-f]{64}, not abab.*Nothing was sent/);
    const unpinned = argsOf(c.command).slice(0, 3);
    await expect(register(unpinned, envOf(a))).rejects.toThrow(new RegExp(`not trusted .*Nothing was sent\\.\\nIt presented the certificate SHA-256 ${tls.fingerprint}`, 's'));
    // The code is still unused: it never reached the Manager.
    expect((await m!.api('GET', '/api/v1/registration-codes')).body[0].status).toBe('ACTIVE');
    expect(await audit('registration.submit')).toEqual([]);
    expect(existsSync(join(stateDir(a), 'manager.json'))).toBe(false);
    // Trusting the certificate as a CA works too.
    await register([...unpinned, '--ca', tls.cert], envOf(a));
    expect(JSON.parse(readFileSync(join(stateDir(a), 'manager.json'), 'utf8'))).toMatchObject({ fingerprint: null, ca: tls.cert });
  }, 20_000);

  it('leave disconnects the agent and makes it standalone again, without a restart', async () => {
    await tlsManager();
    const a = await newServer();
    const c = await createCode({ autoApprove: true });
    await register(argsOf(c.command), envOf(a));
    const server = (await m!.api('GET', '/api/v1/servers')).body[0];
    await waitFor(async () => (await m!.api('GET', `/api/v1/servers/${server.id}`)).body.state, (s) => s === 'ONLINE', 8000);
    expect(leave(envOf(a))).toMatch(/has left the Manager at https:\/\/127\.0\.0\.1:\d+ and runs standalone/);
    await waitFor(() => link(a), (l) => l.state === 'DISABLED', 5000);
    await waitFor(async () => (await m!.api('GET', `/api/v1/servers/${server.id}`)).body.state, (s) => s === 'OFFLINE', 5000);
    expect(leave(envOf(a))).toBe('This agent is not registered with a Manager.\n');
  }, 20_000);
});

describe('servermin-agent register, refusals before any network', () => {
  it('needs a code and a Manager, refuses http:// without --insecure, and defers to agent.manager in the configuration file', async () => {
    const a = await newServer();
    await expect(register([], envOf(a))).rejects.toThrow(CliError);
    await expect(register(['SMR-X'], envOf(a))).rejects.toThrow(/--manager is required/);
    await expect(register(['SMR-X', '--manager', 'http://m:8480'], envOf(a))).rejects.toThrow(/not encrypted/);
    await expect(register(['SMR-X', '--manager', 'https://m', '--fingerprint', 'xyz'], envOf(a))).rejects.toThrow(/64 hex digits/);
    const config = join(a.dir, 'config.json');
    writeFileSync(config, JSON.stringify({ agent: { manager: { url: 'https://other:8480' } } }));
    await expect(register(['SMR-X', '--manager', 'https://m'], { ...envOf(a), SERVERMIN_CONFIG: config })).rejects.toThrow(/already names a Manager .* takes precedence/);
    const empty = mkdtempSync(join(tmpdir(), 'servermin-noagent-'));
    cleanups.push(() => rmSync(empty, { recursive: true, force: true }));
    await expect(register(['SMR-X', '--manager', 'https://m'], { SERVERMIN_CONFIG: join(empty, 'none'), SERVERMIN_DATA_DIR: empty })).rejects.toThrow(/start the agent once/);
  });

  it('an unusable registration file leaves the agent standalone and says why', async () => {
    const a = await newServer();
    writeFileSync(join(stateDir(a), 'manager.json'), JSON.stringify({ url: 'ftp://nope' }));
    await waitFor(() => link(a), (l) => l.state === 'DISABLED', 1000);
    await new Promise((r) => setTimeout(r, 200));
    expect((await link(a)).configured).toBe(false);
  });
});
