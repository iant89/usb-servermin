import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import type { HealthStatus, LogLevel } from '@servermin/sdk';
import { AuditLog } from './audit/audit';
import { AuthService } from './auth/auth-service';
import { randomToken } from './auth/passwords';
import type { CoreConfig } from './config/config';
import { CORE_MIGRATIONS, Database } from './database/database';
import { EventBus } from './events/event-bus';
import type { PlatformSettings } from './http/api';
import { HttpServer } from './http/server';
import { LogService } from './logging/logger';
import { ModuleManager } from './modules/module-manager';
import { NotificationService } from './notifications/notifications';
import { ProcessService } from './process/process-service';
import { ChannelHub } from './websocket/channel-hub';
import { WebSocketGateway } from './websocket/gateway';
import { CORE_VERSION } from './version';

export interface PlatformOptions {
  /** Path of the bundled worker host. Defaults to `module-host.js` next to this file. */
  workerScript?: string;
}

/**
 * The core platform (§8): owns the database, logging, auth, event bus, process service,
 * module runtime, HTTP API and WebSocket gateway. It runs with zero modules installed.
 */
export class Platform {
  readonly logs: LogService;
  readonly bus: EventBus;
  readonly hub = new ChannelHub();
  db!: Database;
  auth!: AuthService;
  audit!: AuditLog;
  notifications!: NotificationService;
  processes!: ProcessService;
  modules!: ModuleManager;
  http!: HttpServer;
  gateway!: WebSocketGateway;
  address: { port: number; host: string } | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private startedAt = Date.now();
  private log;

  constructor(
    readonly config: CoreConfig,
    private readonly options: PlatformOptions = {},
  ) {
    this.logs = new LogService({ level: config.logging.level, stdout: config.logging.stdout, dir: config.paths.logs });
    this.log = this.logs.logger('core');
    this.bus = new EventBus((error, event, owner) => this.logs.write({ level: 'ERROR', source: 'events', module: owner === 'core' ? undefined : owner, message: `Handler for ${event.type} failed: ${(error as Error).message}` }));
  }

  async start() {
    const { paths } = this.config;
    for (const dir of [paths.data, paths.modules, paths.tmp]) mkdirSync(dir, { recursive: true });
    this.db = new Database(join(paths.data, 'core.db'));
    this.db.migrate(CORE_MIGRATIONS);
    this.logs.attach(this.db);
    this.applySettings();
    this.log.info(`Server Control core ${CORE_VERSION} starting`, { node: process.version, privileged: this.config.privileged.mode, dev: this.config.dev });

    this.audit = new AuditLog(this.db);
    this.auth = new AuthService(this.db, this.config.auth);
    this.notifications = new NotificationService(this.db, this.bus);
    this.processes = new ProcessService({ logger: this.logs.logger('process'), audit: this.audit, privilegedMode: this.config.privileged.mode, helper: this.config.privileged.helper });
    this.modules = new ModuleManager({
      config: this.config,
      db: this.db,
      logs: this.logs,
      bus: this.bus,
      processes: this.processes,
      notifications: this.notifications,
      audit: this.audit,
      hub: this.hub,
      hostname: os.hostname(),
      workerScript: this.options.workerScript ?? join(dirname(fileURLToPath(import.meta.url)), 'module-host.js'),
    });
    this.ensureSetupToken();

    // The API is available before modules finish loading so a broken module never locks users out.
    this.http = new HttpServer(this);
    this.gateway = new WebSocketGateway(this, this.http);
    this.address = await this.http.listen();
    this.log.info(`Listening on ${this.config.http.tls ? 'https' : 'http'}://${this.address.host}:${this.address.port}`);

    await this.modules.init();
    const states = this.modules.list().map((m) => `${m.id}=${m.state}`);
    this.log.info(`Modules: ${states.join(', ') || 'none installed'}`);

    this.pruneTimer = setInterval(() => this.logs.prune(this.config.logging.retentionDays), 3_600_000);
    this.pruneTimer.unref();
    this.logs.prune(this.config.logging.retentionDays);
    return this;
  }

  // ── First-run setup token ──────────────────────────────────────────────────────

  private setupTokenFile() {
    return join(this.config.paths.data, 'setup-token');
  }

  private ensureSetupToken() {
    if (this.auth.userCount() > 0) return;
    const file = this.setupTokenFile();
    if (!existsSync(file)) writeFileSync(file, randomToken(12) + '\n', { mode: 0o600 });
    const token = readFileSync(file, 'utf8').trim();
    // Written to stdout (journald) only, never to the stored platform logs.
    process.stdout.write(
      `\n  Server Control needs an administrator.\n  Open the web interface and enter this setup token: ${token}\n  (also stored in ${file})\n\n`,
    );
  }

  checkSetupToken(token: string) {
    const file = this.setupTokenFile();
    return existsSync(file) && readFileSync(file, 'utf8').trim() === token.trim();
  }

  consumeSetupToken() {
    rmSync(this.setupTokenFile(), { force: true });
  }

  // ── Platform settings (editable at runtime) ────────────────────────────────────

  settings(): PlatformSettings {
    const row = this.db.get<{ value: string }>("SELECT value FROM kv WHERE key = 'core.settings'");
    return { serverName: os.hostname(), logLevel: this.config.logging.level, ...(row ? JSON.parse(row.value) : {}) };
  }

  updateSettings(patch: Partial<PlatformSettings>): PlatformSettings {
    const next = { ...this.settings() };
    if (patch.serverName !== undefined) {
      if (typeof patch.serverName !== 'string' || !patch.serverName.trim() || patch.serverName.length > 64) throw new Error('serverName must be 1-64 characters');
      next.serverName = patch.serverName.trim();
    }
    if (patch.logLevel !== undefined) {
      if (!['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(patch.logLevel)) throw new Error('Invalid log level');
      next.logLevel = patch.logLevel as LogLevel;
    }
    this.db.run("INSERT OR REPLACE INTO kv (key, value) VALUES ('core.settings', ?)", [JSON.stringify(next)]);
    this.applySettings();
    this.bus.publish('config.changed', { keys: Object.keys(patch) });
    return next;
  }

  private applySettings() {
    this.logs.level = this.settings().logLevel;
  }

  // ── Health (§44) ───────────────────────────────────────────────────────────────

  health(): { status: HealthStatus; uptimeSeconds: number; modules: Record<string, { state: string; health: HealthStatus; message?: string }> } {
    const modules: Record<string, { state: string; health: HealthStatus; message?: string }> = {};
    let status: HealthStatus = 'HEALTHY';
    try {
      this.db.get('SELECT 1');
    } catch {
      status = 'ERROR';
    }
    for (const m of this.modules?.modules.values() ?? []) {
      modules[m.id] = { state: m.state, health: m.health.status, message: m.error ?? m.health.message };
      if (status === 'HEALTHY' && m.enabled && (m.state === 'ERROR' || m.state === 'BLOCKED' || m.health.status === 'ERROR' || m.health.status === 'DEGRADED')) status = 'DEGRADED';
    }
    return { status, uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000), modules };
  }

  async stop() {
    this.log.info('Shutting down');
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.gateway?.close();
    await this.http?.close();
    await this.modules?.shutdown();
    this.logs.close();
    this.db?.close();
  }
}
