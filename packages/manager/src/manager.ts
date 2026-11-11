import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
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
  ensureSelfSignedCertificate,
  publicKeyFingerprint,
  type CoreChannel,
  type ErrorResponse,
} from '@servermin/core';
import type { ManagerConfig } from './config';
import { LINK_PATH } from '@servermin/protocol';
import { AGENTS_SCHEMA, AgentRegistry } from './agents';
import { INVENTORY_SCHEMA, Inventory, InventoryError } from './inventory';
import { AgentLinkServer } from './link-server';
import { MANAGER_SESSION_COOKIE, registerManagerRoutes } from './routes';

/** Numbered like the core's: applied migrations are recorded and never re-run. */
export const MANAGER_MIGRATIONS = [
  { version: 1, name: 'manager schema', sql: ACCOUNT_SCHEMA + AUDIT_SCHEMA + KV_SCHEMA + INVENTORY_SCHEMA },
  { version: 2, name: 'agents', sql: AGENTS_SCHEMA },
];

export interface ManagerTls {
  enabled: boolean;
  selfSigned: boolean;
  /** SHA-256 of the public key (SPKI): what agents pin. */
  keyFingerprint: string | null;
  notAfter: string | null;
}

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
  agents!: AgentRegistry;
  links!: AgentLinkServer;
  tls: ManagerTls = { enabled: false, selfSigned: false, keyFingerprint: null, notAfter: null };
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
    this.agents = new AgentRegistry(this.db, this.inventory);
    const reset = this.inventory.reconcileOnStart();
    if (reset) this.log.info(`Marked ${reset} server(s) offline until their agents reconnect`);
    this.setupToken = new SetupToken(join(data, 'setup-token'));
    if (this.auth.userCount() === 0) {
      const token = this.setupToken.ensure();
      // To stdout (the journal) only.
      process.stdout.write(`\n  Servermin Manager needs an administrator.\n  Create one with this setup token: ${token}\n  (also stored in ${this.setupToken.file})\n\n`);
    }

    const http = this.setupTls();
    this.links = new AgentLinkServer({ logger: this.logs.logger('agents'), audit: this.audit, bus: this.bus, inventory: this.inventory, agents: this.agents, config: this.config.agents, keyFingerprint: this.tls.keyFingerprint });
    this.http = new HttpServer({
      logs: this.logs,
      auth: this.auth,
      audit: this.audit,
      http,
      dev: this.config.dev,
      sessionCookie: MANAGER_SESSION_COOKIE,
      shellDir: null, // the dashboard arrives in Phase 8
      registerRoutes: (router) => registerManagerRoutes(router, this),
      mapError,
    });
    this.gateway = new WebSocketGateway({ logs: this.logs, auth: this.auth, hub: this.hub, channels: this.channels(), upgrades: { [LINK_PATH]: (req, socket, head) => this.links.handleUpgrade(req, socket, head) } }, this.http);
    this.address = await this.http.listen();
    this.startedAt = Date.now();
    this.log.info(`Listening on ${this.tls.enabled ? 'https' : 'http'}://${this.address.host}:${this.address.port}`, { servers: this.inventory.count().total });
    if (this.tls.keyFingerprint) {
      // Agents pin this. To stdout (the journal), next to the setup token.
      process.stdout.write(`\n  Servermin Manager key fingerprint (SHA-256): ${this.tls.keyFingerprint}\n  Agents: "agent": { "manager": { "url": "wss://<this host>:${this.address.port}", "fingerprint": "${this.tls.keyFingerprint}" } }\n\n`);
    }
    return this;
  }

  /**
   * TLS is the default (ADR-002): the configured certificate, else a self-signed one kept in the
   * data directory. Plain HTTP only when explicitly chosen.
   */
  private setupTls(): ManagerConfig['http'] {
    const http = { ...this.config.http };
    if (http.tls) {
      this.tls = { enabled: true, selfSigned: false, keyFingerprint: publicKeyFingerprint(readFileSync(http.tls.cert)), notAfter: null };
      return http;
    }
    if (!http.selfSigned) {
      this.log.warn('TLS is off (http.selfSigned is false): passwords and agent traffic travel in clear text');
      return http;
    }
    const dir = join(this.config.paths.data, 'tls');
    const host = hostname();
    const c = ensureSelfSignedCertificate(dir, { commonName: host, altNames: [...new Set([host, 'localhost', '127.0.0.1', '::1'])] });
    if (c.action === 'created') this.log.info('Created a self-signed TLS certificate', { dir, fingerprint: c.fingerprint, notAfter: c.notAfter });
    if (c.action === 'renewed') this.log.info('Renewed the self-signed TLS certificate (same key, same fingerprint)', { dir, notAfter: c.notAfter });
    this.tls = { enabled: true, selfSigned: true, keyFingerprint: c.fingerprint, notAfter: c.notAfter };
    http.tls = { cert: join(dir, 'manager.crt'), key: join(dir, 'manager.key') };
    return http;
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
    this.links?.close();
    this.gateway?.close();
    await this.http?.close();
    await this.logs.close();
    this.db?.close();
  }
}
