import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT, startServer, type TestServer } from './helpers';

let s: TestServer;
let report: any;

beforeAll(async () => {
  s = await startServer({ preinstall: [join(ROOT, 'modules')] });
  const token = (await s.api('POST', '/api/v1/auth/tokens', { name: 'verify' })).body.token;
  const out = join(s.dir, 'report.json');
  // The verifier is a separate process talking to the API, exactly as on a real server.
  const r = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, 'packages/cli/dist/verify.js'), '--url', s.url, '--token', token, '--config', join(s.dir, 'missing.json'), '--json', out], { env: { ...process.env, SERVERCTL_CONFIG: join(s.dir, 'none') } });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d));
    child.on('close', (code: number | null) => resolve({ code, stdout }));
  });
  expect(r.stdout).toContain('Platform API');
  report = JSON.parse(readFileSync(out, 'utf8'));
});
afterAll(() => s?.stop());

const result = (name: string) => report.results.find((x: any) => x.name.startsWith(name));

describe('servermin-verify', () => {
  it('checks every built-in module through the API', () => {
    expect(result('Web server reachable').status).not.toBe('FAIL');
    expect(result('Authentication')).toMatchObject({ status: 'WARN', detail: expect.stringContaining('admin via API token') });
    expect(result('Built-in modules active')).toMatchObject({ status: 'PASS', detail: '9 modules, all active and verified' });
    expect(result('System: hardware detected')).toMatchObject({ status: 'PASS' });
    expect(result('Monitoring: samples recorded').status).toBe('PASS');
    expect(result('Live channel').status).toBe('PASS');
  });

  it('exercises the privilege boundary and reports simulation honestly', () => {
    expect(result('Privilege boundary')).toMatchObject({ status: 'WARN', detail: expect.stringMatching(/simulated/) });
  });

  it('identifies who the terminal shell runs as', () => {
    const t = result('Terminal');
    const uid = process.getuid?.();
    expect(t.status).toBe(uid === 0 ? 'FAIL' : 'PASS');
    expect(t.detail).toMatch(/runs as \S+ \(uid \d+\)/);
  });

  it('records the hardware so reports from different machines can be compared', () => {
    expect(report.hardware).toMatchObject({ cores: expect.any(Number), memory: expect.any(Number) });
    expect(report.summary.pass).toBeGreaterThan(5);
    expect(result('Configuration')).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/missing/) });
  });
});

describe('servermin-verify when another program owns the port', () => {
  it('says who answered instead of a bare status code', async () => {
    const { createServer } = await import('node:http');
    const impostor = createServer((_req, res) => res.writeHead(404, { server: 'nginx/1.24.0 (Ubuntu)', 'content-type': 'text/html' }).end('<html><body><h1>404 Not Found</h1></body></html>'));
    await new Promise<void>((r) => impostor.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(impostor.address() as any).port}`;
    const out = join(s.dir, 'impostor.json');
    await new Promise((resolve) => spawn(process.execPath, [join(ROOT, 'packages/cli/dist/verify.js'), '--url', url, '--token', 'smt_x', '--config', join(s.dir, 'missing.json'), '--json', out]).on('close', resolve));
    impostor.close();
    const r = JSON.parse(readFileSync(out, 'utf8')).results.find((x: any) => x.name === 'Web server reachable');
    expect(r.status).toBe('FAIL');
    expect(r.detail).toMatch(/^HTTP 404 from "nginx\/1\.24\.0 \(Ubuntu\)" \(<html><body><h1>404 Not Found/);
  });
});

describe('servermin-verify before the first administrator exists', () => {
  it('explains the setup step instead of asking for a password', async () => {
    const fresh = await startServer({}, { login: false });
    const out = join(fresh.dir, 'fresh.json');
    const child = spawn(process.execPath, [join(ROOT, 'packages/cli/dist/verify.js'), '--url', fresh.url, '--user', 'admin', '--config', join(fresh.dir, 'missing.json'), '--json', out], { env: { ...process.env, SERVERCTL_CONFIG: join(fresh.dir, 'none') } });
    child.stdin.end('irrelevant\n');
    await new Promise((resolve) => child.on('close', resolve));
    const r = JSON.parse(readFileSync(out, 'utf8')).results.find((x: any) => x.name === 'Authentication');
    await fresh.stop().catch(() => undefined);
    expect(r).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/no administrator exists yet.*setup token/) });
  });
});
