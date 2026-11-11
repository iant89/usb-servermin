import { randomUUID } from 'node:crypto';
import { isUuid, type Database, type EventBus } from '@servermin/core';

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

// Printable, no control characters, no leading or trailing space.
const NAME_RE = /^[^\s\p{C}](?:[^\p{C}]{0,62}[^\s\p{C}])?$/u;
const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;

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
      state: (SERVER_STATES as readonly string[]).includes(r.state) ? r.state : 'UNKNOWN',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastSeenAt: r.last_seen_at,
    };
  }

  list(): ServerRecord[] {
    return this.db.all('SELECT * FROM servers ORDER BY name COLLATE NOCASE').map((r) => this.toRecord(r));
  }

  get(id: string): ServerRecord | undefined {
    const r = this.db.get('SELECT * FROM servers WHERE id = ?', [id]);
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
    this.bus.publish('inventory.server.removed', { server }, 'manager');
    return server;
  }
}
