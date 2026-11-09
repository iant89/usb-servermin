import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import {
  compilePath,
  hasPermission,
  publishNamespaces,
  type CompiledPath,
  type ConfigValues,
  type HealthResult,
  type ModuleManifest,
  type ModuleRequest,
  type SystemApi,
} from '@servermin/sdk';
import type { AuditLog } from '../audit/audit';
import type { Database } from '../database/database';
import type { EventBus } from '../events/event-bus';
import type { LogService } from '../logging/logger';
import type { NotificationService } from '../notifications/notifications';
import type { ProcessService } from '../process/process-service';
import type { ChannelHub } from '../websocket/channel-hub';
import { RpcPeer } from './rpc';

export interface RegisteredRoute {
  id: number;
  method: string;
  path: CompiledPath;
  permission: string;
  audit?: string;
  timeoutMs: number;
}

export interface InstanceHost {
  bus: EventBus;
  logs: LogService;
  processes: ProcessService;
  notifications: NotificationService;
  audit: AuditLog;
  hub: ChannelHub;
  system: SystemApi;
  workerScript: string;
  moduleDb(id: string): Database;
  callService(callerId: string, name: string, method: string, args: unknown[]): Promise<unknown>;
  serviceAvailable(callerId: string, name: string): boolean;
  onServicesChanged(): void;
  onCrash(id: string, error: string): void;
}

/**
 * The core's handle on one running module backend. The module runs in its own worker thread
 * (failure isolation, §5.4/§43); this class owns every resource registered on its behalf —
 * routes, channels, event subscriptions, services, processes — and releases all of them when
 * the module stops, even if the module itself misbehaves (§13).
 */
export class ModuleInstance {
  readonly routes: RegisteredRoute[] = [];
  readonly channels = new Set<string>();
  readonly services = new Map<string, string[]>();
  private eventSubs = new Map<string, () => void>();
  private processes = new Map<string, Awaited<ReturnType<ProcessService['spawn']>>>();
  private cancels = new Map<string, AbortController>();
  private worker: Worker | null = null;
  private rpc: RpcPeer | null = null;
  private stopping = false;
  private cleaned = false;
  readonly startedAt = Date.now();

  constructor(
    readonly manifest: ModuleManifest,
    readonly dir: string,
    private config: ConfigValues,
    readonly dataDir: string,
    private readonly host: InstanceHost,
    private readonly maxMemoryMb: number,
  ) {}

  get id() {
    return this.manifest.id;
  }

  private get logger() {
    return this.host.logs.logger('runtime', this.id);
  }

