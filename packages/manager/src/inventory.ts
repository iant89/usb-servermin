import { randomUUID } from 'node:crypto';
import { isUuid, parseAgentPublicKey, publicKeyFingerprint, type Database, type EventBus } from '@servermin/core';

/**
 * States a server can be in (roadmap Phase 5). Until agents connect (Phase 3) every server is
 * UNKNOWN: the Manager knows the server exists and nothing else. A state is always derived from
 * what an agent reports or fails to report; it is never set through the API.
 */
export const SERVER_STATES = ['UNKNOWN', 'DISCOVERING', 'CONNECTING', 'ONLINE', 'DEGRADED', 'STALE', 'WAKING', 'UPDATING', 'REBOOTING', 'SHUTTING_DOWN', 'OFFLINE', 'ERROR', 'RECOVERY'] as const;
export type ServerState = (typeof SERVER_STATES)[number];

export interface ServerRecord {
  /** Server id (ADR-003). */
  id: string;
  name: string;
  hostname: string | null;
  description: string;
  /** The agent that represents this server; null until one registers. */
  agentId: string | null;
  agentVersion: string | null;
  /** SHA-256 of the enrolled agent's public key, to compare with `servermin-agent status`. */
  agentKeyFingerprint: string | null;
  /** What the agent last reported it can do. */
  capabilities: string[];
  state: ServerState;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
}

export class InventoryError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export const INVENTORY_SCHEMA = `
  CREATE TABLE servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    hostname TEXT,
    description TEXT NOT NULL DEFAULT '',
    agent_id TEXT UNIQUE,
    agent_version TEXT,
    state TEXT NOT NULL DEFAULT 'UNKNOWN',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_seen_at TEXT
  );
`;

/** Agents allowed to connect (ADR-002). One agent per server; removing the row revokes it. */
export const AGENTS_SCHEMA = `
  CREATE TABLE agents (
    agent_id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL UNIQUE REFERENCES servers(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    enrolled_at TEXT NOT NULL,
    enrolled_by TEXT
  );
  ALTER TABLE servers ADD COLUMN capabilities TEXT NOT NULL DEFAULT '[]';
`;

// Printable, no control characters, no leading or trailing space.
const NAME_RE = /^[^\s\p{C}](?:[^\p{C}]{0,62}[^\s\p{C}])?$/u;
const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;

const SELECT = 'SELECT s.*, a.public_key FROM servers s LEFT JOIN agents a ON a.server_id = s.id';

