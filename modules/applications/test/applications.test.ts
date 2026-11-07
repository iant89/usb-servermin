import { describe, expect, it } from 'vitest';
import { createTestContext } from '@servermin/sdk/testing';
import manifest from '../module.json';
import applications from '../src/backend/index';
import { containerSpec, validateApp } from '../src/backend/model';

function fakeDocker() {
  const containers: any[] = [];
  const calls: string[] = [];
  return {
    calls,
    impl: {
      pullImage: (image: string) => (calls.push(`pull ${image}`), { image }),
      listContainers: (f: any) => containers.filter((c) => !f?.label || c.labels['servermin.app'] === f.label[0].split('=')[1]),
      removeContainer: (id: string) => (calls.push(`rm ${id}`), containers.splice(containers.findIndex((c) => c.id === id), 1)),
      createContainer: (name: string, spec: any) => {
        calls.push(`create ${name} ${spec.Image}`);
        const c = { id: `id-${containers.length + 1}`, name, state: 'created', status: 'Created', labels: spec.Labels, spec };
        containers.push(c);
        return { Id: c.id };
      },
      startContainer: (id: string) => {
        const c = containers.find((x) => x.id === id);
        c.state = c.spec.Image.includes('broken') ? 'exited' : 'running';
      },
      inspectContainer: (id: string) => {
        const c = containers.find((x) => x.id === id);
        return { State: { Running: c.state === 'running', ExitCode: c.state === 'running' ? 0 : 1 } };
      },
      containerLogs: () => ['log line'],
      stopContainer: (id: string) => (containers.find((x) => x.id === id).state = 'exited'),
    },
  };
}

const webApp = { id: 'web', name: 'Web', type: 'docker', version: '1.25', spec: { image: 'nginx' }, ports: ['8080:80'], environment: { MODE: 'prod', API_TOKEN: 's3cret' }, domains: ['web.local'] };

describe('application model', () => {
  it('validates applications', () => {
    expect(validateApp({ ...webApp, type: 'docker' } as any, true)).toEqual([]);
    const p = validateApp({ id: 'Bad', name: '', type: 'docker', version: 'v 1', spec: {}, ports: ['99999:80', '8080:80', '8080:81'], domains: ['-x'], environment: { '1A': 'x' } } as any, true);
    expect(p.join('\n')).toMatch(/id:.*\n.*name.*\n.*version.*\n.*spec.image.*\n.*99999:80.*\n.*host port 8080 is used twice.*\n.*-x.*\n.*1A/);
  });
  it('builds container specs for every container-based type', () => {
    const base = { ...webApp, deployedVersion: null, createdAt: '', updatedAt: '', description: '' } as any;
    expect(containerSpec(base, '1.25').spec).toMatchObject({ Image: 'nginx:1.25', HostConfig: { PortBindings: { '80/tcp': [{ HostPort: '8080' }] } }, Labels: { 'servermin.app': 'web', 'servermin.domains': 'web.local' } });
    expect(containerSpec({ ...base, type: 'static', spec: { directory: '/srv/site' } }, 'x').spec.HostConfig.Binds).toContain('/srv/site:/usr/share/nginx/html:ro');
    expect(containerSpec({ ...base, type: 'node', spec: { directory: '/srv/api', nodeVersion: '20' } }, 'x').spec).toMatchObject({ Image: 'node:20-alpine', WorkingDir: '/app' });
  });
});

describe('applications module', () => {
  it('creates and deploys an application through the docker.engine service', async () => {
    const d = fakeDocker();
    const t = createTestContext(manifest as any, { services: { 'docker.engine': d.impl } });
    await t.start(applications);
    expect((await t.request('POST', '/apps', { body: webApp })).status).toBe(200);
    const listed = (await t.request<any[]>('GET', '/apps')).body[0];
    expect(listed.environment.API_TOKEN).toBe('••••••••');
    expect(listed.status.state).toBe('not-deployed');
    const dep = await t.request<any>('POST', '/apps/web/deploy', { body: {} });
    expect(dep.status).toBe(200);
    expect(d.calls).toEqual(['pull nginx:1.25', 'create app-web nginx:1.25']);
    expect((await t.request<any>('GET', '/apps/web')).body).toMatchObject({ deployedVersion: '1.25', status: { state: 'running' } });
    // Redeploying a new version replaces the old container.
    await t.request('POST', '/apps/web/deploy', { body: { version: '1.26' } });
    expect(d.calls.slice(2)).toEqual(['pull nginx:1.26', 'rm id-1', 'create app-web nginx:1.26']);
    // The secret survives an edit that sends it back redacted.
    await t.request('PUT', '/apps/web', { body: { environment: { MODE: 'dev', API_TOKEN: '••••••••' } } });
    const row = await t.context.database.get<any>('SELECT environment FROM applications');
    expect(JSON.parse(row.environment)).toEqual({ MODE: 'dev', API_TOKEN: 's3cret' });
    const deployments = (await t.request<any[]>('GET', '/apps/web/deployments')).body;
    expect(deployments.map((x) => [x.version, x.status])).toEqual([['1.26', 'succeeded'], ['1.25', 'succeeded']]);
    expect(t.published.map((e) => e.type)).toContain('applications.deployment.succeeded');
    await t.stop();
  });

  it('records failed deployments and notifies', async () => {
    const d = fakeDocker();
    const t = createTestContext(manifest as any, { services: { 'docker.engine': d.impl } });
    await t.start(applications);
    await t.request('POST', '/apps', { body: { ...webApp, spec: { image: 'broken' } } });
    const r = await t.request<any>('POST', '/apps/web/deploy', { body: {} });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/exited/);
    expect((await t.request<any[]>('GET', '/apps/web/deployments')).body[0].status).toBe('failed');
    expect(t.notifications[0].title).toMatch(/failed/);
    expect((await t.runHealthChecks())[0].status).toBe('DEGRADED');
    await t.stop();
  });

  it('explains when the Docker module is unavailable', async () => {
    const t = createTestContext(manifest as any);
    await t.start(applications);
    await t.request('POST', '/apps', { body: webApp });
    const r = await t.request<any>('POST', '/apps/web/deploy', { body: {} });
    expect(r.status).toBe(503);
    expect(r.body.details.reason).toBe('dependency-unavailable');
    expect((await t.request<any[]>('GET', '/apps')).body[0].status.state).toBe('unknown');
    await t.stop();
  });
});
