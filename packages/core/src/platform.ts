import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import type { HealthStatus, LogLevel } from '@servermin/sdk';
import { AgentService } from './agent/agent-service';
import { AuditLog } from './audit/audit';
import { AuthService } from './auth/auth-service';
import { randomToken } from './auth/passwords';
import { agentStateDir, type CoreConfig } from './config/config';
import { CORE_MIGRATIONS, Database } from './database/database';
import { EventBus } from './events/event-bus';
import type { PlatformSettings } from './http/api';
import { HttpServer } from './http/server';
import { LogService } from './logging/logger';
import { ModuleManager } from './modules/module-manager';
import { NotificationService } from './notifications/notifications';
import { ProcessService } from './process/process-service';
import { StorageClient } from './storage/storage-client';
import { UpdateService } from './updates/update-service';
import { ChannelHub } from './websocket/channel-hub';
import { WebSocketGateway } from './websocket/gateway';
import { CORE_VERSION } from './version';

export interface PlatformOptions {
  /** Path of the bundled worker host. Defaults to `module-host.js` next to this file. */
  workerScript?: string;
  /** Path of the bundled storage thread. Defaults to `storage-host.js` next to this file. */
  storageScript?: string;
  /** Test only: delay added to every write on the storage thread, to simulate slow media. */
  storageWriteDelayMs?: number;
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
  storage!: StorageClient;
  auth!: AuthService;
  audit!: AuditLog;
  notifications!: NotificationService;
  processes!: ProcessService;
  modules!: ModuleManager;
  updates!: UpdateService;
  agent!: AgentService;
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
    this.logs = new LogService({ level: config.logging.level, stdout: config.logging.stdout });
    this.log = this.logs.logger('core');
    this.bus = new EventBus((error, event, owner) => this.logs.write({ level: 'ERROR', source: 'events', module: owner === 'core' ? undefined : owner, message: `Handler for ${event.type} failed: ${(error as Error).message}` }));
  }

  async start() {
    const { paths } = this.config;
    for (const dir of [paths.data, paths.modules, paths.tmp]) mkdirSync(dir, { recursive: true });
    // The main thread's connection never checkpoints: the storage thread does, so a slow disk
    // (USB flash) cannot stall request handling.
    this.db = new Database(join(paths.data, 'core.db'), { autoCheckpoint: false });
    this.db.migrate(CORE_MIGRATIONS);
    this.storage = new StorageClient(
      this.options.storageScript ?? join(dirname(fileURLToPath(import.meta.url)), 'storage-host.js'),
      {
        coreDb: join(paths.data, 'core.db'),
        stdout: this.config.logging.stdout,
        logFile: this.config.logging.file ? join(paths.logs, 'servermin.log') : undefined,
        writeDelayMs: this.options.storageWriteDelayMs,
      },
      (message) => this.logs.writeDirect({ level: 'ERROR', source: 'storage', message }),
    );
    await this.storage.start();
    this.logs.attach(this.storage);
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
      storage: this.storage,
      hostname: os.hostname(),
      workerScript: this.options.workerScript ?? join(dirname(fileURLToPath(import.meta.url)), 'module-host.js'),
    });
    this.updates = new UpdateService(this);
    this.agent = new AgentService({
      stateDir: agentStateDir(this.config),
      logger: this.logs.logger('agent'),
      modules: () => this.modules.list().map((m) => ({ id: m.id, version: m.version, state: m.state, health: m.health.status, provides: m.provides, tags: m.capabilities })),
      health: () => this.health().status,
      serverName: () => this.settings().serverName,
    });
    const { replaced } = this.agent.start();
    if (replaced)
      this.notifications.notify({
        title: 'Agent identity replaced',
        message: `The identity file was unreadable (${replaced.reason}) and a new identity was created. A Servermin Manager will see this server as new. The old file was kept as ${replaced.keptAs}.`,
        tone: 'error',
        permission: 'platform.config',
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

    this.updates.start();
    this.agent.setState('RUNNING');

    this.pruneTimer = setInterval(() => void this.logs.prune(this.config.logging.retentionDays), 3_600_000);
    this.pruneTimer.unref();
    void this.logs.prune(this.config.logging.retentionDays);
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
    this.agent?.setState('STOPPING');
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.updates?.stop();
    this.gateway?.close();
    await this.http?.close();
    await this.modules?.shutdown();
    await this.logs.close();
    await this.storage?.close();
    this.db?.close();
  }
}
