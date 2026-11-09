import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, testUser } from '@servermin/sdk/testing';
import manifest from '../module.json';
import docker from '../src/backend/index';
import { cpuPercent, demux, summarizeContainer } from '../src/backend/docker-client';

function frame(stream: 1 | 2, text: string) {
  const body = Buffer.from(text);
  const h = Buffer.alloc(8);
  h[0] = stream;
  h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
}

/** A tiny fake Docker Engine on a Unix socket. */
function fakeEngine(socket: string) {
  const calls: string[] = [];
  const state = { running: true };
  const container = () => ({ Id: 'abc123def4567890', Names: ['/web'], Image: 'nginx:latest', State: state.running ? 'running' : 'exited', Status: 'Up', Created: 1700000000, Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: 'tcp', IP: '0.0.0.0' }], Labels: { 'com.docker.compose.project': 'site', 'com.docker.compose.service': 'web' } });
  const server: Server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const url = new URL(req.url!, 'http://d');
    const json = (status: number, body: unknown) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(body)));
    if (url.pathname === '/_ping') return res.end('OK');
    if (url.pathname === '/events') return res.writeHead(200).write('');
    if (url.pathname === '/version') return json(200, { Version: '27.0.1', ApiVersion: '1.46' });
    if (url.pathname === '/info') return json(200, { Containers: 1, ContainersRunning: state.running ? 1 : 0, ContainersPaused: 0, ContainersStopped: state.running ? 0 : 1, Images: 2, NCPU: 4, MemTotal: 1e9, Driver: 'overlay2' });
    if (url.pathname === '/containers/json') return json(200, [container()]);
    if (url.pathname === '/containers/abc123/stop') {
      if (!state.running) return json(304, { message: 'not running' });
      state.running = false;
      return res.writeHead(204).end();
    }
    if (url.pathname === '/containers/abc123/logs') return res.writeHead(200).end(Buffer.concat([frame(1, '2024-01-01T00:00:01Z hello\n'), frame(2, '2024-01-01T00:00:02Z oops\n')]));
    if (url.pathname === '/containers/abc123/exec') return json(201, { Id: 'exec1' });
    if (url.pathname === '/exec/exec1/start') return res.writeHead(200).end(frame(1, 'root\n'));
    if (url.pathname === '/exec/exec1/json') return json(200, { ExitCode: 0 });
    if (url.pathname === '/images/create') return res.writeHead(200).end('{"status":"Pulling"}\n{"status":"Downloaded newer image for alpine:3"}\n');
    json(404, { message: `no such route ${url.pathname}` });
  });
  return new Promise<{ server: Server; calls: string[] }>((r) => server.listen(socket, () => r({ server, calls })));
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'docker-test-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('docker helpers', () => {
  it('demultiplexes stdout and stderr frames', () => {
    expect(demux(Buffer.concat([frame(1, 'out'), frame(2, 'err'), frame(1, '!')]))).toEqual({ stdout: 'out!', stderr: 'err' });
  });
  it('computes CPU percentage from stats deltas', () => {
    expect(cpuPercent({ cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 2 }, precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 } })).toBe(20);
  });
  it('summarises containers with compose metadata and ports', () => {
    const c = summarizeContainer({ Id: 'x'.repeat(64), Names: ['/a'], Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }], Labels: { 'com.docker.compose.project': 'p' } });
    expect(c).toMatchObject({ name: 'a', shortId: 'x'.repeat(12), ports: ['8080→80/tcp'], project: 'p' });
  });
});

describe('docker module', () => {
  it('manages containers through the Engine API', async () => {
    const socket = join(dir, 'docker.sock');
    const { server, calls } = await fakeEngine(socket);
    const t = createTestContext(manifest as any, { config: { socketPath: socket }, dataDir: dir });
    await t.start(docker);
    expect((await t.runHealthChecks())[0].status).toBe('HEALTHY');
    const status = await t.request<any>('GET', '/status');
    expect(status.body).toMatchObject({ available: true, version: '27.0.1', containers: { running: 1 } });
    const list = await t.request<any[]>('GET', '/containers');
    expect(list.body[0]).toMatchObject({ name: 'web', project: 'site', ports: ['8080→80/tcp'] });
    expect((await t.request<any>('POST', '/containers/abc123/stop')).body.state).toBe('exited');
    expect((await t.request('POST', '/containers/abc123/stop')).status).toBe(409);
    expect((await t.request<string[]>('GET', '/containers/abc123/logs')).body).toEqual(['2024-01-01T00:00:01Z hello', '2024-01-01T00:00:02Z oops']);
    expect((await t.request<any>('POST', '/containers/abc123/exec', { body: { command: ['whoami'] } })).body).toMatchObject({ exitCode: 0, stdout: 'root\n' });
    expect((await t.request('POST', '/containers/abc123/exec', { body: { command: ['id'] }, user: testUser(['docker.read', 'docker.write']) })).status).toBe(403);
    expect((await t.request<any>('POST', '/images/pull', { body: { image: 'alpine:3' } })).body).toMatchObject({ image: 'alpine:3' });
    expect(calls).toContain('POST /images/create?fromImage=alpine&tag=3');
    expect((await t.request('GET', '/containers/..%2Fetc')).status).toBe(400);
    const projects = await t.request<any[]>('GET', '/compose');
    expect(projects.body[0]).toMatchObject({ name: 'site', services: ['web'], total: 1 });
    expect(await t.context.services.call('docker.engine', 'listContainers')).toHaveLength(1);
    await t.stop();
    server.close();
  });

  it('tracks health across a socket change without stale or duplicate connections', async () => {
    const socket = join(dir, 'docker.sock');
    const { server, calls } = await fakeEngine(socket);
    const t = createTestContext(manifest as any, { config: { socketPath: socket }, dataDir: dir });
    await t.start(docker);
    expect((await t.runHealthChecks())[0].status).toBe('HEALTHY');
    t.setConfig({ socketPath: join(dir, 'missing.sock') });
    // Health must not keep reporting the old, healthy connection while the new one is attempted.
    expect((await t.runHealthChecks())[0].status).not.toBe('HEALTHY');
    await new Promise((r) => setTimeout(r, 100));
    expect((await t.runHealthChecks())[0]).toMatchObject({ status: 'ERROR', message: expect.stringMatching(/Unable to communicate/) });
    // Switching back reconnects once; the closed stream must not flip health back to ERROR.
    t.setConfig({ socketPath: socket });
    await new Promise((r) => setTimeout(r, 200));
    expect((await t.runHealthChecks())[0].status).toBe('HEALTHY');
    await new Promise((r) => setTimeout(r, 2500));
    expect((await t.runHealthChecks())[0].status).toBe('HEALTHY');
    expect(calls.filter((c) => c.startsWith('GET /events')).length).toBe(2);
    await t.stop();
    server.close();
  });

  it('reports ERROR health when Docker Engine is unreachable, without failing', async () => {
    const t = createTestContext(manifest as any, { config: { socketPath: join(dir, 'missing.sock') }, dataDir: dir });
    await t.start(docker);
    const [h] = await t.runHealthChecks();
    expect(h.status).toBe('ERROR');
    expect(h.message).toMatch(/Unable to communicate with Docker Engine/);
    const status = await t.request<any>('GET', '/status');
    expect(status.body.available).toBe(false);
    expect((await t.request('GET', '/containers')).status).toBe(503);
    await t.stop();
  });
});
