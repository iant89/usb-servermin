import { existsSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CORE_PERMISSIONS,
  compareVersions,
  configDefaults,
  hasPermission,
  redactConfig,
  satisfies,
  validateConfig,
  type ConfigValues,
  type HealthResult,
  type ModuleManifest,
  type ModuleState,
} from '@servermin/sdk';
import type { AuditLog } from '../audit/audit';
import type { CoreConfig } from '../config/config';
import { Database } from '../database/database';
import type { EventBus } from '../events/event-bus';
import type { LogService } from '../logging/logger';
import type { NotificationService } from '../notifications/notifications';
import type { ProcessService } from '../process/process-service';
import type { ChannelHub } from '../websocket/channel-hub';
import { CORE_VERSION } from '../version';
import { InstallError, ModuleInstaller, checkModule, type InstallSource, type StagedModule } from './installer';
import { ModuleInstance } from './module-instance';
import { RpcError } from './rpc';

export interface ManagedModule {
  id: string;
  manifest: ModuleManifest;
  dir: string;
  enabled: boolean;
  source: InstallSource;
  installedAt: string;
  updatedAt: string;
  state: ModuleState;
  stateChangedAt: string;
  error?: string;
  blockedBy: string[];
  health: HealthResult;
  /** Incremented on every load; the shell uses it to reload frontend bundles. */
  revision: number;
  instance?: ModuleInstance;
  integrity: 'verified' | 'unverified';
}

export class ModuleError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly problems: string[] = [],
  ) {
    super(message);
  }
}

interface Deps {
  config: CoreConfig;
  db: Database;
  logs: LogService;
  bus: EventBus;
  processes: ProcessService;
  notifications: NotificationService;
  audit: AuditLog;
  hub: ChannelHub;
  workerScript: string;
  hostname: string;
}

type Actor = string | undefined;

/**
 * The module runtime and registry (§9-§13, §18, §33-§35). It is the only component that moves
 * modules between lifecycle states. All lifecycle operations run through one queue, so they
 * never interleave; module code runs in workers, so a module can stall or crash without
 * blocking the queue for longer than the lifecycle timeout.
 */
export class ModuleManager {
  readonly modules = new Map<string, ManagedModule>();
  readonly installer: ModuleInstaller;
  private queue: Promise<unknown> = Promise.resolve();
  private dbs = new Map<string, Database>();
  private healthTimer: NodeJS.Timeout | null = null;
  private watchers = new Map<string, FSWatcher>();
  private log;

  constructor(private readonly d: Deps) {
    this.installer = new ModuleInstaller(d.config.paths.tmp);
    this.log = d.logs.logger('runtime');
  }

  /** Logger whose entries belong to a module, so they appear in its log view. */
  private mlog(id: string) {
    return this.d.logs.logger('runtime', id);
  }

  /** Serialise lifecycle operations. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ── Boot ───────────────────────────────────────────────────────────────────────

  async init() {
    await mkdir(this.d.config.paths.modules, { recursive: true });
    await mkdir(this.d.config.paths.tmp, { recursive: true });
    await mkdir(this.dataRoot(), { recursive: true });
    for (const row of this.d.db.all<any>('SELECT * FROM module_registry ORDER BY id')) {
      let manifest: ModuleManifest = JSON.parse(row.manifest);
      let state: ModuleState = 'INSTALLED';
      let error: string | undefined;
      try {
        manifest = (await checkModule(row.path)).manifest;
      } catch (e) {
        state = 'ERROR';
        error = `Module files are unavailable or invalid: ${(e as Error).message}`;
      }
      this.modules.set(row.id, {
        id: row.id,
        manifest,
        dir: row.path,
        enabled: !!row.enabled,
        source: JSON.parse(row.source),
        installedAt: row.installed_at,
        updatedAt: row.updated_at,
        state,
        stateChangedAt: new Date().toISOString(),
        error,
        blockedBy: [],
        health: { status: 'OFFLINE' },
        revision: 0,
        integrity: 'unverified',
      });
    }
    await this.preinstall();
    await this.serial(async () => {
      for (const m of this.ordered()) if (m.state !== 'ERROR') await this.activate(m);
    });
    this.healthTimer = setInterval(() => void this.checkHealth(), this.d.config.modules.healthIntervalMs);
    this.healthTimer.unref();
    // First health round right after start-up, so a degraded module shows immediately.
    setTimeout(() => void this.checkHealth(), 3000).unref();
  }

  /** First start: install the bundled modules through the regular pipeline (§5.3, §58). */
  private async preinstall() {
    const done = this.d.db.get<{ value: string }>("SELECT value FROM kv WHERE key = 'modules.preinstalled'");
    if (done && !this.d.config.modules.watch) return;
    for (const found of await this.installer.discover(this.d.config.modules.preinstall)) {
      if (!found.manifest || found.errors.length) {
        this.log.error(`Bundled module at ${found.path} is invalid`, { errors: found.errors });
        continue;
      }
      if (this.modules.has(found.manifest.id)) continue;
      if (done) continue;
      try {
        const source: InstallSource = this.d.config.modules.watch ? { type: 'link', path: found.path } : { type: 'directory', path: found.path };
        const staged = await this.installer.stage(source);
        await this.place(staged, 'system');
      } catch (e) {
        this.log.error(`Preinstalling ${found.manifest.id} failed: ${(e as Error).message}`, { problems: (e as InstallError).problems });
      }
    }
    this.d.db.run("INSERT OR REPLACE INTO kv (key, value) VALUES ('modules.preinstalled', ?)", [new Date().toISOString()]);
  }

