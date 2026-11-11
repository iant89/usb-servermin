import { createPublicKey, type KeyObject } from 'node:crypto';
import { isUuid, type Database } from '@servermin/core';
import type { ServerStatePayload } from '@servermin/protocol';
import { InventoryError, type Inventory } from './inventory';

/**
 * Agents the Manager accepts, with the public key each authenticates with (ADR-002). One agent
 * per server. Phase 4's registration flow is what enrols agents; until then `enroll` is called
 * directly (tests, and an administrator's own tooling).
 */
export const AGENTS_SCHEMA = `
  CREATE TABLE agents (
    agent_id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL UNIQUE REFERENCES servers(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    enrolled_at TEXT NOT NULL,
    last_connected_at TEXT,
    last_address TEXT,
    last_report TEXT
  );
`;

export interface AgentRecord {
  agentId: string;
  serverId: string;
  /** SPKI DER, base64. */
  publicKey: string;
  enrolledAt: string;
  lastConnectedAt: string | null;
  lastAddress: string | null;
  /** The last SERVER_STATE the agent sent. */
  report: ServerStatePayload | null;
}

/** Parses an Ed25519 public key in the form agents report it (SPKI DER, base64). */
export function parseAgentPublicKey(v: unknown): KeyObject {
  let key: KeyObject;
  try {
    if (typeof v !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(v) || v.length > 200) throw new Error();
    key = createPublicKey({ key: Buffer.from(v, 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw new InventoryError('publicKey must be an SPKI public key, base64');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new InventoryError('publicKey must be an Ed25519 key');
  return key;
}

export class AgentRegistry {
  private keys = new Map<string, KeyObject>();

  constructor(
    private readonly db: Database,
    private readonly inventory: Inventory,
  ) {}

  private toRecord(r: any): AgentRecord {
    let report: ServerStatePayload | null = null;
    try {
      report = r.last_report ? JSON.parse(r.last_report) : null;
    } catch {
      report = null;
    }
    return { agentId: r.agent_id, serverId: r.server_id, publicKey: r.public_key, enrolledAt: r.enrolled_at, lastConnectedAt: r.last_connected_at, lastAddress: r.last_address, report };
  }

  get(agentId: string): AgentRecord | undefined {
    if (!isUuid(agentId)) return undefined;
    const r = this.db.get('SELECT * FROM agents WHERE agent_id = ?', [agentId]);
    return r ? this.toRecord(r) : undefined;
  }

  forServer(serverId: string): AgentRecord | undefined {
    const r = this.db.get('SELECT * FROM agents WHERE server_id = ?', [serverId]);
    return r ? this.toRecord(r) : undefined;
  }

  /** The agent's public key, parsed once. */
  publicKey(agentId: string): KeyObject | undefined {
    const cached = this.keys.get(agentId);
    if (cached) return cached;
    const a = this.get(agentId);
    if (!a) return undefined;
    const key = parseAgentPublicKey(a.publicKey);
    this.keys.set(agentId, key);
    return key;
  }

  /** Accepts `agentId`, holding `publicKey`, as the agent of an existing server. */
  enroll(input: { serverId: unknown; agentId: unknown; publicKey: unknown }): AgentRecord {
    if (!isUuid(input.serverId)) throw new InventoryError('serverId must be a UUID');
    if (!isUuid(input.agentId)) throw new InventoryError('agentId must be a UUID');
    parseAgentPublicKey(input.publicKey);
    const { serverId, agentId } = input as { serverId: string; agentId: string; publicKey: string };
    this.db.transaction(() => {
      const server = this.inventory.require(serverId);
      if (server.agentId || this.forServer(serverId)) throw new InventoryError('This server already has an agent', 409);
      if (this.get(agentId) || this.db.get('SELECT id FROM servers WHERE agent_id = ?', [agentId])) throw new InventoryError('This agent is already enrolled', 409);
      this.db.run('INSERT INTO agents (agent_id, server_id, public_key, enrolled_at) VALUES (?, ?, ?, ?)', [agentId, serverId, input.publicKey as string, new Date().toISOString()]);
    });
    this.inventory.attachAgent(serverId, agentId);
    return this.get(agentId)!;
  }

  recordConnection(agentId: string, address: string | null) {
    this.db.run('UPDATE agents SET last_connected_at = ?, last_address = ? WHERE agent_id = ?', [new Date().toISOString(), address, agentId]);
  }

  recordReport(agentId: string, report: ServerStatePayload) {
    this.db.run('UPDATE agents SET last_report = ? WHERE agent_id = ?', [JSON.stringify(report), agentId]);
  }

  /** Forgets a key whose server was removed (the row went with it, through the foreign key). */
  forget(agentId: string) {
    this.keys.delete(agentId);
  }
}
