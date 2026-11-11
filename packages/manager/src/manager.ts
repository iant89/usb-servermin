import { X509Certificate } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
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
import { AgentHub } from './agent-hub';
import type { ManagerConfig } from './config';
import { AGENTS_SCHEMA, INVENTORY_SCHEMA, Inventory, InventoryError } from './inventory';
import { MANAGER_SESSION_COOKIE, registerManagerRoutes } from './routes';

/** Numbered like the core's: applied migrations are recorded and never re-run. */
export const MANAGER_MIGRATIONS = [
  { version: 1, name: 'manager schema', sql: ACCOUNT_SCHEMA + AUDIT_SCHEMA + KV_SCHEMA + INVENTORY_SCHEMA },
  { version: 2, name: 'agents', sql: AGENTS_SCHEMA },
];

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
  agents!: AgentHub;
  /** SHA-256 of the TLS certificate (lower-case hex), or '' without TLS. Agents pin it. */
  tlsFingerprint = '';
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
    this.inventory.resetConnectionStates();
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
    const tls = this.config.http.tls;
    if (tls) this.tlsFingerprint = new X509Certificate(readFileSync(tls.cert)).fingerprint256.replace(/:/g, '').toLowerCase();
    else this.log.warn('TLS is not configured: passwords, sessions and agent traffic are not encrypted. Agents will only connect if told to accept that.');
    this.agents = new AgentHub({
      inventory: this.inventory,
      audit: this.audit,
      bus: this.bus,
      logger: this.logs.logger('agents'),
      heartbeatMs: Math.round(this.config.agents.heartbeatSeconds * 1000),
      timeoutMs: Math.round(this.config.agents.timeoutSeconds * 1000),
      handshakeMs: Math.round(this.config.agents.handshakeSeconds * 1000),
      duplicateProbeMs: Math.round(this.config.agents.duplicateProbeSeconds * 1000),
      tlsFingerprint: this.tlsFingerprint,
      clientIp: (req) => (this.config.http.trustProxy && typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',')[0].trim() : (req.socket.remoteAddress ?? 'unknown')),
    });
    this.gateway = new WebSocketGateway(
      { logs: this.logs, auth: this.auth, hub: this.hub, channels: this.channels(), otherUpgrade: (req, socket, head) => this.agents.handleUpgrade(req, socket, head) },
      this.http,
    );
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
    this.agents?.close();
    this.gateway?.close();
    await this.http?.close();
    await this.logs.close();
    this.db?.close();
  }
}
