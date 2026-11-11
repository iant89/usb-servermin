import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The agent's credential (ADR-002): an Ed25519 key pair created on this server. The private key
 * never leaves `<stateDir>/agent-key.pem` (0600); a Manager only ever holds the public key, so a
 * compromised Manager cannot impersonate an agent, and one agent's key says nothing about another's.
 */
export class AgentKey {
  private constructor(
    private readonly privateKey: KeyObject,
    /** Public key: base64 of the DER-encoded SubjectPublicKeyInfo. This is what a Manager stores. */
    readonly publicKey: string,
  ) {}

  /** SHA-256 of the public key, for people to compare. */
  get fingerprint(): string {
    return publicKeyFingerprint(this.publicKey);
  }

  sign(data: Buffer): string {
    return sign(null, data, this.privateKey).toString('base64');
  }

  /**
   * Loads the key, creating it on first start. A damaged key file is kept aside and replaced
   * (the same policy as the identity): the server keeps running, and the Manager will refuse the
   * new key until it is enrolled again.
   */
  static load(dir: string): { key: AgentKey; created: boolean; replaced?: { keptAs: string; reason: string } } {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'agent-key.pem');
    let replaced: { keptAs: string; reason: string } | undefined;
    if (existsSync(file)) {
      try {
        const privateKey = createPrivateKey(readFileSync(file, 'utf8'));
        if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`unexpected key type ${privateKey.asymmetricKeyType}`);
        const key = new AgentKey(privateKey, exportPublic(privateKey));
        writePublic(dir, key.publicKey);
        return { key, created: false };
      } catch (e) {
        const keptAs = `${file}.damaged-${Date.now()}`;
        renameSync(file, keptAs);
        replaced = { keptAs, reason: (e as Error).message };
      }
    }
    const { privateKey } = generateKeyPairSync('ed25519');
    const tmp = `${file}.tmp-${process.pid}`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    const key = new AgentKey(privateKey, exportPublic(privateKey));
    writePublic(dir, key.publicKey);
    return { key, created: true, replaced };
  }
}

function exportPublic(privateKey: KeyObject): string {
  return (createPublicKey(privateKey).export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
}

/** The public half next to the private one, so `servermin-agent key` can print it without the running agent. */
function writePublic(dir: string, publicKey: string) {
  const file = join(dir, 'agent-key.pub');
  if (existsSync(file) && readFileSync(file, 'utf8').trim() === publicKey) return;
  writeFileSync(file, publicKey + '\n', { mode: 0o600 });
}

/** Parses a public key as a Manager receives it. Returns null unless it is exactly an Ed25519 public key. */
export function parseAgentPublicKey(publicKey: unknown): KeyObject | null {
  if (typeof publicKey !== 'string' || publicKey.length > 200 || !/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey)) return null;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

export function publicKeyFingerprint(publicKey: string): string {
  return createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex');
}

export function verifyAgentSignature(publicKey: string, data: Buffer, signature: string): boolean {
  const key = parseAgentPublicKey(publicKey);
  if (!key) return false;
  try {
    return verify(null, data, key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}
