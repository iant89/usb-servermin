import { X509Certificate, createPublicKey, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:https';
import { defaultConfig, loadConfig } from '../src/config/config';
import { backoffDelay, linkUrl } from '../src/agent/manager-link';
import { loadAgentKey } from '../src/agent/agent-key';
import { createSelfSignedCertificate, ensureSelfSignedCertificate, publicKeyFingerprint } from '../src/tls/certificate';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'servermin-link-unit-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('self-signed certificate', () => {
  it('is a valid, self-verifying X.509 server certificate with the requested names', () => {
    const { cert } = createSelfSignedCertificate({ commonName: 'mgr.local', altNames: ['mgr.local', 'localhost', '127.0.0.1', '::1'], days: 30 });
    const x = new X509Certificate(cert);
    expect(x.subject).toBe('CN=mgr.local');
    expect(x.issuer).toBe('CN=mgr.local');
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.checkHost('mgr.local')).toBe('mgr.local');
    expect(x.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(x.checkIP('::1')).toBe('::1');
    expect(x.ca).toBe(false);
    expect(x.keyUsage).toContain('1.3.6.1.5.5.7.3.1');
    expect(new Date(x.validTo).getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
  });

  it.runIf(hasOpenssl)('is accepted by OpenSSL, and the fingerprint matches the documented openssl command', () => {
    const d = tmp();
    const { cert } = createSelfSignedCertificate({ commonName: 'x', altNames: ['localhost'], days: 1 });
    writeFileSync(join(d, 'c.pem'), cert);
    expect(execFileSync('openssl', ['verify', '-CAfile', join(d, 'c.pem'), join(d, 'c.pem')], { encoding: 'utf8' })).toContain('OK');
    const pub = execFileSync('openssl', ['x509', '-pubkey', '-noout', '-in', join(d, 'c.pem')]);
    const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'der'], { input: pub });
    const sha = execFileSync('openssl', ['dgst', '-sha256', '-r'], { input: der, encoding: 'utf8' }).split(' ')[0];
    expect(publicKeyFingerprint(cert)).toBe(sha);
  });

  it('encodes dates from 2050 as GeneralizedTime', () => {
    const { cert } = createSelfSignedCertificate({ commonName: 'x', altNames: ['localhost'], days: 30, now: new Date('2055-06-01T00:00:00Z') });
    expect(new Date(new X509Certificate(cert).validTo).getUTCFullYear()).toBe(2055);
  });

  it('serves TLS', async () => {
    const { cert, key } = createSelfSignedCertificate({ commonName: 'localhost', altNames: ['localhost', '127.0.0.1'], days: 1 });
    const server = createServer({ cert, key }, (_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as { port: number }).port;
      // Trusted as its own CA: the full chain and host name checks pass.
      const got = await new Promise<{ body: string; fp: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, ca: cert, servername: 'localhost' }, (res) => {
          const fp = publicKeyFingerprint((res.socket as TLSSocket).getPeerCertificate().raw);
          let body = '';
          res.on('data', (d) => (body += d)).on('end', () => resolve({ body, fp }));
        });
        req.on('error', reject).end();
      });
      expect(got).toEqual({ body: 'ok', fp: publicKeyFingerprint(cert) });
    } finally {
      server.close();
    }
  });

  it('is kept across starts, renewed with the same key before it expires, and the key is 0600', () => {
    const d = tmp();
    const names = { commonName: 'm', altNames: ['localhost'] };
    const first = ensureSelfSignedCertificate(d, names);
    expect(first.action).toBe('created');
    expect(statSync(join(d, 'manager.key')).mode & 0o777).toBe(0o600);
    const again = ensureSelfSignedCertificate(d, names);
    expect(again).toMatchObject({ action: 'loaded', fingerprint: first.fingerprint, cert: first.cert });
    // Ten years later: renewed, and agents that pinned the key still connect.
    const later = ensureSelfSignedCertificate(d, names, new Date(Date.now() + 3640 * 86_400_000));
    expect(later.action).toBe('renewed');
    expect(later.fingerprint).toBe(first.fingerprint);
    expect(later.cert).not.toBe(first.cert);
    // A damaged certificate next to a good key is replaced, keeping the key.
    writeFileSync(join(d, 'manager.crt'), 'garbage');
    expect(ensureSelfSignedCertificate(d, names)).toMatchObject({ action: 'renewed', fingerprint: first.fingerprint });
  });
});

