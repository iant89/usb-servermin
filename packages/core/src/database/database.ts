import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Migration, SqlValue } from '@servermin/sdk';

export type Params = SqlValue[] | Record<string, SqlValue>;

/**
 * Thin persistence abstraction over SQLite (§23, §55). The core owns every connection; modules
 * reach their own database only through RPC. Keeping SQL behind this class lets the storage
 * engine change later without touching callers.
 */
export class Database {
  readonly db: DatabaseSync;

  constructor(readonly file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  }

  private bind(params?: Params): SqlValue[] {
    if (params === undefined) return [];
    return (Array.isArray(params) ? params : [params]) as SqlValue[];
  }

  run(sql: string, params?: Params) {
    const r = this.db.prepare(sql).run(...this.bind(params));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Record<string, unknown>>(sql: string, params?: Params): T | undefined {
    return this.db.prepare(sql).get(...this.bind(params)) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, params?: Params): T[] {
    return this.db.prepare(sql).all(...this.bind(params)) as T[];
  }

  exec(sql: string) {
    this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  migrate(migrations: Migration[]) {
    this.exec('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const applied = new Set(this.all<{ version: number }>('SELECT version FROM _migrations').map((r) => r.version));
    const seen = new Set<number>();
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (!Number.isInteger(m.version) || m.version < 1) throw new Error(`Migration version must be a positive integer (${m.name})`);
      if (seen.has(m.version)) throw new Error(`Duplicate migration version ${m.version}`);
      seen.add(m.version);
      if (applied.has(m.version)) continue;
      this.transaction(() => {
        this.exec(m.sql);
        this.run('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)', [m.version, m.name, new Date().toISOString()]);
      });
    }
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }
}

export const CORE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core schema',
    sql: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        permissions TEXT NOT NULL DEFAULT '[]',
        disabled INTEGER NOT NULL DEFAULT 0,
        notification_cursor INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_login_at TEXT
      );
      CREATE TABLE sessions (
        id_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        ip TEXT,
        user_agent TEXT
      );
      CREATE TABLE api_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        expires_at TEXT
      );
      CREATE TABLE module_registry (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        path TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL,
        manifest TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT
      );
      CREATE TABLE module_config (
        module_id TEXT PRIMARY KEY,
        "values" TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        user TEXT,
        action TEXT NOT NULL,
        module TEXT,
        target TEXT,
        result TEXT NOT NULL,
        metadata TEXT,
        ip TEXT
      );
      CREATE INDEX audit_log_timestamp ON audit_log(timestamp);
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL,
        source TEXT NOT NULL,
        module TEXT,
        message TEXT NOT NULL,
        metadata TEXT
      );
      CREATE INDEX logs_module ON logs(module, id);
      CREATE INDEX logs_timestamp ON logs(timestamp);
      CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT,
        tone TEXT NOT NULL,
        module TEXT,
        permission TEXT
      );
      CREATE TABLE kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];
