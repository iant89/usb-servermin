import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isUuid, parseAgentPublicKey, publicKeyFingerprint, type Database, type EventBus } from '@servermin/core';
import { InventoryError, type Inventory, type ServerRecord } from './inventory';

/*
 * Server registration (roadmap Phase 4, ADR-004). An administrator creates a one-time code; on the
 * new server `sudo servermin-agent register CODE …` hands the Manager the agent's ids and public
 * key together with the code; the registration waits for approval (unless the code approves
 * itself), and approving it enrols the agent exactly as `PUT /servers/:id/agent` does.
 */

export const REGISTRATION_SCHEMA = `
  CREATE TABLE registration_codes (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    created_by TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    server_id TEXT,
    name TEXT,
    auto_approve INTEGER NOT NULL DEFAULT 0,
    used_at TEXT,
    revoked_at TEXT
  );
  CREATE TABLE registrations (
    id TEXT PRIMARY KEY,
    code_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    claimed_server_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    hostname TEXT NOT NULL,
    name TEXT,
    agent_version TEXT,
    ip TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT,
    server_id TEXT,
    reason TEXT
  );
  CREATE INDEX registrations_status ON registrations (status, created_at);
`;

export type CodeStatus = 'ACTIVE' | 'USED' | 'EXPIRED' | 'REVOKED';
export type RegistrationStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUPERSEDED';

export interface RegistrationCode {
  id: string;
  status: CodeStatus;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  /** A code bound to a server registers an agent for that server (a reinstall); otherwise a new server is created. */
  serverId: string | null;
  /** Name for the new server; the agent's hostname otherwise. */
  name: string | null;
  autoApprove: boolean;
  usedAt: string | null;
}

export interface Registration {
  id: string;
  status: RegistrationStatus;
  codeId: string;
  agentId: string;
  /** The server id the agent reported; the Manager may assign another one on approval. */
  claimedServerId: string;
  keyFingerprint: string;
  hostname: string;
  name: string | null;
  agentVersion: string | null;
  ip: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  /** The server the agent was enrolled for, once approved. */
  serverId: string | null;
  reason: string | null;
}

/** A refused registration. `message` is safe to show to the agent; `reason` is for the audit log. */
export class RegistrationError extends InventoryError {
  constructor(
    message: string,
    status: number,
    readonly reason: string = message,
  ) {
    super(message, status);
  }
}

// Crockford base32 without the letters people misread: a code is typed by hand.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_CHARS = 25; // 125 bits
export const DEFAULT_CODE_MINUTES = 60;
export const MAX_CODE_MINUTES = 7 * 24 * 60;

export function newCode(): string {
  const bytes = randomBytes(CODE_CHARS);
  const chars = [...bytes].map((b) => ALPHABET[b & 31]).join('');
  return `SMR-${chars.match(/.{5}/g)!.join('-')}`;
}

/** Normalises a code as typed (`smr-abcde-…`, spaces, `O` for `0`) to its canonical characters, or null. */
export function normalizeCode(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 64) return null;
  let s = v.toUpperCase().replace(/[\s-]/g, '');
  if (s.startsWith('SMR')) s = s.slice(3);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  return s.length === CODE_CHARS && [...s].every((c) => ALPHABET.includes(c)) ? s : null;
}

const hashCode = (normalized: string) => createHash('sha256').update(`servermin-registration:${normalized}`).digest('hex');

const TEXT_RE = /^[^\p{C}]{1,253}$/u;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,64}$/;

export class Registrations {
  constructor(
    private readonly db: Database,
    private readonly inventory: Inventory,
    private readonly bus: EventBus,
  ) {}

  private codeRecord(r: any, now = Date.now()): RegistrationCode {
    const status: CodeStatus = r.revoked_at ? 'REVOKED' : r.used_at ? 'USED' : Date.parse(r.expires_at) <= now ? 'EXPIRED' : 'ACTIVE';
    return { id: r.id, status, createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at, serverId: r.server_id, name: r.name, autoApprove: !!r.auto_approve, usedAt: r.used_at };
  }

  private record(r: any): Registration {
    return {
      id: r.id,
      status: r.status,
      codeId: r.code_id,
      agentId: r.agent_id,
      claimedServerId: r.claimed_server_id,
      keyFingerprint: publicKeyFingerprint(r.public_key),
      hostname: r.hostname,
      name: r.name,
      agentVersion: r.agent_version,
      ip: r.ip,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
      decidedBy: r.decided_by,
      serverId: r.server_id,
      reason: r.reason,
    };
  }

  // ── Codes ──────────────────────────────────────────────────────────────────────

