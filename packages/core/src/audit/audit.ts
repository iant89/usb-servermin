import type { Database } from '../database/database';

export interface AuditEntry {
  id?: number;
  timestamp?: string;
  user?: string | null;
  action: string;
  module?: string | null;
  target?: string | null;
  result: 'success' | 'failure';
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export interface AuditQuery {
  user?: string;
  action?: string;
  module?: string;
  result?: string;
  search?: string;
  before?: number;
  limit?: number;
}

/** Append-only audit trail (§26). */
export class AuditLog {
  private listeners = new Set<(e: AuditEntry) => void>();

  constructor(private readonly db: Database) {}

  record(entry: AuditEntry): AuditEntry {
    const full = { ...entry, timestamp: entry.timestamp ?? new Date().toISOString() };
    const r = this.db.run('INSERT INTO audit_log (timestamp, user, action, module, target, result, metadata, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      full.timestamp,
      full.user ?? null,
      full.action,
      full.module ?? null,
      full.target ?? null,
      full.result,
      full.metadata ? JSON.stringify(full.metadata) : null,
      full.ip ?? null,
    ]);
    full.id = r.lastInsertRowid;
    for (const l of this.listeners) l(full);
    return full;
  }

  query(q: AuditQuery = {}): AuditEntry[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    const eq = (col: string, v?: string) => v && (where.push(`${col} = ?`), params.push(v));
    eq('user', q.user);
    eq('action', q.action);
    eq('module', q.module);
    eq('result', q.result);
    if (q.search) where.push('(action LIKE ? OR target LIKE ? OR user LIKE ?)') && params.push(`%${q.search}%`, `%${q.search}%`, `%${q.search}%`);
    if (q.before) where.push('id < ?') && params.push(q.before);
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 5000);
    return this.db
      .all<any>(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`, params)
      .map((r) => ({ ...r, metadata: r.metadata ? JSON.parse(r.metadata) : undefined }));
  }

  subscribe(l: (e: AuditEntry) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