  /** Providers before consumers (dependencies and capabilities). */
  private ordered(): ManagedModule[] {
    const all = [...this.modules.values()];
    const out: ManagedModule[] = [];
    const seen = new Set<string>();
    const visit = (m: ManagedModule, stack: Set<string>) => {
      if (seen.has(m.id) || stack.has(m.id)) return;
      stack.add(m.id);
      for (const dep of Object.keys(m.manifest.dependencies ?? {})) {
        const t = this.modules.get(dep);
        if (t) visit(t, stack);
      }
      for (const r of m.manifest.requires ?? []) for (const p of all) if (p.manifest.provides?.includes(r.capability)) visit(p, stack);
      stack.delete(m.id);
      seen.add(m.id);
      out.push(m);
    };
    for (const m of all) visit(m, new Set());
    return out;
  }

  // ── State ──────────────────────────────────────────────────────────────────────

  private setState(m: ManagedModule, state: ModuleState, error?: string) {
    const previous = m.state;
    m.state = state;
    m.stateChangedAt = new Date().toISOString();
    m.error = state === 'ERROR' ? error : undefined;
    if (state !== 'BLOCKED') m.blockedBy = [];
    if (state !== 'ACTIVE') m.health = { status: state === 'ERROR' ? 'ERROR' : 'OFFLINE', message: error };
    if (state === 'ERROR') this.d.db.run('UPDATE module_registry SET last_error = ? WHERE id = ?', [error ?? null, m.id]);
    if (previous !== state || state === 'ERROR') this.d.bus.publish('module.state.changed', { moduleId: m.id, state, previous, error, revision: m.revision });
  }

  /** Missing requirements of a module, or [] when it can start. */
  private unmet(m: ManagedModule): string[] {
    const missing: string[] = [];
    for (const [dep, range] of Object.entries(m.manifest.dependencies ?? {})) {
      const t = this.modules.get(dep);
      if (!t) missing.push(`module ${dep} (${range}) is not installed`);
      else if (!satisfies(t.manifest.version, range)) missing.push(`module ${dep} ${t.manifest.version} does not satisfy ${range}`);
      else if (t.state !== 'ACTIVE') missing.push(`module ${dep} is ${t.state.toLowerCase()}`);
    }
    for (const r of m.manifest.requires ?? []) {
      if (r.optional) continue;
      if (!this.providers(r.capability).length) missing.push(`capability ${r.capability} is not provided by an active module`);
    }
    return missing;
  }

  private providers(capability: string) {
    return [...this.modules.values()].filter((p) => p.state === 'ACTIVE' && p.manifest.provides?.includes(capability));
  }

  /** Modules that cannot keep running without `m`. */
  private dependents(m: ManagedModule): ManagedModule[] {
    return [...this.modules.values()].filter((x) => {
      if (x.id === m.id) return false;
      if (x.manifest.dependencies?.[m.id]) return true;
      return (x.manifest.requires ?? []).some(
        (r) => !r.optional && m.manifest.provides?.includes(r.capability) && this.providers(r.capability).filter((p) => p.id !== m.id).length === 0,
      );
    });
  }

