import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** A fake nodejs.org mirror serving a tiny "Node.js" archive and its SHASUMS256.txt. */
let server: Server;
let dir: string;
let tamper = false;
const files = new Map<string, Buffer>();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'node-runtime-'));
  const name = 'node-v99.0.0-linux-x64';
  mkdirSync(join(dir, 'src', name, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'src', name, 'bin', 'node'), '#!/bin/sh\necho fake-node\n');
  writeFileSync(join(dir, 'src', name, 'LICENSE'), 'MIT');
  writeFileSync(join(dir, 'src', name, 'README.md'), 'not copied');
  execFileSync('tar', ['-cJf', join(dir, `${name}.tar.xz`), '-C', join(dir, 'src'), name]);
  const archive = readFileSync(join(dir, `${name}.tar.xz`));
  files.set(`/v99.0.0/${name}.tar.xz`, archive);
  files.set('/v99.0.0/SHASUMS256.txt', Buffer.from(`${createHash('sha256').update(archive).digest('hex')}  ${name}.tar.xz\n${'0'.repeat(64)}  other.tar.gz\n`));
  server = createServer((req, res) => {
    const body = files.get(req.url!);
    if (!body) return res.writeHead(404).end();
    res.end(tamper && req.url!.endsWith('.tar.xz') ? Buffer.concat([body, Buffer.from('x')]) : body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.NODE_DIST_MIRROR = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());

describe('bundled Node.js runtime', () => {
  it('downloads, verifies and extracts only the runtime files', async () => {
    const { nodeRuntime, parseShasums } = await import('../../../tools/node-runtime.mjs');
    expect(parseShasums(`${'a'.repeat(64)}  x.tar.xz\nnoise\n`).get('x.tar.xz')).toBe('a'.repeat(64));
    const target = await nodeRuntime('v99.0.0', 'x64', join(dir, 'cache'), () => undefined);
    expect(execFileSync(join(target, 'bin/node')).toString().trim()).toBe('fake-node');
    expect(existsSync(join(target, 'LICENSE'))).toBe(true);
    expect(existsSync(join(target, 'README.md'))).toBe(false);
    expect(readFileSync(join(target, 'VERSION'), 'utf8')).toMatch(/^v99\.0\.0 linux-x64 sha256:[0-9a-f]{64}/);
  });

  it('rejects an archive whose checksum does not match', async () => {
    const { nodeRuntime } = await import('../../../tools/node-runtime.mjs');
    tamper = true;
    await expect(nodeRuntime('v99.0.0', 'x64', join(dir, 'cache2'), () => undefined)).rejects.toThrow(/Checksum mismatch/);
    tamper = false;
    await expect(nodeRuntime('v99.0.0', 'arm64', join(dir, 'cache3'), () => undefined)).rejects.toThrow(/not listed/);
    await expect(nodeRuntime('99', 'x64', join(dir, 'cache4'), () => undefined)).rejects.toThrow(/Invalid/);
  });
});
