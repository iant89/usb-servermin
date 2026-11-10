import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The identity of this installation (ADR-003). Both ids are random and created on first start;
 * neither is derived from the hostname, the machine id or the hardware, because all of those can
 * change under a running installation (a rename, a re-image, a portable disk booted elsewhere).
 */
export interface AgentIdentity {
  /** This agent installation. Never changes for the life of the data directory. */
  agentId: string;
  /** The server this agent represents. A Manager may reassign it at registration (agent reinstalled on a known server). */
  serverId: string;
  createdAt: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export function parseIdentity(text: string): AgentIdentity {
  const raw = JSON.parse(text) as Partial<AgentIdentity> | null;
  if (!raw || typeof raw !== 'object') throw new Error('not an object');
  if (!isUuid(raw.agentId)) throw new Error('agentId is not a UUID');
  if (!isUuid(raw.serverId)) throw new Error('serverId is not a UUID');
  const createdAt = typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt)) ? raw.createdAt : new Date(0).toISOString();
  return { agentId: raw.agentId, serverId: raw.serverId, createdAt };
}

export interface IdentityLoadResult {
  identity: AgentIdentity;
  /** True when no identity existed and one was created. */
  created: boolean;
  /** Set when an unreadable identity file was moved aside and replaced: the path of the kept copy and why. */
  replaced?: { keptAs: string; reason: string };
}

/** Persists the identity as `<dir>/identity.json` (0600 in a 0700 directory), written atomically. */
export class IdentityStore {
  readonly file: string;

  constructor(readonly dir: string) {
    this.file = join(dir, 'identity.json');
  }

  /**
   * Loads the identity, creating it on first start. A damaged file is never silently overwritten:
   * it is kept beside the new one, and the caller is told, because a new identity means a Manager
   * will no longer recognise this server.
   */
  load(): IdentityLoadResult {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!existsSync(this.file)) return { identity: this.create(), created: true };
    try {
      return { identity: parseIdentity(readFileSync(this.file, 'utf8')), created: false };
    } catch (e) {
      const keptAs = `${this.file}.damaged-${Date.now()}`;
      renameSync(this.file, keptAs);
      return { identity: this.create(), created: true, replaced: { keptAs, reason: (e as Error).message } };
    }
  }

  /** Adopts the server id a Manager assigned. The agent id is never changed. */
  setServerId(current: AgentIdentity, serverId: string): AgentIdentity {
    if (!isUuid(serverId)) throw new Error('serverId must be a UUID');
    const next = { ...current, serverId };
    this.write(next);
    return next;
  }

  private create(): AgentIdentity {
    const identity = { agentId: randomUUID(), serverId: randomUUID(), createdAt: new Date().toISOString() };
    this.write(identity);
    return identity;
  }

  /** Write to a temporary file, flush it, then rename: a crash leaves either the old file or the new one, never half of one. */
  private write(identity: AgentIdentity) {
    const tmp = `${this.file}.tmp-${process.pid}`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(identity, null, 2) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}

export interface HardwareIdentity {
  vendor: string | null;
  product: string | null;
  board: string | null;
  /**
   * SHA-256 over the fields above, or null when none is readable (containers, some boards).
   * It identifies the hardware *model*: serial numbers and the DMI product UUID are readable only
   * by root, so two identical machines share a fingerprint.
   */
  fingerprint: string | null;
}

function readTrimmed(file: string): string | null {
  try {
    // Device-tree strings are NUL-terminated.
    const v = readFileSync(file, 'utf8').replace(/\0/g, '').trim();
    return v || null;
  } catch {
    return null;
  }
}

/** Reads what an unprivileged process can learn about the machine it runs on. `root` is for tests. */
export function readHardwareIdentity(root = '/'): HardwareIdentity {
  const dmi = (name: string) => readTrimmed(join(root, 'sys/class/dmi/id', name));
  const vendor = dmi('sys_vendor') ?? dmi('board_vendor');
  const product = dmi('product_name') ?? readTrimmed(join(root, 'proc/device-tree/model'));
  const board = dmi('board_name');
  const parts = [vendor, product, board];
  const fingerprint = parts.some(Boolean) ? createHash('sha256').update(JSON.stringify(parts)).digest('hex') : null;
  return { vendor, product, board, fingerprint };
}

/** `/etc/machine-id`: identifies the OS installation. Reported, never used as a key. */
export function readMachineId(root = '/'): string | null {
  const v = readTrimmed(join(root, 'etc/machine-id'));
  return v && /^[0-9a-f]{32}$/.test(v) ? v : null;
}