  private dataRoot() {
    return join(this.d.config.paths.data, 'module-data');
  }

  moduleDataDir(id: string) {
    return join(this.dataRoot(), id);
  }

  getConfig(m: ManagedModule): ConfigValues {
    const row = this.d.db.get<{ values: string }>('SELECT "values" FROM module_config WHERE module_id = ?', [m.id]);
    return { ...configDefaults(m.manifest.config), ...(row ? JSON.parse(row.values) : {}) };
  }

  moduleDb(id: string): Database {
    let db = this.dbs.get(id);
    if (!db) {
      db = new Database(join(this.moduleDataDir(id), 'module.db'));
      this.dbs.set(id, db);
    }
    return db;
  }

  private closeDb(id: string) {
    this.dbs.get(id)?.close();
    this.dbs.delete(id);
  }

  // ── Activation ─────────────────────────────────────────────────────────────────

  private async activate(m: ManagedModule): Promise<void> {
    if (m.state === 'ACTIVE') return;
    if (!m.enabled) return this.setState(m, 'DISABLED');
    const missing = this.unmet(m);
    if (missing.length) {
      m.blockedBy = missing;
      this.setState(m, 'BLOCKED');
      m.blockedBy = missing;
      this.mlog(m.id).warn('Waiting for dependencies', { missing });
      return;
    }
    const timeout = this.d.config.modules.lifecycleTimeoutMs;
    m.revision++;
    this.setState(m, 'LOADING');
    await mkdir(this.moduleDataDir(m.id), { recursive: true });
    if (m.manifest.backend) {
      const instance = new ModuleInstance(
        m.manifest,
        m.dir,
        this.getConfig(m),
        this.moduleDataDir(m.id),
        {
          bus: this.d.bus,
          logs: this.d.logs,
          processes: this.d.processes,
          notifications: this.d.notifications,
          audit: this.d.audit,
          hub: this.d.hub,
          workerScript: this.d.workerScript,
          system: { hostname: this.d.hostname, platform: process.platform, arch: process.arch, simulated: this.d.config.privileged.mode !== 'sudo', coreVersion: CORE_VERSION },
          moduleDb: (id) => this.moduleDb(id),
          callService: (caller, name, method, args) => this.callService(caller, name, method, args),
          serviceAvailable: (caller, name) => this.serviceAvailable(caller, name),
          onServicesChanged: () => undefined,
          onCrash: (id, error) => void this.serial(() => this.handleCrash(id, error)),
        },
        Math.min(m.manifest.backend.maxMemoryMb ?? 192, this.d.config.modules.maxMemoryMb),
      );
      m.instance = instance;
      try {
        await instance.boot(timeout);
        await instance.initialize(timeout);
        this.setState(m, 'LOADED');
        await instance.start(timeout);
      } catch (e) {
        const message = errorMessage(e);
        await instance.shutdown(2000);
        if (m.instance === instance) m.instance = undefined;
        this.closeDb(m.id);
        this.fail(m, `Failed to start: ${message}`);
        return;
      }
    } else {
      this.setState(m, 'LOADED');
    }
    this.setState(m, 'ACTIVE');
    m.health = { status: 'HEALTHY' };
    this.d.db.run('UPDATE module_registry SET last_error = NULL WHERE id = ?', [m.id]);
    this.d.bus.publish('module.loaded', { moduleId: m.id, version: m.manifest.version });
    this.mlog(m.id).info(`${m.manifest.name} ${m.manifest.version} is active`);
    this.watch(m);
    await this.retryBlocked();
  }

  private fail(m: ManagedModule, message: string) {
    this.setState(m, 'ERROR', message);
    this.mlog(m.id).error(message);
    this.d.bus.publish('module.error', { moduleId: m.id, error: message });
    this.d.notifications.notify({ title: `Module ${m.manifest.name} failed`, message, tone: 'error', module: m.id, permission: 'modules.read' });
  }

  private async retryBlocked() {
    for (const b of this.ordered()) if (b.state === 'BLOCKED' && b.enabled && !this.unmet(b).length) await this.activate(b);
    for (const b of this.modules.values()) if (b.state === 'BLOCKED') b.blockedBy = this.unmet(b);
  }

