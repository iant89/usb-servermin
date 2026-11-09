import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error untyped build script
import { pack } from '../../tools/build-module.mjs';
import { example, startServer, type TestServer } from './helpers';

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function upload(s: TestServer, file: string, path = '/api/v1/platform/modules/upload', query = '') {
  const res = await fetch(`${s.url}${path}${query}`, { method: 'POST', headers: { cookie: s.cookie, 'x-servermin-request': '1', 'content-type': 'application/octet-stream' }, body: readFileSync(file) });
  return { status: res.status, body: await res.json() };
}

describe('packaged modules (§34) and updates (§50)', () => {
  it('installs a verified archive and rejects tampered or mismatching ones', async () => {
    server = await startServer();
    const out = mkdtempSync(join(tmpdir(), 'sm-pkg-'));
    const { file, sha256 } = pack(example('hello'), out);

    expect((await upload(server, file, undefined, '?sha256=' + '0'.repeat(64))).status).toBe(400);

    // Tamper with a file after packing: the integrity check must catch it.
    const work = join(out, 'tamper');
    execFileSync('mkdir', ['-p', work]);
    execFileSync('tar', ['-xzf', file, '-C', work]);
    writeFileSync(join(work, 'dist/backend.js'), '// evil\n', { flag: 'a' });
    const bad = join(out, 'bad.tgz');
    execFileSync('tar', ['-czf', bad, '-C', work, '.']);
    const rejected = await upload(server, bad);
    expect(rejected.status).toBe(400);
    expect(rejected.body.problems.join(' ')).toMatch(/Checksum mismatch: dist\/backend.js/);

    const ok = await upload(server, file, undefined, `?sha256=${sha256}`);
    expect(ok.status).toBe(200);
    expect(ok.body.module).toMatchObject({ id: 'hello', state: 'ACTIVE', integrity: 'verified' });
    rmSync(out, { recursive: true, force: true });
  });

  it('updates to a new version and rolls back when the new version fails', async () => {
    server = await startServer();
    const s = server;
    await s.api('POST', '/api/v1/platform/modules', { source: 'directory', path: example('hello') });
    await s.api('POST', '/api/v1/modules/hello/greeting', { name: 'Linus' });

    const work = mkdtempSync(join(tmpdir(), 'sm-upd-'));
    const v2 = join(work, 'v2');
    cpSync(example('hello'), v2, { recursive: true, filter: (p) => !p.includes('node_modules') });
    const manifest = JSON.parse(readFileSync(join(v2, 'module.json'), 'utf8'));
    writeFileSync(join(v2, 'module.json'), JSON.stringify({ ...manifest, version: '1.1.0' }));
    rmSync(join(v2, 'integrity.json'));
    const up = await s.api('POST', '/api/v1/platform/modules/hello/update', { source: 'directory', path: v2 });
    expect(up.status).toBe(200);
    expect(up.body.module.version).toBe('1.1.0');
    expect((await s.api('GET', '/api/v1/modules/hello/greeting')).body.recent[0].name).toBe('Linus');

    const v3 = join(work, 'v3');
    cpSync(v2, v3, { recursive: true });
    writeFileSync(join(v3, 'module.json'), JSON.stringify({ ...manifest, version: '2.0.0' }));
    writeFileSync(join(v3, 'dist/backend.js'), 'export default { initialize() { throw new Error("v2 is broken") } }');
    const failed = await s.api('POST', '/api/v1/platform/modules/hello/update', { source: 'directory', path: v3 });
    expect(failed.status).toBe(500);
    expect(failed.body.error).toMatch(/rolled back.*v2 is broken/);
    const after = (await s.api('GET', '/api/v1/platform/modules/hello')).body;
    expect(after).toMatchObject({ version: '1.1.0', state: 'ACTIVE' });
    rmSync(work, { recursive: true, force: true });
  });

  it('rejects invalid manifests with precise problems', async () => {
    server = await startServer();
    const work = mkdtempSync(join(tmpdir(), 'sm-bad-'));
    writeFileSync(join(work, 'module.json'), JSON.stringify({ id: 'Bad Id', name: 'x', version: '1', apiVersion: 9, permissions: [{ id: 'modules.steal', description: 'x' }] }));
    const r = await server.api('POST', '/api/v1/platform/modules', { source: 'directory', path: work });
    expect(r.status).toBe(400);
    const text = r.body.problems.join('\n');
    expect(text).toMatch(/id must be/);
    expect(text).toMatch(/semantic version/);
    expect(text).toMatch(/apiVersion 9/);
    expect(text).toMatch(/reserved for the core/);
    rmSync(work, { recursive: true, force: true });
  });
});
