import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestContext, testUser } from '@servermin/sdk/testing';
import manifest from '../module.json';
import applications from '../src/backend/index';
import { CATALOG, generatePassword, resolveParams, templatePorts, templateVariables } from '../src/backend/catalog';
import { composeWithVersion, validateApp } from '../src/backend/model';
import { dotenv } from '../../docker/src/backend/index';

const SECRET_RE = /(pass|secret|token|key)/i;
const random = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => (i * 37) % 256));
const resolve = (t: (typeof CATALOG)[number], values: Record<string, unknown> = {}) => resolveParams(t, values, { random, timezone: 'Europe/Berlin' });

describe('catalogue templates', () => {
  it('have unique ids and complete metadata', () => {
    expect(new Set(CATALOG.map((t) => t.id)).size).toBe(CATALOG.length);
    for (const t of CATALOG) {
      expect(t.id).toMatch(/^[a-z][a-z0-9-]{1,30}$/);
      expect(t.website).toMatch(/^https:\/\//);
      expect(t.compose).toMatch(/^services:/);
      expect(t.compose).toContain('${APP_VERSION}');
      if (t.web?.port) expect(t.params.map((p) => p.key)).toContain(t.web.port);
      if (t.web) expect(t.web.port ?? t.web.fixedPort).toBeTruthy();
    }
  });

  it.each(CATALOG.map((t) => [t.id, t] as const))('%s declares every variable its compose file uses, and hides its secrets', (_id, t) => {
    expect(templateVariables(t.compose).sort()).toEqual(t.params.map((p) => p.key).sort());
    for (const p of t.params) {
      if (p.type === 'password') expect(p.key, `${t.id}.${p.key} must be hidden in the UI`).toMatch(SECRET_RE);
      if (p.type === 'port') expect(p.containerPort).toBeGreaterThan(0);
      if (p.type === 'select') expect(p.options?.map((o) => o.value)).toContain(p.default);
    }
  });

  it.each(CATALOG.map((t) => [t.id, t] as const))('%s installs as a valid application with its defaults', (_id, t) => {
    const { env, problems } = resolve(t);
    expect(problems).toEqual([]);
    for (const p of t.params) if (p.generate === 'password') expect(env[p.key]).toMatch(/^[A-Za-z0-9]{24}$/);
    const app = { id: t.id, name: t.name, type: 'compose', version: t.version, spec: { compose: t.compose }, environment: env, ports: templatePorts(t, env), domains: [] } as any;
    expect(validateApp(app, true)).toEqual([]);
  });

  // The strongest check available without pulling images: Docker Compose itself parses and
  // interpolates every template with its default values.
  const compose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
  it.skipIf(!compose).each(CATALOG.map((t) => [t.id, t] as const))('%s is accepted by docker compose config', (_id, t) => {
    const dir = mkdtempSync(join(tmpdir(), 'sm-catalog-'));
    try {
      const { env } = resolve(t, { MEDIA_PATH: '/srv/media', SYNC_PATH: '/srv/sync' });
      writeFileSync(join(dir, 'compose.yaml'), composeWithVersion({ id: t.id, spec: { compose: t.compose } } as any, t.version));
      writeFileSync(join(dir, '.env'), dotenv(env));
      const r = spawnSync('docker', ['compose', '-p', `sm-${t.id}`, '-f', join(dir, 'compose.yaml'), 'config', '--quiet'], { encoding: 'utf8', cwd: dir });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('catalogue parameters', () => {
  const nextcloud = CATALOG.find((t) => t.id === 'nextcloud')!;
  const jellyfin = CATALOG.find((t) => t.id === 'jellyfin')!;
  it('rejects values that would break the .env file or reach system folders', () => {
    expect(resolve(nextcloud, { ADMIN_PASSWORD: "it's-a-secret" }).problems.join()).toMatch(/single quotes/);
    expect(resolve(nextcloud, { ADMIN_PASSWORD: 'short' }).problems.join()).toMatch(/at least 8/);
    expect(resolve(nextcloud, { ADMIN_PASSWORD: 'has$dollar1' }).problems.join()).toMatch(/\$/);
    expect(resolve(nextcloud, { HTTP_PORT: '70000' }).problems.join()).toMatch(/port number/);
    expect(resolve(jellyfin, { MEDIA_PATH: '/etc' }).problems.join()).toMatch(/system folder/);
    expect(resolve(jellyfin, { MEDIA_PATH: '/var/lib/servermin/x' }).problems.join()).toMatch(/system folder/);
    expect(resolve(jellyfin, { MEDIA_PATH: '/srv/../etc' }).problems.join()).toMatch(/absolute path/);
    expect(resolve(jellyfin, { MEDIA_PATH: '/srv/films/' }).env.MEDIA_PATH).toBe('/srv/films');
  });
  it('binds databases to localhost unless asked otherwise', () => {
    const pg = CATALOG.find((t) => t.id === 'postgres')!;
    expect(templatePorts(pg, resolve(pg).env)).toEqual(['127.0.0.1:5432:5432']);
    expect(templatePorts(pg, resolve(pg, { LISTEN_ADDRESS: '0.0.0.0' }).env)).toEqual(['5432:5432']);
  });
  it('generates unbiased passwords from the safe alphabet', () => {
    const p = generatePassword((n) => crypto.getRandomValues(new Uint8Array(n)));
    expect(p).toMatch(/^[A-HJ-NP-Za-km-z2-9]{24}$/);
  });
  it('renders .env values literally', () => {
    expect(dotenv({ A: 'x y$z', B: '' })).toBe("A='x y$z'\nB=''\n");
    expect(() => dotenv({ A: "it's" })).toThrow(/single quotes/);
  });
});

function fakeDocker() {
  const up: { project: string; yaml: string; env: Record<string, string> }[] = [];
  return {
    up,
    impl: {
      composeUp: (project: string, yaml: string, env: Record<string, string>) => (up.push({ project, yaml, env }), { output: 'started' }),
      composeContainers: (project: string) => (up.some((u) => u.project === project) ? [{ id: 'c1', name: `${project}-app-1`, state: 'running', service: 'app' }] : []),
      listContainers: () => [],
    },
  };
}

describe('installing from the catalogue', () => {
  it('installs, generates secrets, deploys in the background and redacts', async () => {
    const d = fakeDocker();
    const t = createTestContext(manifest as any, { services: { 'docker.engine': d.impl } });
    await t.start(applications);
    const list = (await t.request<any>('GET', '/catalog')).body;
    expect(list.templates.length).toBe(CATALOG.length);
    expect(list.templates[0].compose).toBeUndefined();
    const detail = (await t.request<any>('GET', '/catalog/vaultwarden')).body;
    expect(detail.suggested).toMatchObject({ appId: 'vaultwarden', values: { SIGNUPS_ALLOWED: 'true' } });

    const r = await t.request<any>('POST', '/catalog/vaultwarden/install', { body: { values: { HTTP_PORT: detail.suggested.values.HTTP_PORT } } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ deploying: true, app: { id: 'vaultwarden', type: 'compose', spec: { catalog: { id: 'vaultwarden', web: { port: 'HTTP_PORT' } } } } });
    expect(r.body.app.environment.ADMIN_TOKEN).toBe('••••••••');
    await expect.poll(() => d.up.length).toBe(1);
    expect(d.up[0].env.ADMIN_TOKEN).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(d.up[0].yaml).toContain('vaultwarden/server:latest');
    await expect.poll(async () => (await t.request<any>('GET', '/apps/vaultwarden')).body.deployedVersion).toBe('latest');

    // A second copy gets a new id, and the port the first one uses is refused.
    const again = (await t.request<any>('GET', '/catalog/vaultwarden')).body;
    expect(again.suggested.appId).toBe('vaultwarden-2');
    expect(again.suggested.values.HTTP_PORT).not.toBe(detail.suggested.values.HTTP_PORT);
    const clash = await t.request<any>('POST', '/catalog/vaultwarden/install', { body: { id: 'vault2', values: { HTTP_PORT: detail.suggested.values.HTTP_PORT } } });
    expect(clash.status).toBe(400);
    expect(clash.body.details.join()).toMatch(/already used by Vaultwarden/);
    expect((await t.request<any>('GET', '/catalog')).body.templates.find((x: any) => x.id === 'vaultwarden').installed).toEqual(['vaultwarden']);
    await t.stop();
  });

  it('refuses a port another program on the server listens on', async () => {
    const busy = createServer();
    await new Promise<void>((r) => busy.listen(0, '0.0.0.0', r));
    const port = (busy.address() as { port: number }).port;
    const t = createTestContext(manifest as any, { services: { 'docker.engine': fakeDocker().impl } });
    await t.start(applications);
    const r = await t.request<any>('POST', '/catalog/uptime-kuma/install', { body: { values: { HTTP_PORT: String(port) } } });
    expect(r.status).toBe(400);
    expect(r.body.details.join()).toMatch(new RegExp(`Port ${port} is already in use`));
    busy.close();
    await t.stop();
  });

  it('needs the deploy permission to start what it installs', async () => {
    const d = fakeDocker();
    const t = createTestContext(manifest as any, { services: { 'docker.engine': d.impl } });
    await t.start(applications);
    const writer = testUser(['applications.read', 'applications.write']);
    expect((await t.request<any>('POST', '/catalog/uptime-kuma/install', { body: {}, user: writer })).status).toBe(403);
    const r = await t.request<any>('POST', '/catalog/uptime-kuma/install', { body: { deploy: false, values: { HTTP_PORT: '0' } }, user: writer });
    expect(r.status).toBe(400);
    const ok = await t.request<any>('POST', '/catalog/uptime-kuma/install', { body: { deploy: false, id: 'kuma', values: { HTTP_PORT: '39123' } }, user: writer });
    expect(ok.status).toBe(200);
    expect(ok.body.deploying).toBe(false);
    expect(d.up).toEqual([]);
    expect((await t.request<any>('GET', '/apps/kuma')).body.status.state).toBe('not-deployed');
    await t.stop();
  });

  it('passes the environment to Compose for hand-written Compose applications too', async () => {
    const d = fakeDocker();
    const t = createTestContext(manifest as any, { services: { 'docker.engine': d.impl } });
    await t.start(applications);
    await t.request('POST', '/apps', { body: { id: 'site', name: 'Site', type: 'compose', version: '1', spec: { compose: 'services:\n  web:\n    image: nginx:${APP_VERSION}\n    environment:\n      MODE: ${MODE}\n' }, environment: { MODE: 'prod' } } });
    expect((await t.request('POST', '/apps/site/deploy', { body: {} })).status).toBe(200);
    expect(d.up[0].env).toEqual({ MODE: 'prod' });
    const bad = await t.request<any>('PUT', '/apps/site', { body: { environment: { MODE: "it's" } } });
    expect(bad.status).toBe(400);
    expect((await t.request<any>('POST', '/apps', { body: { id: 'catalog', name: 'X', type: 'compose', version: '1', spec: { compose: 'services:\n  a:\n    image: x\n' } } })).status).toBe(400);
    await t.stop();
  });
});