  /** Stop a module (dependents first). `next` is the state it ends in. */
  private async deactivate(m: ManagedModule, next: ModuleState, opts: { keepDependents?: boolean } = {}) {
    if (!opts.keepDependents) {
      for (const dep of this.dependents(m)) {
        if (['ACTIVE', 'LOADED', 'LOADING'].includes(dep.state)) {
          await this.deactivate(dep, 'BLOCKED');
          dep.blockedBy = [`${m.manifest.name} is not active`];
        }
      }
    }
    this.unwatch(m.id);
    const wasRunning = ['ACTIVE', 'LOADED', 'LOADING'].includes(m.state) || !!m.instance;
    if (wasRunning) this.setState(m, 'STOPPING');
    if (m.instance) {
      const r = await m.instance.shutdown(this.d.config.modules.lifecycleTimeoutMs);
      if (!r.graceful) this.mlog(m.id).warn(`Terminated after it failed to stop: ${r.error}`);
      m.instance = undefined;
    }
    this.closeDb(m.id);
    this.setState(m, next);
    if (wasRunning) this.d.bus.publish('module.unloaded', { moduleId: m.id });
  }

  private async handleCrash(id: string, error: string) {
    const m = this.modules.get(id);
    if (!m || !m.instance) return;
    m.instance = undefined;
    this.closeDb(m.id);
    for (const dep of this.dependents(m)) if (dep.state === 'ACTIVE') await this.deactivate(dep, 'BLOCKED');
    this.fail(m, error);
  }

  // ── Public lifecycle operations ────────────────────────────────────────────────

  private require(id: string) {
    const m = this.modules.get(id);
    if (!m) throw new ModuleError(`Module ${id} is not installed`, 404);
    return m;
  }

  private auditOp(actor: Actor, action: string, id: string, result: 'success' | 'failure', metadata?: Record<string, unknown>) {
    this.d.audit.record({ user: actor ?? 'system', action, module: id, target: id, result, metadata });
  }

  private async op(actor: Actor, action: string, id: string, fn: (m: ManagedModule) => Promise<void>, metadata?: Record<string, unknown>) {
    return this.serial(async () => {
      const m = this.require(id);
      try {
        await fn(m);
        this.auditOp(actor, action, id, m.state === 'ERROR' ? 'failure' : 'success', { ...metadata, state: m.state, error: m.error });
      } catch (e) {
        this.auditOp(actor, action, id, 'failure', { ...metadata, error: (e as Error).message });
        throw e;
      }
      return this.summary(this.require(id));
    });
  }

  enable(id: string, actor?: Actor) {
    return this.op(actor, 'module.enable', id, async (m) => {
      m.enabled = true;
      this.d.db.run('UPDATE module_registry SET enabled = 1 WHERE id = ?', [id]);
      if (m.state === 'ERROR') m.state = 'STOPPED';
      await this.activate(m);
    });
  }

  disable(id: string, actor?: Actor) {
    return this.op(actor, 'module.disable', id, async (m) => {
      m.enabled = false;
      this.d.db.run('UPDATE module_registry SET enabled = 0 WHERE id = ?', [id]);
      await this.deactivate(m, 'DISABLED');
    });
  }

  /** Re-read the module from disk and start it again (§13 hot reload). */
  reload(id: string, actor?: Actor) {
    return this.op(actor, 'module.reload', id, async (m) => {
      await this.reloadInternal(m);
    });
  }

  private async reloadInternal(m: ManagedModule) {
    const restartDependents = this.dependents(m).filter((d) => d.state === 'ACTIVE');
    this.setState(m, 'RELOADING');
    await this.deactivate(m, 'RELOADING');
    try {
      const { manifest } = await checkModule(m.dir);
      if (manifest.id !== m.id) throw new ModuleError(`Module id changed from ${m.id} to ${manifest.id}`);
      m.manifest = manifest;
      this.d.db.run('UPDATE module_registry SET manifest = ?, version = ?, updated_at = ? WHERE id = ?', [JSON.stringify(manifest), manifest.version, new Date().toISOString(), m.id]);
    } catch (e) {
      this.fail(m, `Reload failed: ${errorMessage(e)}`);
      return;
    }
    m.state = 'STOPPED';
    await this.activate(m);
    for (const d of restartDependents) if (d.state !== 'ACTIVE') await this.activate(d);
  }