function parseList(v: unknown): string[] {
  try {
    const l = JSON.parse(String(v ?? '[]'));
    return Array.isArray(l) ? l.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function cleanName(v: unknown): string {
  if (typeof v !== 'string' || !NAME_RE.test(v.trim())) throw new InventoryError('name must be 1-64 printable characters');
  return v.trim();
}

function cleanHostname(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !HOSTNAME_RE.test(v.trim())) throw new InventoryError('hostname is not a valid host name');
  return v.trim().toLowerCase();
}

function cleanDescription(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string' || v.length > 500 || /\p{Cc}/u.test(v.replace(/[\n\t]/g, ''))) throw new InventoryError('description must be text of at most 500 characters');
  return v.trim();
}

/**
 * The persistent list of servers the Manager knows (Phase 2). Changes are published on the event
 * bus as `inventory.server.created|updated|removed`.
 */
export class Inventory {
  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
  ) {}

  private toRecord(r: any): ServerRecord {
    return {
      id: r.id,
      name: r.name,
      hostname: r.hostname,
      description: r.description,
      agentId: r.agent_id,
      agentVersion: r.agent_version,
      agentKeyFingerprint: r.public_key ? publicKeyFingerprint(r.public_key) : null,
      capabilities: parseList(r.capabilities),
      state: (SERVER_STATES as readonly string[]).includes(r.state) ? r.state : 'UNKNOWN',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastSeenAt: r.last_seen_at,
    };
  }

  list(): ServerRecord[] {
    return this.db.all(`${SELECT} ORDER BY s.name COLLATE NOCASE`).map((r) => this.toRecord(r));
  }

  get(id: string): ServerRecord | undefined {
    const r = this.db.get(`${SELECT} WHERE s.id = ?`, [id]);
    return r ? this.toRecord(r) : undefined;
  }

  require(id: string): ServerRecord {
    const s = isUuid(id) ? this.get(id) : undefined;
    if (!s) throw new InventoryError('Server not found', 404);
    return s;
  }

  count(): { total: number; byState: Partial<Record<ServerState, number>> } {
    const rows = this.db.all<{ state: ServerState; n: number }>('SELECT state, COUNT(*) AS n FROM servers GROUP BY state');
    return { total: rows.reduce((a, r) => a + Number(r.n), 0), byState: Object.fromEntries(rows.map((r) => [r.state, Number(r.n)])) };
  }

  private assertNameFree(name: string, exceptId?: string) {
    const other = this.db.get<{ id: string }>('SELECT id FROM servers WHERE name = ? COLLATE NOCASE', [name]);
    if (other && other.id !== exceptId) throw new InventoryError(`A server named "${name}" already exists`, 409);
  }

  /**
   * Adds a server. `id` is optional: give the server id an agent reports (`servermin-agent id`) to
   * describe a server before its agent registers; otherwise one is generated.
   */
  create(input: { name: unknown; hostname?: unknown; description?: unknown; id?: unknown }): ServerRecord {
    const name = cleanName(input.name);
    const hostname = cleanHostname(input.hostname);
    const description = cleanDescription(input.description);
    if (input.id !== undefined && !isUuid(input.id)) throw new InventoryError('id must be a UUID (the server id an agent reports)');
    const id = (input.id as string | undefined) ?? randomUUID();
    const now = new Date().toISOString();
    const server = this.db.transaction(() => {
      if (this.get(id)) throw new InventoryError('A server with this id already exists', 409);
      this.assertNameFree(name);
      this.db.run('INSERT INTO servers (id, name, hostname, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, name, hostname, description, now, now]);
      return this.get(id)!;
    });
    this.bus.publish('inventory.server.created', { server }, 'manager');
    return server;
  }

  update(id: string, patch: { name?: unknown; hostname?: unknown; description?: unknown }): ServerRecord {
    const server = this.db.transaction(() => {
      const current = this.require(id);
      const name = patch.name === undefined ? current.name : cleanName(patch.name);
      const hostname = patch.hostname === undefined ? current.hostname : cleanHostname(patch.hostname);
      const description = patch.description === undefined ? current.description : cleanDescription(patch.description);
      this.assertNameFree(name, id);
      if (name === current.name && hostname === current.hostname && description === current.description) return null;
      this.db.run('UPDATE servers SET name = ?, hostname = ?, description = ?, updated_at = ? WHERE id = ?', [name, hostname, description, new Date().toISOString(), id]);
      return this.get(id)!;
    });
    if (!server) return this.require(id);
    this.bus.publish('inventory.server.updated', { server }, 'manager');
    return server;
  }

  remove(id: string): ServerRecord {
    const server = this.db.transaction(() => {
      const current = this.require(id);
      this.db.run('DELETE FROM servers WHERE id = ?', [id]);
      return current;
    });
    if (server.agentId) this.bus.publish('inventory.agent.removed', { serverId: server.id, agentId: server.agentId }, 'manager');
    this.bus.publish('inventory.server.removed', { server }, 'manager');
    return server;
  }

  // ── Agents ─────────────────────────────────────────────────────────────────────

  /**
   * Allows an agent to connect as this server by recording its public key. Replaces any agent
   * enrolled for the server before (an agent reinstalled on the same machine has a new key).
   */
  enrolAgent(serverId: string, input: { agentId: unknown; publicKey: unknown }, by?: string): ServerRecord {
    if (!isUuid(input.agentId)) throw new InventoryError('agentId must be a UUID (see `servermin-agent status`)');
    if (!parseAgentPublicKey(input.publicKey)) throw new InventoryError('publicKey must be an Ed25519 public key (see `servermin-agent key`)');
    const agentId = input.agentId;
    const publicKey = input.publicKey as string;
    const result = this.db.transaction(() => {
      const current = this.require(serverId);
      const other = this.db.get<{ server_id: string }>('SELECT server_id FROM agents WHERE agent_id = ?', [agentId]);
      if (other && other.server_id !== serverId) throw new InventoryError('This agent is already enrolled for another server', 409);
      const now = new Date().toISOString();
      this.db.run('DELETE FROM agents WHERE server_id = ?', [serverId]);
      this.db.run('INSERT INTO agents (agent_id, server_id, public_key, enrolled_at, enrolled_by) VALUES (?, ?, ?, ?, ?)', [agentId, serverId, publicKey, now, by ?? null]);
      this.db.run("UPDATE servers SET agent_id = ?, agent_version = NULL, capabilities = '[]', state = 'OFFLINE', last_seen_at = NULL, updated_at = ? WHERE id = ?", [agentId, now, serverId]);
      return { server: this.get(serverId)!, previousAgentId: current.agentId };
    });
    // Whoever was connected for this server, under the old key or the old agent id, must go.
    if (result.previousAgentId) this.bus.publish('inventory.agent.removed', { serverId, agentId: result.previousAgentId }, 'manager');
    this.bus.publish('inventory.server.updated', { server: result.server }, 'manager');
    return result.server;
  }

  /** Revokes the server's agent: its key is forgotten and its connection, if any, is closed. */
  removeAgent(serverId: string): ServerRecord {
    const result = this.db.transaction(() => {
      const current = this.require(serverId);
      if (!current.agentId) throw new InventoryError('This server has no agent', 409);
      this.db.run('DELETE FROM agents WHERE server_id = ?', [serverId]);
      this.db.run("UPDATE servers SET agent_id = NULL, agent_version = NULL, capabilities = '[]', state = 'UNKNOWN', updated_at = ? WHERE id = ?", [new Date().toISOString(), serverId]);
      return { server: this.get(serverId)!, agentId: current.agentId };
    });
    this.bus.publish('inventory.agent.removed', { serverId, agentId: result.agentId }, 'manager');
    this.bus.publish('inventory.server.updated', { server: result.server }, 'manager');
    return result.server;
  }

  /** The key an agent must prove it holds, or undefined when no such agent is enrolled. */
  agentCredential(agentId: string): { serverId: string; publicKey: string } | undefined {
    const r = this.db.get<{ server_id: string; public_key: string }>('SELECT server_id, public_key FROM agents WHERE agent_id = ?', [agentId]);
    return r ? { serverId: r.server_id, publicKey: r.public_key } : undefined;
  }

  /**
   * Records what a connection says about a server. Only the agent hub calls this: state is never
   * set from the API. Publishes a change only when something a client can see changed.
   */
  setConnection(serverId: string, patch: { state?: ServerState; agentVersion?: string; capabilities?: string[]; seen?: boolean }): ServerRecord | undefined {
    const before = this.get(serverId);
    if (!before) return undefined;
    // A server without an agent has no connection to speak of (its agent was just revoked): it stays UNKNOWN.
    if (!before.agentId) return before;
    const state = patch.state ?? before.state;
    const agentVersion = patch.agentVersion ?? before.agentVersion;
    const capabilities = patch.capabilities ? [...new Set(patch.capabilities)].sort() : before.capabilities;
    const changed = state !== before.state || agentVersion !== before.agentVersion || JSON.stringify(capabilities) !== JSON.stringify(before.capabilities);
    if (!changed && !patch.seen) return before;
    const now = new Date().toISOString();
    this.db.run('UPDATE servers SET state = ?, agent_version = ?, capabilities = ?, last_seen_at = ?, updated_at = ? WHERE id = ?', [
      state,
      agentVersion,
      JSON.stringify(capabilities),
      patch.seen ? now : before.lastSeenAt,
      changed ? now : before.updatedAt,
      serverId,
    ]);
    const server = this.get(serverId)!;
    if (changed) this.bus.publish('inventory.server.updated', { server }, 'manager');
    return server;
  }

  /**
   * At start no agent is connected, whatever the database said when the Manager last stopped:
   * a server with an agent is OFFLINE until that agent connects, one without is UNKNOWN.
   */
  resetConnectionStates() {
    this.db.run("UPDATE servers SET state = CASE WHEN agent_id IS NULL THEN 'UNKNOWN' ELSE 'OFFLINE' END");
  }
}
