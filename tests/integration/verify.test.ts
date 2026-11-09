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
