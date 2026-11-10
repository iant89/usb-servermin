import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HealthStatus } from '@servermin/sdk';
import {
  ACCOUNT_SCHEMA,
  AUDIT_SCHEMA,
  AuditLog,
  AuthService,
  CORE_VERSION,
  ChannelHub,
  Database,
  EventBus,
  HttpServer,
  KV_SCHEMA,
  LogService,
  SetupToken,
  WebSocketGateway,
  type CoreChannel,
  type ErrorResponse,
} from '@servermin/core';
import type { ManagerConfig } from './config';
import { INVENTORY_SCHEMA, Inventory, InventoryError } from './inventory';
import { MANAGER_SESSION_COOKIE, registerManagerRoutes } from './routes';

/** Numbered like the core's: applied migrations are recorded and never re-run. */
export const MANAGER_MIGRATIONS = [{ version: 1, name: 'manager schema', sql: ACCOUNT_SCHEMA + AUDIT_SCHEMA + KV_SCHEMA + INVENTORY_SCHEMA }];

function mapError(e: unknown): ErrorResponse | undefined {
  if (e instanceof InventoryError) return { status: e.status, body: { error: e.message } };
  return undefined;
}

/**
 * The Servermin Manager (ADR-001): accounts, the server inventory, an API and a WebSocket
 * endpoint. It is a separate process from any agent, built from the same libraries. It runs no
 * modules and has no way to execute anything on a server: no privilege helper, no sudo rule.
 */
export class Manager {
  readonly logs: LogService;
  readonly bus: EventBus;
  readonly hub = new ChannelHub();
  db!: Database;
  auth!: AuthService;
  audit!: AuditLog;
  inventory!: Inventory;
  setupToken!: SetupToken;
  http!: HttpServer;
  gateway!: WebSocketGateway;
  address: { port: number; host: string } | null = null;
  private startedAt = Date.now();
  private log;

  constructor(readonly config: ManagerConfig) {
    // Logs go to stdout, which is the journal under systemd. The Manager keeps no log database.
    this.logs = new LogService({ level: config.logging.level, stdout: config.logging.stdout });
    this.log = this.logs.logger('manager');
    this.bus = new EventBus((error, event) => this.logs.write({ level: 'ERROR', source: 'events', message: `Handler for ${event.type} failed: ${(error as Error).message}` }));
  }

  async start() {
    const { data } = this.config.paths;
    mkdirSync(data, { recursive: true, mode: 0o700 });
    // The database holds password hashes and session hashes.
    chmodSync(data, 0o700);
    this.db = new Database(join(data, 'manager.db'));
    this.db.migrate(MANAGER_MIGRATIONS);
    this.log.info(`Servermin Manager ${CORE_VERSION} starting`, { node: process.version });

    this.audit = new AuditLog(this.db);
    this.auth = new AuthService(this.db, this.config.auth);
    this.inventory = new Inventory(this.db, this.bus);
    this.setupToken = new SetupToken(join(data, 'setup-token'));
    if (this.auth.userCount() === 0) {
      const token = this.setupToken.ensure();
      // To stdout (the journal) only.
      process.stdout.write(`\n  Servermin Manager needs an administrator.\n  Create one with this setup token: ${token}\n  (also stored in ${this.setupToken.file})\n\n`);
    }

    this.http = new HttpServer({
      logs: this.logs,
      auth: this.auth,
      audit: this.audit,
      http: this.config.http,
      dev: this.config.dev,
      sessionCookie: MANAGER_SESSION_COOKIE,
      shellDir: null, // the dashboard arrives in Phase 8
      registerRoutes: (router) => registerManagerRoutes(router, this),
      mapError,
    });
    this.gateway = new WebSocketGateway({ logs: this.logs, auth: this.auth, hub: this.hub, channels: this.channels() }, this.http);
    this.address = await this.http.listen();
    this.startedAt = Date.now();
    this.log.info(`Listening on ${this.config.http.tls ? 'https' : 'http'}://${this.address.host}:${this.address.port}`, { servers: this.inventory.count().total });
    return this;
  }

  /** Real-time channels for the Manager's own clients. */
  private channels(): Record<string, CoreChannel> {
    return {
      // Every change to the inventory, as `{ type, server }`.
      inventory: {
        permission: 'servers.read',
        subscribe: (client, subId) => this.bus.subscribe('inventory.server.*', (e) => client.send({ type: 'data', id: subId, data: { type: e.type, ...(e.payload as object) } }), 'manager'),
      },
    };
  }

  health(): { status: HealthStatus; uptimeSeconds: number; startedAt: string } {
    let status: HealthStatus = 'HEALTHY';
    try {
      this.db.get('SELECT 1');
    } catch {
      status = 'ERROR';
    }
    return { status, uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000), startedAt: new Date(this.startedAt).toISOString() };
  }

  async stop() {
    this.log.info('Shutting down');
    this.gateway?.close();
    await this.http?.close();
    await this.logs.close();
    this.db?.close();
  }
}
