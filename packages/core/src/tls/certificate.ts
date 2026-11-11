import { X509Certificate, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

/*
 * A self-signed TLS certificate made without OpenSSL on the command line (ADR-002). The Manager
 * must not start processes, and Node.js can create keys and signatures but not certificates, so
 * the certificate is encoded here: a minimal X.509 v3 with ECDSA P-256, which every TLS client
 * and browser accepts.
 *
 * Agents pin the SHA-256 of the *public key* (SPKI), not of the certificate, so renewing the
 * certificate with the same key does not break any agent.
 */

// ── DER ────────────────────────────────────────────────────────────────────────

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const explicit = (n: number, body: Buffer) => tlv(0xa0 + n, body);
const octets = (b: Buffer) => tlv(0x04, b);
const bitString = (b: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0]));

function integer(b: Buffer): Buffer {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  const v = b.subarray(i);
  return tlv(0x02, v[0] & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const enc = [p & 0x7f];
    for (let v = p >> 7; v > 0; v >>= 7) enc.unshift(0x80 | (v & 0x7f));
    out.push(...enc);
  }
  return tlv(0x06, Buffer.from(out));
}

function time(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'; // YYYYMMDDHHMMSSZ
  // RFC 5280: UTCTime until 2049, GeneralizedTime from 2050.
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso));
}

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
}

function subjectAltNames(names: string[]): Buffer {
  return seq(
    ...names.map((n) => {
      if (isIP(n) === 4) return tlv(0x87, Buffer.from(n.split('.').map(Number)));
      if (isIP(n) === 6) return tlv(0x87, ipv6Bytes(n));
      return tlv(0x82, Buffer.from(n, 'ascii'));
    }),
  );
}

function ipv6Bytes(ip: string): Buffer {
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = ip.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return Buffer.from(groups.flatMap((g) => [(parseInt(g, 16) >> 8) & 0xff, parseInt(g, 16) & 0xff]));
}

export interface CertificateOptions {
  commonName: string;
  /** DNS names and IP addresses for subjectAltName. */
  altNames: string[];
  days: number;
  /** Reuse a key (renewal); a new P-256 key otherwise. */
  key?: KeyObject;
  now?: Date;
}

/** Creates a self-signed server certificate. Returns PEM strings. */
export function createSelfSignedCertificate(opts: CertificateOptions): { cert: string; key: string } {
  const key = opts.key ?? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const now = opts.now ?? new Date();
  // Back-dated an hour for clocks that are slightly behind.
  const notBefore = new Date(now.getTime() - 3_600_000);
  const notAfter = new Date(now.getTime() + opts.days * 86_400_000);
  const name = seq(set(seq(oid('2.5.4.3'), utf8(opts.commonName))));
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  const skid = createHash('sha1').update(spki).digest();
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(serial),
    ECDSA_SHA256,
    name,
    seq(time(notBefore), time(notAfter)),
    name,
    spki,
    explicit(
      3,
      seq(
        extension('2.5.29.19', true, seq()), // basicConstraints: not a CA
        extension('2.5.29.15', true, bitString(Buffer.from([0x80]))), // keyUsage: digitalSignature
        extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))), // extKeyUsage: serverAuth
        extension('2.5.29.14', false, octets(skid)), // subjectKeyIdentifier
        extension('2.5.29.17', false, subjectAltNames(opts.altNames)),
      ),
    ),
  );
  const signature = sign('sha256', tbs, key); // DER ECDSA-Sig-Value, as X.509 wants it
  const der = seq(tbs, ECDSA_SHA256, bitString(signature));
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd();
  return { cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`, key: key.export({ type: 'pkcs8', format: 'pem' }) as string };
}

/** SHA-256 of a certificate's public key (SPKI), 64 lower-case hex digits: what agents pin. */
export function publicKeyFingerprint(cert: string | Buffer | X509Certificate): string {
  const x = cert instanceof X509Certificate ? cert : new X509Certificate(cert);
  return createHash('sha256').update(x.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}

function writeAtomic(file: string, content: string, mode: number) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', mode);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}

export interface ManagedCertificate {
  cert: string;
  key: string;
  fingerprint: string;
  notAfter: string;
  /** What happened on this start. */
  action: 'created' | 'loaded' | 'renewed';
}

/**
 * Keeps a self-signed certificate in `dir` (`manager.crt`, `manager.key` 0600). Creates one on
 * first start, renews it with the same key when it expires within 30 days, and never replaces the
 * key: a new key would change the fingerprint every agent pinned.
 */
export function ensureSelfSignedCertificate(dir: string, names: { commonName: string; altNames: string[] }, now = new Date()): ManagedCertificate {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const certFile = join(dir, 'manager.crt');
  const keyFile = join(dir, 'manager.key');
  let action: ManagedCertificate['action'] = 'loaded';
  let cert: string;
  let key: string;
  if (existsSync(keyFile)) {
    key = readFileSync(keyFile, 'utf8');
    const keyObject = createPrivateKey(key);
    let current: X509Certificate | null = null;
    try {
      current = new X509Certificate(readFileSync(certFile));
      if (!current.checkPrivateKey(keyObject)) current = null;
    } catch {
      current = null;
    }
    if (current && new Date(current.validTo).getTime() - now.getTime() > 30 * 86_400_000) {
      cert = current.toString();
    } else {
      cert = createSelfSignedCertificate({ ...names, days: 3650, key: keyObject, now }).cert;
      writeAtomic(certFile, cert, 0o644);
      action = 'renewed';
    }
  } else {
    ({ cert, key } = createSelfSignedCertificate({ ...names, days: 3650, now }));
    writeAtomic(keyFile, key, 0o600);
    writeAtomic(certFile, cert, 0o644);
    action = 'created';
  }
  const x = new X509Certificate(cert);
  return { cert, key, fingerprint: publicKeyFingerprint(x), notAfter: new Date(x.validTo).toISOString(), action };
}
