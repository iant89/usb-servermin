/**
 * The storage thread. It owns everything that can make the process wait on the disk:
 *
 * - every module's SQLite database (modules already reach it asynchronously);
 * - persisting log entries to core.db, writing log lines to journald (fd 1) and the optional log file;
 * - WAL checkpoints for all databases, including the main thread's core.db connection, which
 *   runs with automatic checkpoints disabled.
 *
 * On slow media (a USB 2.0 flash drive can take seconds per synced write) only this thread
 * waits, so the HTTP server, WebSocket gateway and module RPC on the main thread stay responsive.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import type { LogLevel, Migration } from '@servermin/sdk';
import { Database, type Params } from '../database/database';
import { RpcPeer } from '../modules/rpc';

export interface StorageInit {
  coreDb: string;
  stdout: boolean;
  logFile?: string;
  maxLogFileBytes?: number;
  checkpointIntervalMs?: number;
  /** Test only: added to every write, to simulate slow media. */
  writeDelayMs?: number;
}

interface LogRow {
  timestamp: string;
  level: LogLevel;
  source: string;
  module?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

const init = workerData as StorageInit;
const core = new Database(init.coreDb);
const modules = new Map<string, Database>();
const delay = init.writeDelayMs ?? 0;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const slow = () => delay > 0 && Atomics.wait(sleeper, 0, 0, delay);

function moduleDb(id: string, file: string) {
  let db = modules.get(id);
  if (!db) {
    db = new Database(file);
    modules.set(id, db);
  }
  return db;
}

const RANK: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

function persistLogs(rows: LogRow[]) {
  if (!rows.length) return;
  const lines = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  if (init.stdout) {
    // Synchronous write to journald's stream; if journald is slow this thread waits, not the core.
    try {
      writeSync(1, lines);
    } catch {
      /* stdout closed */
    }
  }
  if (init.logFile) {
    try {
      const max = init.maxLogFileBytes ?? 10 * 1024 * 1024;
      if (existsSync(init.logFile) && statSync(init.logFile).size > max) {
        for (let i = 2; i >= 1; i--) if (existsSync(`${init.logFile}.${i}`)) renameSync(`${init.logFile}.${i}`, `${init.logFile}.${i + 1}`);
        renameSync(init.logFile, `${init.logFile}.1`);
      }
      appendFileSync(init.logFile, lines);
    } catch {
      /* disk problems are visible in journald */
    }
  }
  slow();
  core.transaction(() => {
    for (const e of rows)
      core.run('INSERT INTO logs (timestamp, level, source, module, message, metadata) VALUES (?, ?, ?, ?, ?, ?)', [
        e.timestamp,
        e.level,
        e.source,
        e.module ?? null,
        e.message,
        e.metadata ? JSON.stringify(e.metadata) : null,
      ]);
  });
}

function checkpointAll() {
  for (const db of [core, ...modules.values()]) {
    try {
      slow();
      db.checkpoint();
    } catch {
      /* busy: next round */
    }
  }
}

if (init.logFile) mkdirSync(join(init.logFile, '..'), { recursive: true });
const timer = setInterval(checkpointAll, init.checkpointIntervalMs ?? 30_000);

new RpcPeer(
  parentPort!,
  {
    'log.query': (q: { module?: string; source?: string; level?: LogLevel; search?: string; before?: number; since?: string; limit?: number }) => {
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
      const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 5000);
      return core
        .all<any>(`SELECT * FROM logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`, params)
        .map((r) => ({ id: r.id, timestamp: r.timestamp, level: r.level, source: r.source, module: r.module ?? undefined, message: r.message, metadata: r.metadata ? JSON.parse(r.metadata) : undefined }));
    },
    'log.write': (rows: LogRow[]) => persistLogs(rows),
    'log.prune': ({ retentionDays, maxRows }: { retentionDays: number; maxRows: number }) => {
      slow();
      core.run('DELETE FROM logs WHERE timestamp < ?', [new Date(Date.now() - retentionDays * 86_400_000).toISOString()]);
      const count = core.get<{ n: number }>('SELECT COUNT(*) AS n FROM logs')!.n;
      if (count > maxRows) core.run('DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY id ASC LIMIT ?)', [count - maxRows]);
    },
    'db.migrate': ({ id, file, migrations }: { id: string; file: string; migrations: Migration[] }) => {
      slow();
      moduleDb(id, file).migrate(migrations);
    },
    'db.run': ({ id, file, sql, params }: { id: string; file: string; sql: string; params?: Params }) => {
      slow();
      return moduleDb(id, file).run(sql, params);
    },
    'db.get': ({ id, file, sql, params }: { id: string; file: string; sql: string; params?: Params }) => moduleDb(id, file).get(sql, params),
    'db.all': ({ id, file, sql, params }: { id: string; file: string; sql: string; params?: Params }) => moduleDb(id, file).all(sql, params),
    'db.transaction': ({ id, file, statements }: { id: string; file: string; statements: { sql: string; params?: Params }[] }) => {
      slow();
      const db = moduleDb(id, file);
      db.transaction(() => statements.forEach((s) => db.run(s.sql, s.params)));
    },
    'db.close': ({ id }: { id: string }) => {
      const db = modules.get(id);
      modules.delete(id);
      if (db) {
        try {
          db.checkpoint();
        } catch {
          /* closing checkpoints anyway */
        }
        db.close();
      }
    },
    checkpoint: () => checkpointAll(),
    close: () => {
      clearInterval(timer);
      for (const [id, db] of modules) {
        db.close();
        modules.delete(id);
      }
      core.close();
    },
  },
  {},
);

parentPort!.postMessage({ t: 'ready' });