  /** Stop and start the same code without re-reading it. */
  restart(id: string, actor?: Actor) {
    return this.op(actor, 'module.restart', id, async (m) => {
      if (!m.enabled) throw new ModuleError('Enable the module before restarting it', 409);
      const dependents = this.dependents(m).filter((d) => d.state === 'ACTIVE');
      await this.deactivate(m, 'STOPPED');
      await this.activate(m);
      for (const d of dependents) if (d.state !== 'ACTIVE') await this.activate(d);
    });
  }

  /** Validate and install a module (§34). New modules start enabled. */
  async install(source: InstallSource, actor?: Actor) {
    const staged = await this.stageOrThrow(source, actor);
    return this.serial(async () => {
      if (this.modules.has(staged.manifest.id)) {
        await this.discard(staged);
        throw new ModuleError(`Module ${staged.manifest.id} is already installed; use update`, 409);
      }
      try {
        const m = await this.place(staged, actor);
        this.d.bus.publish('module.installed', { moduleId: m.id, version: m.manifest.version });
        this.auditOp(actor, 'module.install', m.id, 'success', { version: m.manifest.version, source: describeSource(source), integrity: staged.integrity });
        await this.activate(m);
        return { module: this.summary(m), warnings: staged.warnings };
      } catch (e) {
        this.auditOp(actor, 'module.install', staged.manifest.id, 'failure', { error: (e as Error).message });
        throw e;
      }
    });
  }

  private async stageOrThrow(source: InstallSource, actor: Actor): Promise<StagedModule> {
    if (source.type === 'link' && !this.d.config.dev && !this.d.config.modules.watch) throw new ModuleError('Linked installs are only available in development mode', 403);
    try {
      const staged = await this.installer.stage(source);
      const cycle = this.findCycle(staged.manifest);
      if (cycle) {
        await this.discard(staged);
        throw new ModuleError('Dependency cycle', 400, [cycle.join(' → ')]);
      }
      return staged;
    } catch (e) {
      if (e instanceof InstallError) {
        this.auditOp(actor, 'module.validate', 'unknown', 'failure', { error: e.message, problems: e.problems });
        throw new ModuleError(e.message, e.status, e.problems);
      }
      throw e;
    }
  }

  private findCycle(candidate: ModuleManifest): string[] | null {
    const graph = new Map<string, string[]>();
    for (const m of this.modules.values()) graph.set(m.id, Object.keys(m.manifest.dependencies ?? {}));
    graph.set(candidate.id, Object.keys(candidate.dependencies ?? {}));
    const visit = (id: string, path: string[]): string[] | null => {
      if (path.includes(id)) return [...path.slice(path.indexOf(id)), id];
      for (const next of graph.get(id) ?? []) {
        const c = visit(next, [...path, id]);
        if (c) return c;
      }
      return null;
    };
    return visit(candidate.id, []);
  }

  private async discard(staged: StagedModule) {
    if (staged.cleanup) await rm(staged.cleanup, { recursive: true, force: true });
  }

  /** Move a staged module into the modules directory and register it (INSTALLING → INSTALLED). */
  private async place(staged: StagedModule, _actor: Actor): Promise<ManagedModule> {
    const { manifest } = staged;
    const now = new Date().toISOString();
    let dir = staged.dir;
    if (staged.source.type !== 'link') {
      dir = join(this.d.config.paths.modules, manifest.id);
      await rm(dir, { recursive: true, force: true });
      await rename(staged.dir, dir);
      await this.discard(staged);
    }
    const m: ManagedModule = {
      id: manifest.id,
      manifest,
      dir,
      enabled: true,
      source: staged.source,
      installedAt: now,
      updatedAt: now,
      state: 'INSTALLING',
      stateChangedAt: now,
      blockedBy: [],
      health: { status: 'OFFLINE' },
      revision: 0,
      integrity: staged.integrity,
    };
    this.modules.set(m.id, m);
    this.d.db.run('INSERT OR REPLACE INTO module_registry (id, version, path, enabled, source, manifest, installed_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)', [
      m.id,
      manifest.version,
      dir,
      JSON.stringify(staged.source),
      JSON.stringify(manifest),
      now,
      now,
    ]);
    this.setState(m, 'INSTALLED');
    this.mlog(m.id).info(`Installed version ${manifest.version}`, { source: describeSource(staged.source), integrity: staged.integrity });
    return m;
  }