  /** Start the worker thread and wait until it is ready to receive calls. */
  boot(timeoutMs: number): Promise<void> {
    const entry = join(this.dir, this.manifest.backend!.entry);
    const worker = new Worker(this.host.workerScript, {
      workerData: { entry, manifest: this.manifest, config: this.config, dataDir: this.dataDir, system: this.host.system },
      resourceLimits: { maxOldGenerationSizeMb: this.maxMemoryMb, maxYoungGenerationSizeMb: Math.max(8, Math.round(this.maxMemoryMb / 8)) },
      name: `module:${this.id}`,
      stdout: false,
      stderr: false,
      env: { SERVERMIN_MODULE: this.id },
    });
    this.worker = worker;
    this.rpc = new RpcPeer(worker, this.callHandlers(), this.notificationHandlers(), (e, m) => this.logger.error(`Core handler ${m} failed: ${(e as Error).message}`));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Worker did not start within ${timeoutMs} ms`)), timeoutMs);
      const onReady = (msg: any) => {
        if (msg?.t !== 'ready') return;
        clearTimeout(timer);
        worker.off('message', onReady);
        resolve();
      };
      worker.on('message', onReady);
      worker.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
        this.crashed(`Uncaught error: ${err.message}`);
      });
      worker.once('exit', (code) => {
        clearTimeout(timer);
        if (!this.stopping) {
          reject(new Error(`Worker exited with code ${code}`));
          this.crashed(`Worker exited unexpectedly (code ${code})`);
        }
      });
    });
  }

  private crashed(error: string) {
    if (this.stopping) return;
    this.stopping = true;
    this.logger.error(`Module crashed: ${error}`);
    this.cleanup();
    this.host.onCrash(this.id, error);
  }

  call<T = unknown>(method: string, args?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.rpc) return Promise.reject(new Error('Module is not running'));
    return this.rpc.call<T>(method, args, timeoutMs);
  }

  initialize(timeoutMs: number) {
    return this.call('lifecycle.initialize', undefined, timeoutMs);
  }

  start(timeoutMs: number) {
    return this.call('lifecycle.start', undefined, timeoutMs);
  }

  /** Graceful stop: stop + destroy within the timeout, then terminate the worker regardless. */
  async shutdown(timeoutMs: number): Promise<{ graceful: boolean; error?: string }> {
    if (this.stopping && !this.worker) return { graceful: true };
    this.stopping = true;
    let graceful = true;
    let error: string | undefined;
    try {
      await this.call('lifecycle.stop', undefined, timeoutMs);
      await this.call('lifecycle.destroy', undefined, timeoutMs);
    } catch (e) {
      graceful = false;
      error = (e as Error).message;
      this.logger.warn(`Module did not stop cleanly: ${error}`);
    }
    this.cleanup();
    await this.worker?.terminate().catch(() => undefined);
    this.worker = null;
    return { graceful, error };
  }

  /** Release every resource held for the module. Idempotent. */
  cleanup() {
    if (this.cleaned) return;
    this.cleaned = true;
    this.rpc?.dispose(`Module ${this.id} is not running`);
    this.routes.length = 0;
    const closed = this.host.hub.closeOwner(this.id, 'module-unloaded');
    const events = this.host.bus.removeOwner(this.id);
    this.eventSubs.clear();
    const procs = this.host.processes.killOwner(this.id);
    this.processes.clear();
    for (const c of this.cancels.values()) c.abort();
    this.cancels.clear();
    const hadServices = this.services.size > 0;
    this.services.clear();
    this.channels.clear();
    if (hadServices) this.host.onServicesChanged();
    this.logger.debug('Resources released', { subscriptions: closed, eventHandlers: events, processes: procs });
  }

  async health(timeoutMs = 5000): Promise<HealthResult> {
    return this.call<HealthResult>('health.check', undefined, timeoutMs);
  }

  configChanged(values: ConfigValues, keys: string[]) {
    this.config = values;
    this.rpc?.notify('config.changed', { values, keys });
  }

  handleRequest(route: RegisteredRoute, request: ModuleRequest) {
    return this.call<{ status: number; headers?: Record<string, string>; body?: unknown; raw?: boolean }>('http.request', { routeId: route.id, request }, route.timeoutMs);
  }

  invokeService(name: string, method: string, args: unknown[]) {
    return this.call('service.invoke', { name, method, args }, 60_000);
  }

  private callHandlers() {
    const db = () => this.host.moduleDb(this.id);
    const commands = this.manifest.host?.commands ?? [];
    return {
      'db.migrate': (migrations: any) => db().migrate(migrations),
      'db.run': ({ sql, params }: any) => db().run(sql, params),
      'db.get': ({ sql, params }: any) => db().get(sql, params),
      'db.all': ({ sql, params }: any) => db().all(sql, params),
      'db.transaction': (statements: { sql: string; params?: any }[]) => db().transaction(() => statements.forEach((s) => db().run(s.sql, s.params))),
      'process.execute': async ({ callId, ...options }: any) => {
        const ac = new AbortController();
        this.cancels.set(callId, ac);
        try {
          return await this.host.processes.execute(this.id, commands, { ...options, signal: ac.signal });
        } finally {
          this.cancels.delete(callId);
        }
      },
      'process.spawn': async (options: any) => {
        let id = '';
        const handle = await this.host.processes.spawn(this.id, commands, options, {
          onStdout: (data) => this.rpc?.notify('process.output', { id, stream: 'stdout', data }),
          onStderr: (data) => this.rpc?.notify('process.output', { id, stream: 'stderr', data }),
          onExit: (r) => {
            this.processes.delete(id);
            this.rpc?.notify('process.exit', { id, ...r });
          },
        });
        id = handle.id;
        this.processes.set(id, handle);
        return id;
      },
      'process.privileged': ({ operation, args, confirmed, user }: any) =>
        this.host.processes.privileged(this.id, this.manifest.host?.privileged ?? [], operation, args ?? {}, { confirmed, user }),
      'process.which': ({ command }: any) => (commands.includes(command) ? this.host.processes.which(command) : null),
      'services.call': ({ name, method, args }: any) => this.host.callService(this.id, name, method, args ?? []),
      'services.available': ({ name }: any) => this.host.serviceAvailable(this.id, name),
    };
  }

  private notificationHandlers() {
    const namespaces = publishNamespaces(this.manifest);
    return {
      log: ({ level, message, metadata }: any) => this.host.logs.write({ level, source: 'module', module: this.id, message: String(message), metadata }),
      'events.publish': ({ type, payload }: any) => {
        if (typeof type !== 'string' || !namespaces.some((ns) => type.startsWith(ns + '.'))) {
          this.logger.warn(`Rejected event "${type}" outside the module's namespaces`);
          return;
        }
        this.host.bus.publish(type, payload, this.id);
      },
      'events.subscribe': ({ subId, pattern }: any) => {
        const off = this.host.bus.subscribe(String(pattern), (event) => this.rpc?.notify('event', { subId, event }), this.id);
        this.eventSubs.set(subId, off);
      },
      'events.unsubscribe': ({ subId }: any) => {
        this.eventSubs.get(subId)?.();
        this.eventSubs.delete(subId);
      },
      'http.route': ({ id, method, path, permission, audit, timeoutMs }: any) => {
        const declared = (this.manifest.permissions ?? []).map((p) => p.id);
        if (permission !== 'authenticated' && !declared.includes(permission)) {
          this.logger.error(`Rejected route ${method} ${path}: undeclared permission ${permission}`);
          return;
        }
        try {
          this.routes.push({ id, method, path: compilePath(path), permission, audit, timeoutMs: Math.min(Number(timeoutMs) || 30_000, 15 * 60_000) });
        } catch (e) {
          this.logger.error(`Rejected route ${method} ${path}: ${(e as Error).message}`);
        }
      },
      'channels.handle': ({ name }: any) => this.channels.add(name),
      'channels.send': ({ id, data }: any) => {
        const sub = this.host.hub.get(id);
        if (sub?.owner === this.id) this.host.hub.send(id, data);
      },
      'channels.broadcast': ({ name, data }: any) => this.host.hub.broadcast(`${this.id}.${name}`, data),
      'channels.close': ({ id, reason }: any) => {
        if (this.host.hub.get(id)?.owner === this.id) this.host.hub.close(id, reason ?? 'closed');
      },
      'services.provide': ({ name, methods }: any) => {
        if (!(this.manifest.provides ?? []).includes(name)) return;
        this.services.set(name, methods);
        this.host.onServicesChanged();
      },
      'process.write': ({ id, data }: any) => this.processes.get(id)?.write(data),
      'process.kill': ({ id, signal }: any) => this.processes.get(id)?.kill(signal),
      'process.control': ({ id, message }: any) => this.processes.get(id)?.control(message),
      'process.cancel': ({ callId }: any) => this.cancels.get(callId)?.abort(),
      notify: (n: any) =>
        this.host.notifications.notify({
          title: String(n?.title ?? 'Notification'),
          message: n?.message,
          tone: ['information', 'success', 'warning', 'error'].includes(n?.tone) ? n.tone : 'information',
          module: this.id,
          permission: n?.permission,
        }),
      audit: (e: any) =>
        this.host.audit.record({
          user: e?.user ?? `module:${this.id}`,
          action: String(e?.action ?? 'unknown'),
          module: this.id,
          target: e?.target,
          result: e?.result === 'failure' ? 'failure' : 'success',
          metadata: e?.metadata,
        }),
    };
  }

  /** Find the best route for a method and module-relative path. */
  match(method: string, path: string) {
    let best: { route: RegisteredRoute; params: Record<string, string> } | null = null;
    let allowed = false;
    for (const route of this.routes) {
      const m = route.path.regex.exec(path || '/');
      if (!m) continue;
      allowed = true;
      if (route.method !== method) continue;
      if (best && best.route.path.score >= route.path.score) continue;
      const params: Record<string, string> = {};
      route.path.keys.forEach((k, i) => {
        if (m[i + 1] !== undefined) params[k] = safeDecode(m[i + 1]);
      });
      best = { route, params };
    }
    return { match: best, pathExists: allowed };
  }

  canSubscribe(channel: string, permissions: string[]) {
    const def = (this.manifest.channels ?? []).find((c) => c.name === channel);
    return !!def && hasPermission(permissions, def.permission);
  }
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
