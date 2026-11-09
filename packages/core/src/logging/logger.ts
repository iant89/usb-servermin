import type { LogLevel, Logger } from '@servermin/sdk';
import type { StorageClient } from '../storage/storage-client';

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
const MAX_PENDING = 5000;

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
 * Centralised structured logging (§25). Entries reach live subscribers at once; writing them to
 * journald (stdout), SQLite and the optional log file happens in batches on the storage thread,
 * so logging never makes the main thread wait on the disk. A module's logs survive its failure.
 */
export class LogService {
  private buffer: LogEntry[] = [];
  private listeners = new Set<(entry: LogEntry) => void>();
  private flushTimer: NodeJS.Timeout | null = null;
  private storage: StorageClient | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private dropped = 0;
  level: LogLevel;

  constructor(private readonly opts: { level: LogLevel; stdout: boolean; flushIntervalMs?: number }) {
    this.level = opts.level;
  }

  attach(storage: StorageClient) {
    this.storage = storage;
    this.flushTimer = setInterval(() => void this.flush(), this.opts.flushIntervalMs ?? 1000);
    this.flushTimer.unref();
  }

  write(entry: Omit<LogEntry, 'timestamp'> & { timestamp?: string }) {
    const full: LogEntry = { timestamp: entry.timestamp ?? new Date().toISOString(), ...entry } as LogEntry;
    if (RANK[full.level] === undefined) full.level = 'INFO';
    if (RANK[full.level] < RANK[this.level]) return;
    if (full.message.length > 8000) full.message = full.message.slice(0, 8000) + '…';
    if (this.storage) {
      if (this.buffer.length >= MAX_PENDING) {
        // The disk cannot keep up: keep the newest entries, count what was dropped.
        this.buffer.shift();
        this.dropped++;
      }
      this.buffer.push(full);
    } else if (this.opts.stdout) {
      // Before the storage thread exists (start-up) and in tools: write directly.
      process.stdout.write(JSON.stringify(full) + '\n');
    }
    for (const l of this.listeners) {
      try {
        l(full);
      } catch {
        /* a broken listener must not break logging */
      }
    }
  }

  /** Hands buffered entries to the storage thread. Batches are written in order. */
  flush(): Promise<void> {
    if (!this.storage || !this.buffer.length) return this.inFlight;
    const batch = this.buffer.splice(0);
    if (this.dropped) {
      batch.unshift({ timestamp: new Date().toISOString(), level: 'WARN', source: 'logging', message: `${this.dropped} log entries were dropped because the disk could not keep up` });
      this.dropped = 0;
    }
    const storage = this.storage;
    this.inFlight = this.inFlight.then(() => storage.writeLogs(batch)).catch((err) => {
      process.stderr.write(`log flush failed: ${(err as Error).message}\n`);
    });
    return this.inFlight;
  }

  async query(q: LogQuery = {}): Promise<LogEntry[]> {
    if (!this.storage) return [];
    await this.flush();
    return this.storage.queryLogs<LogEntry>(q);
  }

  prune(retentionDays: number, maxRows = 200_000) {
    return this.storage?.pruneLogs(retentionDays, maxRows).catch((e) => process.stderr.write(`log prune failed: ${(e as Error).message}\n`));
  }

  subscribe(listener: (entry: LogEntry) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  logger(source: string, module?: string): Logger {
    const log = (level: LogLevel) => (message: string, metadata?: Record<string, unknown>) => this.write({ level, source, module, message, metadata });
    return { debug: log('DEBUG'), info: log('INFO'), warn: log('WARN'), error: log('ERROR') };
  }

  /** Last-resort output that bypasses the storage thread (fatal errors). */
  writeDirect(entry: Omit<LogEntry, 'timestamp'>) {
    process.stderr.write(JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n');
  }

  async close() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
  }
}
