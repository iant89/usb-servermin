import { Worker } from 'node:worker_threads';
import type { Migration, SqlValue } from '@servermin/sdk';
import { RpcPeer } from '../modules/rpc';
import type { StorageInit } from './storage-host';

type Params = SqlValue[] | Record<string, SqlValue>;

/** Generous: on slow media a migration or a large batch can take a long time, and only the caller waits. */
const WRITE_TIMEOUT = 300_000;
const READ_TIMEOUT = 60_000;

export interface StorageStatus {
  /** True while a write has been waiting on the disk longer than the threshold (with a minimum display time). */
  busy: boolean;
  /** Writes queued or in progress on the storage thread. */
  pending: number;
  /** Age of the oldest pending write. */
  oldestMs: number;
  /** What is being written: module ids, `logs`, `checkpoint`. */
  sources: string[];
}

/**
 * Tracks writes handed to the storage thread so the UI can show "saving" while the disk lags.
 * Short writes never flip `busy`, so fast disks never show it; once shown it stays a moment, to avoid flicker.
 */
export class StorageActivity {
  private pending = new Map<number, { source: string; started: number }>();
  private seq = 0;
  private busy = false;
  private shownAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<(s: StorageStatus) => void>();

  constructor(
    private readonly thresholdMs = 500,
    private readonly minVisibleMs = 1000,
  ) {}

  track<T>(source: string, work: Promise<T>): Promise<T> {
    const id = ++this.seq;
    this.pending.set(id, { source, started: Date.now() });
    this.schedule(this.thresholdMs + 5);
    return work.finally(() => {
      this.pending.delete(id);
      this.evaluate();
    });
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.evaluate(), ms);
    this.timer.unref();
  }

  private evaluate() {
    const now = Date.now();
    const oldest = Math.min(...[...this.pending.values()].map((p) => p.started), now);
    const lagging = this.pending.size > 0 && now - oldest >= this.thresholdMs;
    if (lagging) {
      if (!this.busy) {
        this.busy = true;
        this.shownAt = now;
      }
      this.emit();
      this.schedule(1000); // refresh counts and age while busy
    } else if (this.busy) {
      const visible = now - this.shownAt;
      if (visible < this.minVisibleMs) return this.schedule(this.minVisibleMs - visible);
      this.busy = false;
      this.emit();
      if (this.pending.size) this.schedule(this.thresholdMs - (now - oldest) + 5);
    } else if (this.pending.size) {
      this.schedule(this.thresholdMs - (now - oldest) + 5);
    }
  }

  status(): StorageStatus {
    const now = Date.now();
    const items = [...this.pending.values()];
    return {
      busy: this.busy,
      pending: items.length,
      oldestMs: items.length ? now - Math.min(...items.map((p) => p.started)) : 0,
      sources: [...new Set(items.map((p) => p.source))],
    };
  }

  subscribe(listener: (s: StorageStatus) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private emit() {
    const s = this.status();
    for (const l of this.listeners) l(s);
  }
}

/**
 * Main-thread handle on the storage thread (see storage-host.ts). If the thread dies, it is
 * restarted and the failure is reported; callers waiting at that moment get an error.
 */
export class StorageClient {
  private worker!: Worker;
  private rpc!: RpcPeer;
  private ready!: Promise<void>;
  private closing = false;
  readonly activity = new StorageActivity();

  constructor(
    private readonly script: string,
    private readonly init: StorageInit,
    private readonly onError: (message: string) => void = (m) => process.stderr.write(m + '\n'),
  ) {
    this.spawn();
  }

  private spawn() {
    const worker = new Worker(this.script, { workerData: this.init, name: 'storage' });
    this.worker = worker;
    this.rpc = new RpcPeer(worker, {}, {}, (e) => this.onError(`storage: ${(e as Error).message}`));
    this.ready = new Promise((resolve, reject) => {
      const onMessage = (m: any) => {
        if (m?.t !== 'ready') return;
        worker.off('message', onMessage);
        resolve();
      };
      worker.on('message', onMessage);
      worker.once('error', (e) => {
        reject(e);
        this.onError(`Storage thread failed: ${e.message}`);
      });
    });
    this.ready.catch(() => undefined);
    worker.once('exit', (code) => {
      this.rpc.dispose('Storage thread stopped');
      if (!this.closing) {
        this.onError(`Storage thread exited (code ${code}); restarting`);
        setTimeout(() => this.spawn(), 500).unref();
      }
    });
  }

  start() {
    return this.ready;
  }

  private async call<T>(method: string, args: unknown, timeoutMs: number): Promise<T> {
    await this.ready;
    return this.rpc.call<T>(method, args, timeoutMs);
  }

  writeLogs(rows: unknown[]) {
    return this.activity.track('logs', this.call<void>('log.write', rows, WRITE_TIMEOUT));
  }

  queryLogs<T>(q: unknown) {
    return this.call<T[]>('log.query', q, READ_TIMEOUT);
  }

  pruneLogs(retentionDays: number, maxRows = 200_000) {
    return this.activity.track('logs', this.call<void>('log.prune', { retentionDays, maxRows }, WRITE_TIMEOUT));
  }

  checkpoint() {
    return this.activity.track('checkpoint', this.call<void>('checkpoint', undefined, WRITE_TIMEOUT));
  }

  /** A module's own database, reached only through the storage thread. */
  moduleDb(id: string, file: string) {
    return {
      migrate: (migrations: Migration[]) => this.activity.track(id, this.call<void>('db.migrate', { id, file, migrations }, WRITE_TIMEOUT)),
      run: (sql: string, params?: Params) => this.activity.track(id, this.call<{ changes: number; lastInsertRowid: number }>('db.run', { id, file, sql, params }, WRITE_TIMEOUT)),
      get: <T>(sql: string, params?: Params) => this.call<T | undefined>('db.get', { id, file, sql, params }, READ_TIMEOUT),
      all: <T>(sql: string, params?: Params) => this.call<T[]>('db.all', { id, file, sql, params }, READ_TIMEOUT),
      transaction: (statements: { sql: string; params?: Params }[]) => this.activity.track(id, this.call<void>('db.transaction', { id, file, statements }, WRITE_TIMEOUT)),
    };
  }

  closeModuleDb(id: string) {
    return this.call<void>('db.close', { id }, WRITE_TIMEOUT).catch(() => undefined);
  }

  async close() {
    this.closing = true;
    await this.call('close', undefined, WRITE_TIMEOUT).catch(() => undefined);
    await this.worker.terminate();
  }
}

export type ModuleDbClient = ReturnType<StorageClient['moduleDb']>;