describe('agent key', () => {
  it('is created once, 0600, and signs verifiably', () => {
    const d = tmp();
    const a = loadAgentKey(d);
    expect(a.created).toBe(true);
    expect(statSync(join(d, 'agent-key.pem')).mode & 0o777).toBe(0o600);
    const b = loadAgentKey(d);
    expect(b.created).toBe(false);
    expect(b.key.publicKey).toBe(a.key.publicKey);
    const pub = createPublicKey({ key: Buffer.from(a.key.publicKey, 'base64'), format: 'der', type: 'spki' });
    expect(verify(null, Buffer.from('hello'), pub, Buffer.from(b.key.sign('hello'), 'base64url'))).toBe(true);
  });

  it('keeps a damaged key aside instead of overwriting it', () => {
    const d = tmp();
    writeFileSync(join(d, 'agent-key.pem'), 'not a key');
    const r = loadAgentKey(d);
    expect(r.created).toBe(true);
    expect(r.replaced?.keptAs).toMatch(/agent-key\.pem\.damaged-\d+$/);
    expect(readFileSync(r.replaced!.keptAs, 'utf8')).toBe('not a key');
    expect(existsSync(join(d, 'agent-key.pem'))).toBe(true);
  });
});

describe('backoff', () => {
  it('doubles from the initial delay up to the maximum, with half of it random', () => {
    const lo = (n: number) => backoffDelay(n, 1000, 60_000, () => 0);
    const hi = (n: number) => backoffDelay(n, 1000, 60_000, () => 1);
    expect([0, 1, 2, 3].map(lo)).toEqual([500, 1000, 2000, 4000]);
    expect([0, 1, 2, 3].map(hi)).toEqual([1000, 2000, 4000, 8000]);
    expect(lo(50)).toBe(30_000);
    expect(hi(50)).toBe(60_000);
  });

  it('spreads a crowd of agents out', () => {
    const delays = new Set(Array.from({ length: 50 }, () => backoffDelay(4, 1000, 60_000)));
    expect(delays.size).toBeGreaterThan(20);
    for (const d of delays) expect(d).toBeGreaterThanOrEqual(8000);
  });

  it('adds the protocol path to a bare Manager URL only', () => {
    expect(linkUrl('wss://m.example:8480', '/api/v1/agent/link')).toBe('wss://m.example:8480/api/v1/agent/link');
    expect(linkUrl('wss://m.example/proxy/link', '/api/v1/agent/link')).toBe('wss://m.example/proxy/link');
  });
});

describe('agent.manager configuration', () => {
  const load = (manager: Record<string, unknown>) => {
    const d = tmp();
    const file = join(d, 'config.json');
    writeFileSync(file, JSON.stringify({ agent: { manager } }));
    return loadConfig({ SERVERMIN_CONFIG: file });
  };

  it('defaults to no Manager', () => {
    expect(defaultConfig().agent.manager).toEqual({ url: null, fingerprint: null, ca: null });
  });

  it('accepts wss:// and normalises a pasted fingerprint', () => {
    const fp = 'AB:'.repeat(31) + 'AB';
    expect(load({ url: 'wss://manager.example:8480', fingerprint: fp }).agent.manager).toEqual({ url: 'wss://manager.example:8480', fingerprint: 'ab'.repeat(32), ca: null });
  });

  it.each([
    [{ url: 'https://manager.example' }, 'must be a wss:// URL'],
    [{ url: 'ws://manager.example:8480' }, 'only allowed for a Manager on this machine'],
    [{ url: 'wss://user:pw@manager.example' }, 'must not contain credentials'],
    [{ url: 'not a url' }, 'must be a wss:// URL'],
    [{ fingerprint: 'abc' }, 'SHA-256 fingerprint'],
    [{ ca: 'relative.pem' }, 'absolute path'],
  ])('refuses %j', (manager, message) => {
    expect(() => load({ url: null, fingerprint: null, ca: null, ...manager })).toThrow(message);
  });

  it('allows ws:// to this machine, and environment overrides', () => {
    expect(load({ url: 'ws://127.0.0.1:8480' }).agent.manager.url).toBe('ws://127.0.0.1:8480');
    const d = tmp();
    const c = loadConfig({ SERVERMIN_CONFIG: join(d, 'none.json'), SERVERMIN_AGENT_MANAGER_URL: 'wss://m:1', SERVERMIN_AGENT_MANAGER_FINGERPRINT: 'cd'.repeat(32) });
    expect(c.agent.manager).toMatchObject({ url: 'wss://m:1', fingerprint: 'cd'.repeat(32) });
  });
});
