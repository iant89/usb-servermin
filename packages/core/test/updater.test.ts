import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const updater = join(import.meta.dirname, '../../../deploy/servermin-update.mjs');
const arch = `linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;

/** The root updater, run against a fake installation: system paths, systemctl and the health check are all redirected. */
describe('servermin-update', () => {
  let dir: string;
  let server: Server;
  let healthVersion: string;
  let env: Record<string, string>;
  const keys = generateKeyPairSync('ed25519');
  const app = () => join(dir, 'opt/servermin');
  const data = () => join(dir, 'data');

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'servermin-update-'));
    healthVersion = '1.0.0';
    server = createServer((_req, res) => res.end(JSON.stringify({ status: 'HEALTHY', version: healthVersion })));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    mkdirSync(app(), { recursive: true });
    mkdirSync(data(), { recursive: true });
    writeFileSync(join(app(), 'VERSION'), '1.0.0\n');
    writeFileSync(join(app(), 'release-signing.pub'), keys.publicKey.export({ type: 'spki', format: 'pem' }));
    mkdirSync(join(app(), 'deploy'));
    writeFileSync(join(app(), 'deploy/servermin-privileged'), '#!/bin/sh\n');
    writeFileSync(join(app(), 'deploy/server-control.service'), '[Unit]\n');
    writeFileSync(join(data(), 'core.db'), 'old-database');
    env = {
      SERVERMIN_APP: app(),
      SERVERMIN_DATA: data(),
      SERVERMIN_UPDATE_STATE: join(dir, 'state'),
      SERVERMIN_CONFIG: join(dir, 'none.json'),
      SERVERMIN_SYSTEM_ROOT: join(dir, 'root'),
      SERVERMIN_SYSTEMCTL: 'true',
      SERVERMIN_HEALTH_URL: `http://127.0.0.1:${port}/api/v1/health`,
      SERVERMIN_HEALTH_TIMEOUT_MS: '3000',
    };
  });

  afterEach(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Builds a release like tools/package.mjs does. Its install.sh swaps the fake installation and "migrates" the database. */
  function makeRelease(version: string, opts: { signWith?: typeof keys.privateKey; tamper?: boolean } = {}) {
    const name = `servermin-${version}-${arch}`;
    const src = join(dir, 'build', name);
    mkdirSync(join(src, 'server'), { recursive: true });
    mkdirSync(join(src, 'bin'), { recursive: true });
    writeFileSync(join(src, 'VERSION'), version + '\n');
    writeFileSync(join(src, 'server/server.js'), '');
    writeFileSync(join(src, 'bin/servermin-update.mjs'), '');
    writeFileSync(
      join(src, 'install.sh'),
      `set -e\nmv "$SERVERMIN_APP" "$SERVERMIN_APP.previous"\ncp -a "$(dirname "$0")" "$SERVERMIN_APP"\necho migrated > "$SERVERMIN_DATA/core.db"\n`,
    );
    chmodSync(join(src, 'install.sh'), 0o755);
    const out = join(dir, 'updates');
    mkdirSync(out, { recursive: true });
    const archive = join(out, `${name}.tar.gz`);
    return new Promise<{ manifest: string; signature: string; archive: string }>((resolve, reject) =>
      execFile('tar', ['-czf', archive, '-C', join(dir, 'build'), name], (e) => {
        if (e) return reject(e);
        const bytes = readFileSync(archive);
        const manifest = {
          format: 1,
          version,
          createdAt: new Date().toISOString(),
          core: { [arch]: { file: `${name}.tar.gz`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, nodeBundled: true } },
          modules: {},
        };
        if (opts.tamper) writeFileSync(archive, Buffer.concat([bytes, Buffer.from('x')]));
        const json = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
        writeFileSync(join(out, 'release.json'), json);
        writeFileSync(join(out, 'release.json.sig'), sign(null, json, opts.signWith ?? keys.privateKey).toString('base64') + '\n');
        resolve({ manifest: join(out, 'release.json'), signature: join(out, 'release.json.sig'), archive });
      }),
    );
  }

  const run = (...args: string[]) =>
    new Promise<{ code: number; status: Record<string, string> }>((resolve) =>
      execFile(process.execPath, [updater, ...args], { env: { PATH: process.env.PATH, ...env } }, (e) => {
        let status = {};
        try {
          status = JSON.parse(readFileSync(join(data(), 'update-status.json'), 'utf8'));
        } catch {
          /* none written */
        }
        resolve({ code: e ? Number(e.code ?? 1) : 0, status });
      }),
    );
  const installed = () => readFileSync(join(app(), 'VERSION'), 'utf8').trim();

  it('installs a signed, newer release and confirms it with the health check', async () => {
    const r = await makeRelease('1.1.0');
    healthVersion = '1.1.0';
    const { code, status } = await run('apply', r.manifest, r.signature, r.archive);
    expect(status.error ?? null).toBeNull();
    expect(code).toBe(0);
    expect(status).toMatchObject({ state: 'succeeded', from: '1.0.0', to: '1.1.0' });
    expect(installed()).toBe('1.1.0');
    expect(readFileSync(join(app() + '.previous', 'VERSION'), 'utf8').trim()).toBe('1.0.0');
  });

  it('refuses a release signed with another key', async () => {
    const r = await makeRelease('1.1.0', { signWith: generateKeyPairSync('ed25519').privateKey });
    const { code, status } = await run('apply', r.manifest, r.signature, r.archive);
    expect(code).toBe(1);
    expect(status).toMatchObject({ state: 'failed' });
    expect(status.error).toMatch(/signature is not valid/);
    expect(installed()).toBe('1.0.0');
  });

  it('refuses an archive that does not match the signed checksum', async () => {
    const r = await makeRelease('1.1.0', { tamper: true });
    const { status } = await run('apply', r.manifest, r.signature, r.archive);
    expect(status.error).toMatch(/does not match the checksum/);
    expect(installed()).toBe('1.0.0');
  });

  it('refuses a downgrade or the same version', async () => {
    const r = await makeRelease('1.0.0');
    const { status } = await run('apply', r.manifest, r.signature, r.archive);
    expect(status.error).toMatch(/not newer/);
  });

  it('rolls back the files and the database when the new version does not come up', async () => {
    const r = await makeRelease('1.2.0');
    // The health check keeps answering 1.0.0, so 1.2.0 never confirms.
    const { code, status } = await run('apply', r.manifest, r.signature, r.archive);
    expect(code).toBe(1);
    expect(status).toMatchObject({ state: 'rolled-back', from: '1.0.0', to: '1.2.0' });
    expect(status.error).toMatch(/expected a working 1\.2\.0/);
    expect(installed()).toBe('1.0.0');
    expect(readFileSync(join(data(), 'core.db'), 'utf8')).toBe('old-database');
    expect(readFileSync(join(dir, 'root/usr/lib/servermin/servermin-privileged'), 'utf8')).toBe('#!/bin/sh\n');
  }, 20_000);

  it('rolls back on request', async () => {
    const r = await makeRelease('1.1.0');
    healthVersion = '1.1.0';
    await run('apply', r.manifest, r.signature, r.archive);
    healthVersion = '1.0.0';
    const { code, status } = await run('rollback');
    expect(code).toBe(0);
    expect(status).toMatchObject({ state: 'rolled-back', reason: 'requested' });
    expect(installed()).toBe('1.0.0');
  });
});
