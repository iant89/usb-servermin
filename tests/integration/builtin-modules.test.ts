import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT, startServer, waitFor, type TestServer } from './helpers';

const BUILT_IN = ['applications', 'docker', 'logs', 'monitoring', 'network', 'services', 'storage', 'system', 'terminal'];
let s: TestServer;

beforeAll(async () => {
  // Bundled modules are installed on first start through the regular pipeline (§58).
  s = await startServer({ preinstall: [join(ROOT, 'modules')] });
});
afterAll(() => s?.stop());

describe('built-in modules (§32)', () => {
  it('are installed through the module system and become active', async () => {
    const list = (await s.api('GET', '/api/v1/platform/modules')).body;
    expect(list.map((m: any) => m.id).sort()).toEqual(BUILT_IN);
    for (const m of list) expect([m.id, m.state, m.integrity]).toEqual([m.id, 'ACTIVE', 'verified']);
  });

  it('each serves its API through the core gateway', async () => {
    const calls: [string, string][] = [
      ['system', '/info'],
      ['storage', '/mounts'],
      ['services', '/summary'],
      ['monitoring', '/metrics'],
      ['applications', '/apps'],
      ['terminal', '/status'],
      ['docker', '/status'],
    ];
    for (const [id, path] of calls) {
      const r = await s.api('GET', `/api/v1/modules/${id}${path}`);
      // Hosts without systemd (containers, CI) answer 502 from the services module; anything else must be 200.
      const ok = r.status === 200 || (id === 'services' && r.status === 502 && /systemd/.test(r.body.error));
      expect([id, r.status, ok ? '' : JSON.stringify(r.body)]).toEqual([id, r.status, '']);
    }
  });

  it('keeps the platform up when Docker Engine is unreachable (§60)', async () => {
    await s.api('PUT', '/api/v1/platform/modules/docker/config', { socketPath: '/nonexistent/docker.sock' });
    await s.platform.modules.checkHealth();
    const docker = (await s.api('GET', '/api/v1/platform/modules/docker')).body;
    expect(docker.state).toBe('ACTIVE');
    expect(docker.health).toMatchObject({ status: 'ERROR' });
    expect(docker.health.message).toMatch(/Unable to communicate with Docker Engine/);
    expect((await s.api('GET', '/api/v1/modules/system/info')).status).toBe(200);
    expect((await s.api('GET', '/api/v1/health')).body.status).toBe('DEGRADED');
  });

  it('applications keeps working without Docker, and reports the missing dependency', async () => {
    await s.api('POST', '/api/v1/platform/modules/docker/disable');
    expect((await s.api('GET', '/api/v1/platform/modules/applications')).body.state).toBe('ACTIVE');
    expect((await s.api('GET', '/api/v1/modules/applications/capabilities')).body).toEqual({ docker: false, systemd: true });
    await s.api('POST', '/api/v1/modules/applications/apps', { id: 'web', name: 'Web', type: 'docker', version: 'latest', spec: { image: 'nginx' }, ports: [], domains: [], environment: {} });
    const deploy = await s.api('POST', '/api/v1/modules/applications/apps/web/deploy', {});
    expect(deploy.status).toBe(503);
    expect(deploy.body.details.reason).toBe('dependency-unavailable');
    await s.api('POST', '/api/v1/platform/modules/docker/enable');
  });

  it('module metrics reach the monitoring module through events', async () => {
    s.platform.bus.publish('storage.metrics', { metrics: [{ name: 'usage.root', value: 42, unit: '%' }] }, 'storage');
    await waitFor(async () => (await s.api('GET', '/api/v1/modules/monitoring/metrics')).body.map((m: any) => m.name), (names: string[]) => names.includes('storage.usage.root'));
  });

  it('exposes every module permission in the catalogue for user management', async () => {
    const ids = (await s.api('GET', '/api/v1/permissions')).body.permissions.map((p: any) => p.id);
    for (const p of ['system.power', 'docker.execute', 'storage.write', 'network.write', 'services.write', 'applications.deploy', 'logs.read', 'terminal.access', 'monitoring.read', 'modules.install']) expect(ids).toContain(p);
  });
});