  /** Install a new version over an existing module; rolls back if the new version fails to start (§50). */
  async update(id: string, source: InstallSource, actor?: Actor) {
    const staged = await this.stageOrThrow(source, actor);
    return this.serial(async () => {
      const m = this.modules.get(id);
      if (!m) {
        await this.discard(staged);
        throw new ModuleError(`Module ${id} is not installed`, 404);
      }
      if (staged.manifest.id !== id) {
        await this.discard(staged);
        throw new ModuleError(`The package contains module ${staged.manifest.id}, not ${id}`);
      }
      const from = m.manifest.version;
      const to = staged.manifest.version;
      const dependents = this.dependents(m).filter((d) => d.state === 'ACTIVE');
      this.setState(m, 'UPDATING');
      await this.deactivate(m, 'UPDATING');
      const previous = { manifest: m.manifest, dir: m.dir, source: m.source };
      const backup = join(this.d.config.paths.tmp, `previous-${id}-${Date.now()}`);
      const isLink = m.source.type === 'link';
      try {
        if (!isLink) await rename(m.dir, backup);
        let dir = staged.dir;
        if (staged.source.type !== 'link') {
          dir = join(this.d.config.paths.modules, id);
          await rename(staged.dir, dir);
        }
        await this.discard(staged);
        Object.assign(m, { manifest: staged.manifest, dir, source: staged.source, updatedAt: new Date().toISOString(), integrity: staged.integrity });
        m.state = 'STOPPED';
        await this.activate(m);
        if ((m.state as ModuleState) !== 'ACTIVE' && m.enabled) throw new ModuleError(m.error ?? `Version ${to} did not start`, 500);
        this.d.db.run('UPDATE module_registry SET version = ?, path = ?, source = ?, manifest = ?, updated_at = ? WHERE id = ?', [to, dir, JSON.stringify(staged.source), JSON.stringify(staged.manifest), m.updatedAt, id]);
        if (!isLink) await rm(backup, { recursive: true, force: true });
        for (const d of dependents) if (d.state !== 'ACTIVE') await this.activate(d);
        const direction = compareVersions(to, from);
        this.auditOp(actor, 'module.update', id, 'success', { from, to, downgrade: direction < 0 });
        return { module: this.summary(m), warnings: staged.warnings };
      } catch (e) {
        const message = errorMessage(e);
        this.mlog(id).error(`Update to ${to} failed, rolling back to ${from}: ${message}`);
        await this.deactivate(m, 'STOPPED', { keepDependents: true });
        if (!isLink && existsSync(backup)) {
          await rm(join(this.d.config.paths.modules, id), { recursive: true, force: true });
          await rename(backup, previous.dir);
        }
        Object.assign(m, previous);
        await this.activate(m);
        for (const d of dependents) if (d.state !== 'ACTIVE') await this.activate(d);
        this.auditOp(actor, 'module.update', id, 'failure', { from, to, error: message, rolledBack: true });
        throw new ModuleError(`Update failed and was rolled back: ${message}`, 500);
      }
    });
  }

  /** Remove a module (§35). Data is deleted only when explicitly requested. */
  remove(id: string, opts: { deleteData?: boolean } = {}, actor?: Actor) {
    return this.serial(async () => {
      const m = this.require(id);
      const dependents = this.dependents(m).map((d) => d.id);
      await this.deactivate(m, 'STOPPED');
      this.modules.delete(id);
      this.d.db.run('DELETE FROM module_registry WHERE id = ?', [id]);
      if (m.source.type !== 'link') await rm(m.dir, { recursive: true, force: true });
      if (opts.deleteData) {
        await rm(this.moduleDataDir(id), { recursive: true, force: true });
        this.d.db.run('DELETE FROM module_config WHERE module_id = ?', [id]);
      }
      for (const b of this.modules.values()) if (b.state === 'BLOCKED') b.blockedBy = this.unmet(b);
      this.d.bus.publish('module.removed', { moduleId: id });
      this.auditOp(actor, 'module.remove', id, 'success', { deleteData: !!opts.deleteData, blockedDependents: dependents });
      this.log.info(`Removed ${id}${opts.deleteData ? ' and its data' : ' (data kept)'}`);
      return { removed: id, dataDeleted: !!opts.deleteData, blockedDependents: dependents };
    });
  }

