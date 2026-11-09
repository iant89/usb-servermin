import { Worker } from 'node:worker_threads';
import type { Migration, SqlValue } from '@servermin/sdk';
import { RpcPeer } from '../modules/rpc';
import type { StorageInit } from './storage-host';

type Params = SqlValue[] | Record<string, SqlValue>;

/** Generous: on slow media a migration or a large batch can take a long time, and only the caller waits. */
const WRITE_TIMEOUT = 300_000;
const READ_TIMEOUT = 60_000;

/**
 * Main-thread handle on the storage thread (see storage-host.ts). If the thread dies, it is
 * restarted and the failure is reported; callers waiting at that moment get an error.
 */
export class StorageClient {
  private worker!: Worker;
  private rpc!: RpcPeer;
  private ready!: Promise<void>;
  private closing = false;

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
    return this.call<void>('log.write', rows, WRITE_TIMEOUT);
  }

  queryLogs<T>(q: unknown) {
    return this.call<T[]>('log.query', q, READ_TIMEOUT);
  }

  pruneLogs(retentionDays: number, maxRows = 200_000) {
    return this.call<void>('log.prune', { retentionDays, maxRows }, WRITE_TIMEOUT);
  }

  checkpoint() {
    return this.call<void>('checkpoint', undefined, WRITE_TIMEOUT);
  }

  /** A module's own database, reached only through the storage thread. */
  moduleDb(id: string, file: string) {
    return {
      migrate: (migrations: Migration[]) => this.call<void>('db.migrate', { id, file, migrations }, WRITE_TIMEOUT),
      run: (sql: string, params?: Params) => this.call<{ changes: number; lastInsertRowid: number }>('db.run', { id, file, sql, params }, WRITE_TIMEOUT),
      get: <T>(sql: string, params?: Params) => this.call<T | undefined>('db.get', { id, file, sql, params }, READ_TIMEOUT),
      all: <T>(sql: string, params?: Params) => this.call<T[]>('db.all', { id, file, sql, params }, READ_TIMEOUT),
      transaction: (statements: { sql: string; params?: Params }[]) => this.call<void>('db.transaction', { id, file, statements }, WRITE_TIMEOUT),
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
