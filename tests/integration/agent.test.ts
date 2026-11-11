import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Platform } from '../../packages/core/src/index';
import { ROOT, fixture, startServer, waitFor, type TestServer } from './helpers';

let s: TestServer | undefined;
afterEach(async () => {
  await s?.stop().catch(() => undefined);
  s = undefined;
});

const UUID = /^[0-9a-f-]{36}$/;
const agentCli = (env: Record<string, string>, ...args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
    execFile(process.execPath, [join(ROOT, 'packages/cli/dist/servermin-agent.js'), ...args], { env: { PATH: process.env.PATH, HOME: '/nonexistent', ...env } }, (e, stdout, stderr) =>
      resolve({ code: e ? Number((e as any).code ?? 1) : 0, stdout, stderr }),
    ),
  );

describe('agent foundation', () => {
  it('reports identity, host, version and state to signed-in users only', async () => {
    s = await startServer();
    expect((await s.api('GET', '/api/v1/agent', undefined, { cookie: '' })).status).toBe(401);
    const { status, body } = await s.api('GET', '/api/v1/agent');
    expect(status).toBe(200);
    expect(body.serverId).toMatch(UUID);
    expect(body.agentId).toMatch(UUID);
    expect(body).toMatchObject({ state: 'RUNNING', health: 'HEALTHY', capabilities: [], modules: [], version: (await s.api('GET', '/api/v1/health')).body.version });
    expect(body.hostname).toBeTruthy();
    expect(body.os.name).toBeTruthy();
    // The public health probe must not leak the identity.
    expect(JSON.stringify((await s.api('GET', '/api/v1/health', undefined, { cookie: '' })).body)).not.toContain(body.agentId);
    const file = join(s.dir, 'var/lib/servermin/agent/identity.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ agentId: body.agentId, serverId: body.serverId });
  });

  it('gains a capability when a module becomes active and loses it when the module stops or crashes', async () => {
    s = await startServer();
    const caps = async () => (await s!.api('GET', '/api/v1/agent')).body.capabilities;
    expect((await s.api('POST', '/api/v1/platform/modules', { source: 'directory', path: fixture('echo-provider') })).status).toBe(200);
    expect(await waitFor(caps, (c) => c.length > 0)).toEqual(['demo.echo', 'echo-provider']);
    expect((await s.api('GET', '/api/v1/agent')).body.modules).toEqual([expect.objectContaining({ id: 'echo-provider', state: 'ACTIVE', provides: ['demo.echo'] })]);
    await s.api('POST', '/api/v1/platform/modules/echo-provider/disable');
    expect(await waitFor(caps, (c) => c.length === 0)).toEqual([]);
    await s.api('POST', '/api/v1/platform/modules/echo-provider/enable');
    await waitFor(caps, (c) => c.length === 2);

    await s.api('POST', '/api/v1/platform/modules', { source: 'directory', path: fixture('faulty') });
    await waitFor(caps, (c) => c.includes('faulty'));
    await s.api('POST', '/api/v1/modules/faulty/crash').catch(() => undefined);
    const after = await waitFor(async () => (await s!.api('GET', '/api/v1/agent')).body, (b) => !b.capabilities.includes('faulty'));
    expect(after.capabilities).toEqual(['demo.echo', 'echo-provider']);
    expect(after.health).toBe('DEGRADED');
    expect(after.state).toBe('RUNNING');
  });

  it('keeps the same identity across a restart', async () => {
    s = await startServer();
    const before = (await s.api('GET', '/api/v1/agent')).body;
    await s.platform.stop();
    expect(s.platform.agent.state).toBe('STOPPING');
    const again = new Platform(s.platform.config, { workerScript: join(ROOT, '.vitest-tmp/core/module-host.js'), storageScript: join(ROOT, '.vitest-tmp/core/storage-host.js') });
    const quiet = process.stdout.write;
    process.stdout.write = (() => true) as any;
    try {
      await again.start();
    } finally {
      process.stdout.write = quiet;
    }
    try {
      expect(again.agent.identity).toMatchObject({ agentId: before.agentId, serverId: before.serverId });
      expect(again.agent.state).toBe('RUNNING');
    } finally {
      // The helper's stop() would stop the first platform a second time; clean up by hand.
      await again.stop();
      rmSync(s.dir, { recursive: true, force: true });
      s = undefined;
    }
  });

  it('starts with a new identity when the stored one is damaged, keeps the old file and tells the administrator', async () => {
    s = await startServer({}, {
      beforeStart: (_dir, config) => {
        mkdirSync(join(config.paths.data, 'agent'), { recursive: true });
        writeFileSync(join(config.paths.data, 'agent/identity.json'), '{"agentId":');
      },
    });
    const agent = (await s.api('GET', '/api/v1/agent')).body;
    expect(agent.agentId).toMatch(UUID);
    const notes = (await s.api('GET', '/api/v1/notifications')).body;
    const note = (notes.items ?? notes.notifications ?? notes).find((n: any) => n.title === 'Agent identity replaced');
    expect(note.message).toMatch(/identity\.json\.damaged-\d+/);
    expect(readFileSync(note.message.match(/kept as (\S+?)\.?$/)[1], 'utf8')).toBe('{"agentId":');
    const logs = (await s.api('GET', '/api/v1/logs?source=agent&level=ERROR')).body;
    expect(JSON.stringify(logs)).toMatch(/identity file was unreadable/);
  });

  it('stores the identity where agent.stateDir points', async () => {
    let custom = '';
    s = await startServer({}, {
      beforeStart: (dir, config) => {
        custom = join(dir, 'machine-local');
        config.agent.stateDir = custom;
      },
    });
    expect(existsSync(join(custom, 'identity.json'))).toBe(true);
    expect(existsSync(join(s.dir, 'var/lib/servermin/agent'))).toBe(false);
  });
});

describe('servermin-agent command', () => {
  it('asks the running agent when API credentials are available', async () => {
    s = await startServer();
    const token = (await s.api('POST', '/api/v1/auth/tokens', { name: 'cli' })).body.token;
    const agent = (await s.api('GET', '/api/v1/agent')).body;
    const json = await agentCli({ SERVERCTL_URL: s.url, SERVERCTL_TOKEN: token }, 'status', '--json');
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ source: 'api', serverId: agent.serverId, agentId: agent.agentId, state: 'RUNNING', capabilities: [] });
    const text = await agentCli({ SERVERCTL_URL: s.url, SERVERCTL_TOKEN: token }, 'status');
    expect(text.stdout).toMatch(new RegExp(`Server ID\\s+${agent.serverId}`));
    expect(text.stdout).toMatch(/State\s+RUNNING \(health HEALTHY\)/);
    expect((await agentCli({ SERVERCTL_URL: s.url, SERVERCTL_TOKEN: token }, 'id')).stdout).toBe(`${agent.serverId}\n${agent.agentId}\n`);
  });

  it('explains a rejected token and an unreachable agent', async () => {
    s = await startServer();
    const bad = await agentCli({ SERVERCTL_URL: s.url, SERVERCTL_TOKEN: 'smt_wrong' }, 'status');
    expect(bad).toMatchObject({ code: 1, stderr: expect.stringMatching(/token was rejected/) });
    const down = await agentCli({ SERVERCTL_URL: 'http://127.0.0.1:1', SERVERCTL_TOKEN: 'smt_x' }, 'status');
    expect(down).toMatchObject({ code: 1, stderr: expect.stringMatching(/did not answer.*server-control\.service/) });
  });

  it('reads the identity from disk without credentials, and says what it cannot know', async () => {
    s = await startServer();
    const agent = (await s.api('GET', '/api/v1/agent')).body;
    const config = join(s.dir, 'config.json');
    writeFileSync(config, JSON.stringify({ paths: { data: s.platform.config.paths.data, app: join(s.dir, 'app') } }));
    mkdirSync(join(s.dir, 'app'));
    writeFileSync(join(s.dir, 'app/VERSION'), '9.9.9\n');
    const env = { SERVERMIN_CONFIG: config, SERVERMIN_SYSTEMCTL: 'true' };
    const json = JSON.parse((await agentCli(env, 'status', '--json')).stdout);
    expect(json).toMatchObject({ source: 'disk', serverId: agent.serverId, agentId: agent.agentId, version: '9.9.9' });
    expect(json.capabilities).toBeUndefined();
    expect((await agentCli(env, 'status')).stdout).toMatch(/Capabilities\s+not available without API credentials/);

    writeFileSync(config, JSON.stringify({ paths: { data: join(s.dir, 'empty') } }));
    expect(await agentCli(env, 'status')).toMatchObject({ code: 1, stderr: expect.stringMatching(/No agent identity at .*has not started/) });
    expect(await agentCli(env, 'bogus')).toMatchObject({ code: 1, stderr: expect.stringMatching(/Unknown command/) });
  });
});