  /** Validate and store module settings, then tell the module (§24). */
  setConfig(id: string, update: Record<string, unknown>, actor?: Actor) {
    return this.serial(async () => {
      const m = this.require(id);
      // Secret fields the browser sent back redacted are left unchanged.
      for (const f of m.manifest.config ?? []) if (f.type === 'secret' && update[f.key] === '••••••••') delete update[f.key];
      const r = validateConfig(m.manifest.config, this.getConfig(m), update);
      if (!r.ok) throw new ModuleError('Invalid settings', 400, Object.entries(r.errors).map(([k, v]) => `${k}: ${v}`));
      this.d.db.run('INSERT OR REPLACE INTO module_config (module_id, "values", updated_at) VALUES (?, ?, ?)', [id, JSON.stringify(r.values), new Date().toISOString()]);
      const keys = Object.keys(update);
      m.instance?.configChanged(r.values, keys);
      this.d.bus.publish('module.config.changed', { moduleId: id, keys });
      this.auditOp(actor, 'module.configure', id, 'success', { keys });
      return redactConfig(m.manifest.config, r.values);
    });
  }

  // ── Services between modules ───────────────────────────────────────────────────

  private serviceAvailable(callerId: string, name: string) {
    const caller = this.modules.get(callerId);
    if (!caller?.manifest.requires?.some((r) => r.capability === name)) return false;
    return !!this.findProvider(name);
  }

  private findProvider(name: string) {
    return [...this.modules.values()].find((p) => p.state === 'ACTIVE' && p.instance?.services.has(name));
  }

  async callService(callerId: string, name: string, method: string, args: unknown[]) {
    const caller = this.modules.get(callerId);
    if (!caller?.manifest.requires?.some((r) => r.capability === name)) throw new ModuleError(`${callerId} does not declare a requirement on ${name}`, 403);
    const provider = this.findProvider(name);
    if (!provider?.instance) throw new ModuleError(`No active module provides ${name}`, 503);
    if (!provider.instance.services.get(name)!.includes(method)) throw new ModuleError(`${name} has no method ${method}`, 404);
    return provider.instance.invokeService(name, method, args);
  }

  // ── Health ─────────────────────────────────────────────────────────────────────

  async checkHealth() {
    await Promise.all(
      [...this.modules.values()].map(async (m) => {
        if (m.state !== 'ACTIVE' || !m.instance) return;
        const before = m.health.status;
        try {
          m.health = await m.instance.health(5000);
        } catch (e) {
          m.health = { status: 'DEGRADED', message: `Health check failed: ${errorMessage(e)}` };
        }
        if (before !== m.health.status) this.d.bus.publish('module.health.changed', { moduleId: m.id, status: m.health.status, message: m.health.message });
      }),
    );
  }

  // ── Development hot reload (§52) ───────────────────────────────────────────────