  /** Creates a code. The plain code is returned once and never stored. */
  createCode(input: { serverId?: unknown; name?: unknown; expiresInMinutes?: unknown; autoApprove?: unknown }, by?: string): { code: string; record: RegistrationCode } {
    let serverId: string | null = null;
    if (input.serverId !== undefined && input.serverId !== null) {
      if (!isUuid(input.serverId)) throw new InventoryError('serverId must be a server id');
      serverId = this.inventory.require(input.serverId).id;
    }
    let name: string | null = null;
    if (input.name !== undefined && input.name !== null && input.name !== '') {
      if (serverId) throw new InventoryError('A code for an existing server keeps that server\'s name; leave name out');
      if (typeof input.name !== 'string' || !/^[^\s\p{C}](?:[^\p{C}]{0,62}[^\s\p{C}])?$/u.test(input.name.trim())) throw new InventoryError('name must be 1-64 printable characters');
      name = input.name.trim();
    }
    const minutes = input.expiresInMinutes === undefined ? DEFAULT_CODE_MINUTES : Number(input.expiresInMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_CODE_MINUTES) throw new InventoryError(`expiresInMinutes must be a whole number from 1 to ${MAX_CODE_MINUTES}`);
    if (input.autoApprove !== undefined && typeof input.autoApprove !== 'boolean') throw new InventoryError('autoApprove must be true or false');
    const code = newCode();
    const id = randomUUID();
    const now = new Date();
    this.db.run('INSERT INTO registration_codes (id, code_hash, created_by, created_at, expires_at, server_id, name, auto_approve) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      hashCode(normalizeCode(code)!),
      by ?? null,
      now.toISOString(),
      new Date(now.getTime() + minutes * 60_000).toISOString(),
      serverId,
      name,
      input.autoApprove === true ? 1 : 0,
    ]);
    return { code, record: this.requireCode(id) };
  }

  listCodes(): RegistrationCode[] {
    const now = Date.now();
    return this.db.all('SELECT * FROM registration_codes ORDER BY created_at DESC').map((r) => this.codeRecord(r, now));
  }

  requireCode(id: string): RegistrationCode {
    const r = isUuid(id) ? this.db.get('SELECT * FROM registration_codes WHERE id = ?', [id]) : undefined;
    if (!r) throw new InventoryError('Registration code not found', 404);
    return this.codeRecord(r);
  }

  revokeCode(id: string): RegistrationCode {
    const code = this.requireCode(id);
    if (code.status !== 'ACTIVE') throw new InventoryError(`The code is already ${code.status.toLowerCase()}`, 409);
    this.db.run('UPDATE registration_codes SET revoked_at = ? WHERE id = ?', [new Date().toISOString(), id]);
    return this.requireCode(id);
  }

  // ── Registrations ──────────────────────────────────────────────────────────────

  /**
   * An agent presents a code (public endpoint). The code is used up whatever happens next, so it
   * cannot be tried twice. Throws `RegistrationError`; `status` 403 means the code was not
   * accepted (counted towards the address lockout), 400 a malformed request.
   */
  submit(input: Record<string, unknown>, ip: string | null): { registration: Registration; autoApprove: boolean } {
    const normalized = normalizeCode(input.code);
    if (!normalized) throw new RegistrationError('This registration code is not valid', 403, 'malformed code');
    if (!isUuid(input.agentId)) throw new RegistrationError('agentId must be a UUID', 400);
    if (!isUuid(input.serverId)) throw new RegistrationError('serverId must be a UUID', 400);
    if (!parseAgentPublicKey(input.publicKey)) throw new RegistrationError('publicKey must be an Ed25519 public key', 400);
    if (typeof input.hostname !== 'string' || !TEXT_RE.test(input.hostname)) throw new RegistrationError('hostname is required', 400);
    if (input.name !== undefined && input.name !== null && (typeof input.name !== 'string' || !TEXT_RE.test(input.name) || input.name.length > 64)) throw new RegistrationError('name must be 1-64 printable characters', 400);
    if (input.agentVersion !== undefined && (typeof input.agentVersion !== 'string' || !VERSION_RE.test(input.agentVersion))) throw new RegistrationError('agentVersion is invalid', 400);

    const now = new Date();
    const result = this.db.transaction(() => {
      const row = this.db.get<any>('SELECT * FROM registration_codes WHERE code_hash = ?', [hashCode(normalized)]);
      if (!row) throw new RegistrationError('This registration code is not valid', 403, 'unknown code');
      const code = this.codeRecord(row, now.getTime());
      // The code matched, so whoever holds it may know why it no longer works.
      if (code.status !== 'ACTIVE') throw new RegistrationError(`This registration code is ${code.status.toLowerCase()}; ask for a new one`, 403, `code ${code.status.toLowerCase()}`);
      this.db.run('UPDATE registration_codes SET used_at = ? WHERE id = ?', [now.toISOString(), code.id]);
      // A second attempt from the same agent replaces its earlier, undecided one.
      this.db.run("UPDATE registrations SET status = 'SUPERSEDED', decided_at = ?, reason = 'a newer registration from the same agent' WHERE agent_id = ? AND status = 'PENDING'", [now.toISOString(), input.agentId as string]);
      const id = randomUUID();
      this.db.run(
        'INSERT INTO registrations (id, code_id, agent_id, claimed_server_id, public_key, hostname, name, agent_version, ip, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, code.id, input.agentId as string, input.serverId as string, input.publicKey as string, input.hostname as string, (input.name as string | undefined) ?? null, (input.agentVersion as string | undefined) ?? null, ip, 'PENDING', now.toISOString()],
      );
      return { registration: this.require(id), autoApprove: code.autoApprove };
    });
    this.bus.publish('registration.created', { registration: result.registration }, 'manager');
    return result;
  }

  list(status?: string): Registration[] {
    const rows = status ? this.db.all('SELECT * FROM registrations WHERE status = ? ORDER BY created_at DESC', [status.toUpperCase()]) : this.db.all('SELECT * FROM registrations ORDER BY created_at DESC LIMIT 500');
    return rows.map((r) => this.record(r));
  }

  require(id: string): Registration {
    const r = isUuid(id) ? this.db.get('SELECT * FROM registrations WHERE id = ?', [id]) : undefined;
    if (!r) throw new InventoryError('Registration not found', 404);
    return this.record(r);
  }

  private pending(id: string): { registration: Registration; publicKey: string; code: RegistrationCode } {
    const registration = this.require(id);
    if (registration.status !== 'PENDING') throw new InventoryError(`The registration is already ${registration.status.toLowerCase()}`, 409);
    const { public_key } = this.db.get<{ public_key: string }>('SELECT public_key FROM registrations WHERE id = ?', [id])!;
    return { registration, publicKey: public_key, code: this.requireCode(registration.codeId) };
  }

  /**
   * Approves a registration: the agent is enrolled for the code's server, or for a new server.
   * A code without a server never attaches the agent to an existing server, so a code cannot be
   * used to take one over.
   */
  approve(id: string, input: { name?: unknown }, by: string): { registration: Registration; server: ServerRecord } {
    const { registration: reg, publicKey, code } = this.pending(id);
    let server: ServerRecord;
    if (code.serverId) {
      const target = this.inventory.get(code.serverId);
      if (!target) throw new InventoryError('The server this code was made for no longer exists; reject the registration and create a new code', 409);
      if (input.name !== undefined) throw new InventoryError('This registration is for an existing server, which keeps its name', 400);
      server = this.inventory.enrolAgent(target.id, { agentId: reg.agentId, publicKey }, by);
    } else {
      const enrolledAs = this.inventory.agentCredential(reg.agentId);
      if (enrolledAs) throw new InventoryError(`This agent is already enrolled for server ${enrolledAs.serverId}. To re-register it, create a code for that server`, 409);
      const explicit = input.name !== undefined && input.name !== null && input.name !== '';
      const name = explicit ? input.name : this.freeName(code.name ?? reg.name ?? reg.hostname);
      const created = this.inventory.create({ name, hostname: hostnameOrNull(reg.hostname), id: this.inventory.get(reg.claimedServerId) ? undefined : reg.claimedServerId });
      try {
        server = this.inventory.enrolAgent(created.id, { agentId: reg.agentId, publicKey }, by);
      } catch (e) {
        this.inventory.remove(created.id);
        throw e;
      }
    }
    this.db.run("UPDATE registrations SET status = 'APPROVED', decided_at = ?, decided_by = ?, server_id = ? WHERE id = ?", [new Date().toISOString(), by, server.id, id]);
    const registration = this.require(id);
    this.bus.publish('registration.decided', { registration }, 'manager');
    return { registration, server };
  }

  reject(id: string, input: { reason?: unknown }, by: string): Registration {
    this.pending(id);
    const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 500) : null;
    this.db.run("UPDATE registrations SET status = 'REJECTED', decided_at = ?, decided_by = ?, reason = ? WHERE id = ?", [new Date().toISOString(), by, reason, id]);
    const registration = this.require(id);
    this.bus.publish('registration.decided', { registration }, 'manager');
    return registration;
  }

  /** `base`, or `base-2`, `base-3`… if a server already has that name. */
  private freeName(base: string): string {
    const clean = base.replace(/\p{C}/gu, '').trim().slice(0, 58) || 'server';
    const taken = new Set(this.inventory.list().map((s) => s.name.toLowerCase()));
    if (!taken.has(clean.toLowerCase())) return clean;
    for (let i = 2; ; i++) if (!taken.has(`${clean}-${i}`.toLowerCase())) return `${clean}-${i}`;
  }
}

function hostnameOrNull(h: string): string | null {
  return /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/.test(h) ? h.toLowerCase() : null;
}
