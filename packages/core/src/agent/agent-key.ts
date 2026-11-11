import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The agent's Ed25519 key pair (ADR-002). The private key authenticates the agent to a Manager
 * and never leaves `<agent.stateDir>/agent-key.pem` (0600). The Manager keeps only the public key,
 * which registration (Phase 4) hands over.
 */
export class AgentKey {
  private constructor(
    private readonly privateKey: KeyObject,
    /** SPKI DER, base64: the form a Manager stores. */
    readonly publicKey: string,
  ) {}

  static fromPem(pem: string): AgentKey {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('the agent key must be Ed25519');
    return new AgentKey(key, createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64'));
  }

  static generate(): { key: AgentKey; pem: string } {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    return { key: AgentKey.fromPem(pem), pem };
  }

  /** Ed25519 signature over UTF-8 `text`, base64url. */
  sign(text: string): string {
    return sign(null, Buffer.from(text, 'utf8'), this.privateKey).toString('base64url');
  }
}

export interface AgentKeyLoadResult {
  key: AgentKey;
  created: boolean;
  replaced?: { keptAs: string; reason: string };
}

/** Loads `<dir>/agent-key.pem`, creating it on first use. A damaged key is kept aside, never overwritten. */
export function loadAgentKey(dir: string): AgentKeyLoadResult {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'agent-key.pem');
  if (existsSync(file)) {
    try {
      return { key: AgentKey.fromPem(readFileSync(file, 'utf8')), created: false };
    } catch (e) {
      const keptAs = `${file}.damaged-${Date.now()}`;
      renameSync(file, keptAs);
      return { ...create(file), replaced: { keptAs, reason: (e as Error).message } };
    }
  }
  return create(file);
}

function create(file: string): AgentKeyLoadResult {
  const { key, pem } = AgentKey.generate();
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, pem);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return { key, created: true };
}