  private watch(m: ManagedModule) {
    if (!this.d.config.modules.watch || this.watchers.has(m.id)) return;
    const targets = [m.manifest.backend?.entry, m.manifest.frontend?.entry].filter(Boolean).map((e) => join(m.dir, e!.split('/')[0]));
    let timer: NodeJS.Timeout | null = null;
    for (const target of [...new Set(targets)]) {
      if (!existsSync(target)) continue;
      try {
        const w = watch(target, { recursive: true }, () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            this.log.info(`Change detected in ${m.id}; reloading`);
            void this.reload(m.id, 'dev-watch').catch((e) => this.log.error(`Hot reload of ${m.id} failed: ${(e as Error).message}`));
          }, 400);
        });
        this.watchers.set(m.id, w);
      } catch (e) {
        this.log.warn(`Cannot watch ${target}: ${(e as Error).message}`);
      }
    }
  }

  private unwatch(id: string) {
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
  }

  // ── Queries ────────────────────────────────────────────────────────────────────

  summary(m: ManagedModule) {
    const inst = m.instance;
    return {
      id: m.id,
      name: m.manifest.name,
      version: m.manifest.version,
      description: m.manifest.description,
      author: m.manifest.author,
      state: m.state,
      stateChangedAt: m.stateChangedAt,
      enabled: m.enabled,
      error: m.error,
      blockedBy: m.blockedBy,
      health: m.health,
      revision: m.revision,
      source: describeSource(m.source),
      sourceType: m.source.type,
      integrity: m.integrity,
      installedAt: m.installedAt,
      updatedAt: m.updatedAt,
      dependencies: m.manifest.dependencies ?? {},
      requires: m.manifest.requires ?? [],
      provides: m.manifest.provides ?? [],
      capabilities: m.manifest.capabilities ?? [],
      permissions: m.manifest.permissions ?? [],
      channels: m.manifest.channels ?? [],
      host: m.manifest.host ?? {},
      config: m.manifest.config ?? [],
      hasBackend: !!m.manifest.backend,
      hasFrontend: !!m.manifest.frontend,
      dependents: this.dependentsOf(m.id),
      runtime: inst
        ? {
            startedAt: new Date(inst.startedAt).toISOString(),
            routes: inst.routes.map((r) => ({ method: r.method, path: r.path.pattern, permission: r.permission })),
            channels: [...inst.channels],
            services: [...inst.services.keys()],
            eventHandlers: this.d.bus.countOwner(m.id),
            subscriptions: this.d.hub.count() ? [...inst.channels].reduce((n, c) => n + this.d.hub.count(`${m.id}.${c}`), 0) : 0,
          }
        : null,
    };
  }

  private dependentsOf(id: string) {
    const m = this.modules.get(id);
    return [...this.modules.values()]
      .filter((x) => x.id !== id && (x.manifest.dependencies?.[id] || (x.manifest.requires ?? []).some((r) => m?.manifest.provides?.includes(r.capability))))
      .map((x) => x.id);
  }

  list() {
    return [...this.modules.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name)).map((m) => this.summary(m));
  }

  get(id: string) {
    return this.modules.get(id);
  }

  configFor(id: string) {
    const m = this.require(id);
    return { schema: m.manifest.config ?? [], values: redactConfig(m.manifest.config, this.getConfig(m)) };
  }

  /** Everything the browser shell needs to load module frontends (any signed-in user). */
  frontendManifest() {
    return [...this.modules.values()].map((m) => ({
      id: m.id,
      name: m.manifest.name,
      version: m.manifest.version,
      state: m.state,
      enabled: m.enabled,
      revision: m.revision,
      error: m.error,
      blockedBy: m.blockedBy,
      script: m.manifest.frontend && m.state === 'ACTIVE' ? `/modules/${m.id}/assets/${m.manifest.frontend.entry}?v=${encodeURIComponent(m.manifest.version)}-${m.revision}` : null,
      style: m.manifest.frontend?.style && m.state === 'ACTIVE' ? `/modules/${m.id}/assets/${m.manifest.frontend.style}?v=${encodeURIComponent(m.manifest.version)}-${m.revision}` : null,
    }));
  }

  /** All permissions known to the platform: core plus every installed module's declarations. */
  permissionCatalog() {
    const out: { id: string; description: string; module: string }[] = Object.entries(CORE_PERMISSIONS).map(([id, description]) => ({ id, description, module: 'core' }));
    for (const m of this.modules.values()) for (const p of m.manifest.permissions ?? []) if (!out.some((o) => o.id === p.id)) out.push({ ...p, module: m.id });
    return out;
  }

  canSubscribe(moduleId: string, channel: string, permissions: string[]) {
    const m = this.modules.get(moduleId);
    if (!m || m.state !== 'ACTIVE' || !m.instance) return { ok: false as const, status: 503, reason: 'module-unavailable' };
    if (!m.instance.channels.has(channel)) return { ok: false as const, status: 404, reason: 'unknown-channel' };
    if (!m.instance.canSubscribe(channel, permissions)) return { ok: false as const, status: 403, reason: 'forbidden' };
    return { ok: true as const, instance: m.instance };
  }

  hasPermission(permissions: string[], p: string) {
    return hasPermission(permissions, p);
  }

  async shutdown() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
    await this.serial(async () => {
      for (const m of this.ordered().reverse()) {
        if (!m.instance) continue;
        await m.instance.shutdown(5000).catch(() => undefined);
        m.instance = undefined;
        m.state = 'STOPPED';
      }
    });
    for (const id of [...this.dbs.keys()]) this.closeDb(id);
  }
}

export function describeSource(s: InstallSource): string {
  switch (s.type) {
    case 'git':
      return `git ${s.url}${s.ref ? `#${s.ref}` : ''}`;
    default:
      return `${s.type} ${s.path}`;
  }
}

function errorMessage(e: unknown) {
  if (e instanceof RpcError || e instanceof Error) return e.message;
  return String(e);
}
