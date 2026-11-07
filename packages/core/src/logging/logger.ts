import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LogLevel, Logger } from '@servermin/sdk';
import type { Database } from '../database/database';

export interface LogEntry {
  id?: number;
  timestamp: string;
  level: LogLevel;
  /** Component inside the core (`http`, `runtime`, …) or `module`. */
  source: string;
  /** Module id when the entry belongs to a module. */
  module?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

const RANK: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

export interface LogQuery {
  module?: string;
  source?: string;
  level?: LogLevel;
  search?: string;
  before?: number;
  since?: string;
  limit?: number;
}

/**
 * Centralised structured logging (§25). Entries go to stdout as JSON (journald), to a rotated
 * file, to SQLite (so a module's logs survive its failure) and to live subscribers.
 */
export class LogService {
  private buffer: LogEntry[] = [];
  private listeners = new Set<(entry: LogEntry) => void>();
  private flushTimer: NodeJS.Timeout | null = null;
  private db: Database | null = null;
  level: LogLevel;

  constructor(
    private readonly opts: { level: LogLevel; stdout: boolean; dir?: string; maxFileBytes?: number },
  ) {
    this.level = opts.level;
    if (opts.dir) mkdirSync(opts.dir, { recursive: true });
  }

  attach(db: Database) {
    this.db = db;
    this.flushTimer = setInterval(() => this.flush(), 1000);
    this.flushTimer.unref();
  }

  write(entry: Omit<LogEntry, 'timestamp'> & { timestamp?: string }) {
    const full: LogEntry = { timestamp: entry.timestamp ?? new Date().toISOString(), ...entry } as LogEntry;
    if (RANK[full.level] === undefined) full.level = 'INFO';
    // Modules always keep DEBUG out of storage unless the platform level allows it.
    if (RANK[full.level] < RANK[this.level]) return;
    if (full.message.length > 8000) full.message = full.message.slice(0, 8000) + '…';
    const line = JSON.stringify(full);
    if (this.opts.stdout) process.stdout.write(line + '\n');
    if (this.opts.dir) this.writeFile(line);
    this.buffer.push(full);
    if (this.buffer.length >= 200) this.flush();
    for (const l of this.listeners) {
      try {
        l(full);
      } catch {
        /* a broken listener must not break logging */
      }
    }
  }

  private writeFile(line: string) {
    const file = join(this.opts.dir!, 'servermin.log');
    try {
      const max = this.opts.maxFileBytes ?? 10 * 1024 * 1024;
      if (existsSync(file) && statSync(file).size > max) {
        for (let i = 2; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
        renameSync(file, `${file}.1`);
      }
      appendFileSync(file, line + '\n');
    } catch {
      /* disk problems are reported via stdout only */
    }
  }

  flush() {
    if (!this.db || !this.buffer.length) return;
    const batch = this.buffer.splice(0);
    try {
      this.db.transaction(() => {
        for (const e of batch)
          this.db!.run('INSERT INTO logs (timestamp, level, source, module, message, metadata) VALUES (?, ?, ?, ?, ?, ?)', [
            e.timestamp,
            e.level,
            e.source,
            e.module ?? null,
            e.message,
            e.metadata ? JSON.stringify(e.metadata) : null,
          ]);
      });
    } catch (err) {
      process.stderr.write(`log flush failed: ${(err as Error).message}\n`);
    }
  }

  query(q: LogQuery = {}): LogEntry[] {
    this.flush();
    if (!this.db) return [];
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.module) where.push('module = ?') && params.push(q.module);
    if (q.source) where.push('source = ?') && params.push(q.source);
    if (q.level) {
      const levels = (Object.keys(RANK) as LogLevel[]).filter((l) => RANK[l] >= RANK[q.level!]);
      where.push(`level IN (${levels.map(() => '?').join(',')})`);
      params.push(...levels);
    }
    if (q.search) where.push('message LIKE ?') && params.push(`%${q.search}%`);
    if (q.before) where.push('id < ?') && params.push(q.before);
    if (q.since) where.push('timestamp >= ?') && params.push(q.since);
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 5000);
    const rows = this.db.all<{ id: number; timestamp: string; level: LogLevel; source: string; module: string | null; message: string; metadata: string | null }>(
      `SELECT * FROM logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`,
      params,
    );
    return rows.map((r) => ({ id: r.id, timestamp: r.timestamp, level: r.level, source: r.source, module: r.module ?? undefined, message: r.message, metadata: r.metadata ? JSON.parse(r.metadata) : undefined }));
  }

  prune(retentionDays: number, maxRows = 200_000) {
    if (!this.db) return;
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    this.db.run('DELETE FROM logs WHERE timestamp < ?', [cutoff]);
    const count = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM logs')!.n;
    if (count > maxRows) this.db.run('DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY id ASC LIMIT ?)', [count - maxRows]);
  }

  subscribe(listener: (entry: LogEntry) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  logger(source: string, module?: string): Logger {
    const log = (level: LogLevel) => (message: string, metadata?: Record<string, unknown>) => this.write({ level, source, module, message, metadata });
    return { debug: log('DEBUG'), info: log('INFO'), warn: log('WARN'), error: log('ERROR') };
  }

  close() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flush();
  }
}
