import { generateKeyPairSync, randomBytes, sign, createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error untyped build script
import { pack } from '../../tools/build-module.mjs';
import { CORE_VERSION } from '../../packages/core/src/version';
import { example, startServer, waitFor, type TestServer } from './helpers';

const arch = `linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const NEXT = CORE_VERSION.replace(/^(\d+)\.(\d+)\.\d+$/, (_m, a, b) => `${a}.${Number(b) + 1}.0`);

/** A stand-in for the GitHub Releases API and its asset downloads. */
class FakeGitHub {
  server!: Server;
  files = new Map<string, Buffer>();
  release: Record<string, unknown> = {};
  url = '';

  async start() {
    this.server = createServer((req, res) => {
      if (req.url === '/repos/acme/servermin/releases/latest') return res.end(JSON.stringify(this.release));
      const file = this.files.get(req.url!.replace('/download/', ''));
      if (!file) return res.writeHead(404).end();
      res.end(file);
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  publish(version: string, files: Record<string, Buffer>, manifest: object, privateKey: Parameters<typeof sign>[2], tamper: Partial<Record<string, Buffer>> = {}) {
    const json = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    const all = { ...files, 'release.json': json, 'release.json.sig': Buffer.from(sign(null, json, privateKey).toString('base64') + '\n'), ...tamper } as Record<string, Buffer>;
    this.files = new Map(Object.entries(all));
    this.release = {
      tag_name: `v${version}`,
      name: `Server Control v${version}`,
      body: 'What changed',
      html_url: `https://example.invalid/releases/v${version}`,
      published_at: new Date().toISOString(),
      assets: Object.keys(all).map((name) => ({ name, browser_download_url: `${this.url}/download/${name}` })),
    };
  }
}

const describeFile = (name: string, bytes: Buffer) => ({ file: name, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });

describe('updates from signed releases', () => {
  const keys = generateKeyPairSync('ed25519');
  const github = new FakeGitHub();
  let server: TestServer | null = null;
  let work: string;

  beforeEach(async () => {
    await github.start();
    work = mkdtempSync(join(tmpdir(), 'sm-rel-'));
  });
  afterEach(async () => {
    await server?.stop();
    server = null;
    github.server.close();
    rmSync('/var/tmp/servermin/updates', { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  const start = (extra: { status?: object } = {}) =>
    startServer({}, {
      // The privilege helper only accepts files from /var/tmp/servermin/updates.
      config: { paths: { tmp: '/var/tmp/servermin' }, updates: { enabled: true, repository: 'acme/servermin', apiBase: github.url, checkIntervalHours: 24 } },
      beforeStart: (dir, config) => {
        mkdirSync(config.paths.app, { recursive: true });
        writeFileSync(join(config.paths.app, 'release-signing.pub'), keys.publicKey.export({ type: 'spki', format: 'pem' }));
        if (extra.status) {
          mkdirSync(config.paths.data, { recursive: true });
          writeFileSync(join(config.paths.data, 'update-status.json'), JSON.stringify(extra.status));
        }
      },
    });

  function coreRelease(version = NEXT, opts: { key?: typeof keys.privateKey; tamperArchive?: boolean; modules?: object; moduleFiles?: Record<string, Buffer> } = {}) {
    const name = `servermin-${version}-${arch}.tar.gz`;
    const archive = randomBytes(4096);
    const manifest = { format: 1, version, createdAt: new Date().toISOString(), signingKey: null, core: { [arch]: { ...describeFile(name, archive), nodeBundled: true } }, modules: opts.modules ?? {} };
    github.publish(version, { [name]: archive, ...opts.moduleFiles }, manifest, opts.key ?? keys.privateKey, opts.tamperArchive ? { [name]: Buffer.concat([archive, Buffer.from('!')]) } : {});
  }

  it('finds a newer signed release, notifies once, and starts the root updater with verified files', async () => {
    server = await start();
    coreRelease();
    const checked = await server.api('POST', '/api/v1/updates/check');
    expect(checked.status).toBe(200);
    expect(checked.body).toMatchObject({ currentVersion: CORE_VERSION, available: { version: NEXT, hasBuild: true, notes: 'What changed' }, error: null, blocker: null });
    await server.api('POST', '/api/v1/updates/check');
    const notes = await server.api('GET', '/api/v1/notifications');
    const list = notes.body.items as { title: string }[];
    expect(list.filter((n) => n.title.includes(`${NEXT} is available`))).toHaveLength(1);

    const applied = await server.api('POST', '/api/v1/updates/apply');
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ started: true, version: NEXT, simulated: true });
    const audit = await server.api('GET', '/api/v1/audit?action=privileged.platform.update');
    expect(audit.body[0]).toMatchObject({ result: 'success', user: 'admin' });
    expect(audit.body[0].target).toContain('/updates/release.json');
    // The downloaded files are where the helper accepts them.
    const dl = join(server.platform.config.paths.tmp, 'updates');
    expect(readFileSync(join(dl, 'release.json'), 'utf8')).toContain(`"version": "${NEXT}"`);
  });

  it('rejects a release signed with another key', async () => {
    server = await start();
    coreRelease(NEXT, { key: generateKeyPairSync('ed25519').privateKey });
    const r = await server.api('POST', '/api/v1/updates/check');
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/signature is not valid/);
    expect((await server.api('GET', '/api/v1/updates')).body).toMatchObject({ available: null, error: expect.stringMatching(/signature/) });
  });

  it('refuses to install an archive that does not match the signed checksum', async () => {
    server = await start();
    coreRelease(NEXT, { tamperArchive: true });
    expect((await server.api('POST', '/api/v1/updates/check')).status).toBe(200);
    const r = await server.api('POST', '/api/v1/updates/apply');
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/larger than the signed manifest|does not match the checksum/);
  });

  it('does not offer the installed or an older version', async () => {
    server = await start();
    coreRelease(CORE_VERSION);
    expect((await server.api('POST', '/api/v1/updates/check')).body.available).toBeNull();
    expect((await server.api('POST', '/api/v1/updates/apply')).status).toBe(409);
  });

  it('updates a single module from the release', async () => {
    server = await start();
    await server.api('POST', '/api/v1/platform/modules', { source: 'directory', path: example('hello') });
    const v2 = join(work, 'hello');
    cpSync(example('hello'), v2, { recursive: true, filter: (p) => !p.includes('node_modules') });
    const manifest = JSON.parse(readFileSync(join(v2, 'module.json'), 'utf8'));
    writeFileSync(join(v2, 'module.json'), JSON.stringify({ ...manifest, version: '1.2.0' }));
    const { file } = pack(v2, join(work, 'out'));
    const bytes = readFileSync(file);
    coreRelease(NEXT, { modules: { hello: { version: '1.2.0', coreVersion: manifest.coreVersion, ...describeFile('hello-1.2.0.tgz', bytes) } }, moduleFiles: { 'hello-1.2.0.tgz': bytes } });
    const checked = await server.api('POST', '/api/v1/updates/check');
    expect(checked.body.moduleUpdates).toEqual([expect.objectContaining({ id: 'hello', installed: '1.0.0', available: '1.2.0', compatible: true })]);
    const r = await server.api('POST', '/api/v1/updates/modules/hello');
    expect(r.status).toBe(200);
    await waitFor(() => server!.api('GET', '/api/v1/platform/modules/hello'), (m) => m.body.version === '1.2.0' && m.body.state === 'ACTIVE', 15_000);
    expect((await server.api('GET', '/api/v1/updates')).body.moduleUpdates).toEqual([]);
  });

  it('validates settings', async () => {
    server = await start();
    expect((await server.api('PUT', '/api/v1/updates/settings', { window: '25:00' })).status).toBe(400);
    const ok = await server.api('PUT', '/api/v1/updates/settings', { autoInstall: true, window: '03:30' });
    expect(ok.body).toEqual({ autoInstall: true, window: '03:30' });
  });

  it('reports an update the root updater rolled back while the server was down', async () => {
    const finishedAt = new Date().toISOString();
    server = await start({ status: { state: 'rolled-back', from: CORE_VERSION, to: NEXT, error: 'The server did not answer within 180 s', finishedAt } });
    const notes = await server.api('GET', '/api/v1/notifications');
    const list = notes.body.items as { title: string; tone: string }[];
    expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ title: `The update to ${NEXT} failed and was rolled back`, tone: 'error' })]));
    expect((await server.api('GET', '/api/v1/updates')).body.lastResult).toMatchObject({ state: 'rolled-back' });
  });
});
