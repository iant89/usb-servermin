/**
 * Testing utilities for module authors (§36). `createTestContext` builds a complete, in-memory
 * ModuleContext: events, configuration, an in-memory SQLite database, a scriptable process
 * service, collected routes and channels. Use `harness.request()` to call routes exactly as
 * the core would, including permission checks.
 */
import { DatabaseSync } from 'node:sqlite';
import { configDefaults, validateConfig, type ConfigValues } from './config-schema';
import type {
  ChannelHandlers,
  ChannelSubscription,
  ExecuteOptions,
  Logger,
  Migration,
  ModuleContext,
  ProcessHandle,
  ProcessResult,
  SpawnHandlers,
  SqlValue,
} from './context';
import { matchesEventPattern, type PlatformEvent } from './events';
import { isHttpError, isModuleResponse, type HttpMethod, type ModuleResponse, type RequestUser, type RouteHandler, type RouteOptions } from './http';
import type { ModuleManifest } from './manifest';
import type { ServerModule } from './module';
import { hasPermission } from './permissions';
import type { PrivilegedOperationId } from './privileged';
import { compilePath, matchPath, type CompiledPath } from './route-match';
import type { HealthResult } from './states';

export type CommandMock = (args: string[], options: ExecuteOptions) => Partial<ProcessResult> | string | Promise<Partial<ProcessResult> | string>;

export interface TestContextOptions {
  config?: ConfigValues;
  /** Map of command name → mock implementation. Unmocked commands fail with exit code 127. */
  commands?: Record<string, CommandMock>;
  /** Services other modules would provide. */
  services?: Record<string, Record<string, (...args: any[]) => unknown>>;
  dataDir?: string;
}

export const TEST_ADMIN: RequestUser = { id: 1, username: 'admin', displayName: 'Administrator', permissions: ['*'] };

export function testUser(permissions: string[], username = 'tester'): RequestUser {
  return { id: 2, username, displayName: username, permissions };
}

interface Route {
  method: HttpMethod;
  path: CompiledPath;
  handler: RouteHandler;
  options: RouteOptions;
}

export interface TestHarness {
  context: ModuleContext;
  logs: { level: string; message: string; metadata?: Record<string, unknown> }[];
  published: PlatformEvent[];
  notifications: { title: string; message?: string; tone?: string }[];
  audit: Record<string, unknown>[];
  executed: { command: string; args: string[] }[];
  privileged: { operation: string; args: Record<string, string>; confirmed?: boolean }[];
  routes: Route[];
  /** Deliver an event to subscribers as if another module published it. */
  emit(type: string, payload?: unknown, source?: string): void;
  setConfig(update: ConfigValues): void;
  request<T = unknown>(method: HttpMethod, path: string, init?: { body?: unknown; query?: Record<string, string>; user?: RequestUser; remoteAddress?: string; host?: string }): Promise<{ status: number; body: T; headers: Record<string, string> }>;
  subscribe(channel: string, params?: Record<string, unknown>, user?: RequestUser): Promise<{ messages: unknown[]; send(data: unknown): Promise<void>; unsubscribe(): void; closed: boolean }>;
  runHealthChecks(): Promise<HealthResult[]>;
  /** Run every interval task once. */
  tick(): Promise<void>;
  /** Run start/stop helpers for a module object. */
  start(module: ServerModule | (() => ServerModule)): Promise<ServerModule>;
  stop(): Promise<void>;
}

export function createTestContext(manifest: ModuleManifest, options: TestContextOptions = {}): TestHarness {
  const logs: TestHarness['logs'] = [];
  const published: PlatformEvent[] = [];
  const notifications: TestHarness['notifications'] = [];
  const audit: Record<string, unknown>[] = [];
  const executed: TestHarness['executed'] = [];
  const privileged: TestHarness['privileged'] = [];
  const routes: Route[] = [];
  const channels = new Map<string, ChannelHandlers>();
  const subs = new Map<string, { sub: ChannelSubscription; messages: unknown[]; closed: boolean }>();
  const listeners: { pattern: string; handler: (e: PlatformEvent) => void }[] = [];
  const configListeners = new Set<(v: ConfigValues, k: string[]) => void>();
  const healthChecks: (() => HealthResult | Promise<HealthResult>)[] = [];
  const tasks = new Map<string, () => unknown>();
  const provided = new Map<string, Record<string, (...args: any[]) => unknown>>(Object.entries(options.services ?? {}));
  let config: ConfigValues = { ...configDefaults(manifest.config), ...options.config };
  const db = new DatabaseSync(':memory:');
  const abort = new AbortController();
  let current: ServerModule | null = null;
  let subCounter = 0;

  const log =
    (level: string) =>
    (message: string, metadata?: Record<string, unknown>) =>
      logs.push({ level, message, metadata });
  const logger: Logger = { debug: log('DEBUG'), info: log('INFO'), warn: log('WARN'), error: log('ERROR') };
  const declared = (manifest.permissions ?? []).map((p) => p.id);
  const bind = (params?: SqlValue[] | Record<string, SqlValue>) => (params === undefined ? [] : Array.isArray(params) ? params : [params]);

  const runCommand = async (opts: ExecuteOptions): Promise<ProcessResult> => {
    const allowed = manifest.host?.commands ?? [];
    if (!allowed.includes(opts.command)) throw new Error(`Command "${opts.command}" is not declared in host.commands`);
    executed.push({ command: opts.command, args: opts.args ?? [] });
    const mock = options.commands?.[opts.command];
    const base: ProcessResult = { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, cancelled: false, durationMs: 1 };
    if (!mock) return { ...base, exitCode: 127, stderr: `${opts.command}: not mocked` };
    const out = await mock(opts.args ?? [], opts);
    return typeof out === 'string' ? { ...base, stdout: out } : { ...base, ...out };
  };

  const context: ModuleContext = {
    module: { id: manifest.id, version: manifest.version, manifest, dataDir: options.dataDir ?? '/tmp' },
    logger,
    events: {
      publish(type, payload) {
        const ns = [manifest.id, ...(manifest.events?.publishes ?? [])];
        if (!ns.some((n) => type.startsWith(n + '.'))) throw new Error(`Event "${type}" is outside the module's namespaces`);
        const event = { type, source: manifest.id, timestamp: new Date().toISOString(), payload };
        published.push(event);
        for (const l of listeners) if (matchesEventPattern(l.pattern, type)) l.handler(event);
      },
      subscribe(pattern, handler) {
        const entry = { pattern, handler };
        listeners.push(entry);
        return () => listeners.splice(listeners.indexOf(entry), 1);
      },
    },
    config: {
      get: <T,>() => config as T,
      onChange(handler) {
        configListeners.add(handler);
        return () => configListeners.delete(handler);
      },
    },
    database: {
      async migrate(migrations: Migration[]) {
        db.exec('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)');
        const done = new Set((db.prepare('SELECT version FROM _migrations').all() as { version: number }[]).map((r) => r.version));
        for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
          if (done.has(m.version)) continue;
          db.exec(m.sql);
          db.prepare('INSERT INTO _migrations VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
        }
      },
      async run(sql, params) {
        const r = db.prepare(sql).run(...(bind(params) as SqlValue[]));
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      },
      async get(sql, params) {
        return db.prepare(sql).get(...(bind(params) as SqlValue[])) as any;
      },
      async all(sql, params) {
        return db.prepare(sql).all(...(bind(params) as SqlValue[])) as any;
      },
      async transaction(statements) {
        db.exec('BEGIN');
        try {
          for (const s of statements) db.prepare(s.sql).run(...(bind(s.params) as SqlValue[]));
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      },
    },
    process: {
      execute: runCommand,
      async spawn(opts, handlers: SpawnHandlers): Promise<ProcessHandle> {
        const r = await runCommand(opts);
        queueMicrotask(() => {
          if (r.stdout) handlers.onStdout?.(r.stdout);
          if (r.stderr) handlers.onStderr?.(r.stderr);
          handlers.onExit?.({ exitCode: r.exitCode, signal: null });
        });
        return { id: `p${executed.length}`, write() {}, kill() {}, control() {} };
      },
      async privileged(operation: PrivilegedOperationId, args = {}, opts = {}) {
        if (!(manifest.host?.privileged ?? []).includes(operation)) throw new Error(`Privileged operation "${operation}" is not declared`);
        privileged.push({ operation, args, confirmed: opts.confirmed });
        return { exitCode: 0, signal: null, stdout: 'simulated', stderr: '', timedOut: false, cancelled: false, durationMs: 1 };
      },
      async which(command) {
        return options.commands?.[command] ? `/usr/bin/${command}` : null;
      },
    },
    http: (() => {
      const route = (method: HttpMethod, path: string, handler: RouteHandler, opts: RouteOptions) => {
        if (opts.permission !== 'authenticated' && opts.permission !== 'public' && !declared.includes(opts.permission))
          throw new Error(`Route ${method} ${path} requires undeclared permission "${opts.permission}"`);
        routes.push({ method, path: compilePath(path), handler, options: opts });
      };
      return {
        route,
        get: (p, h, o) => route('GET', p, h, o),
        post: (p, h, o) => route('POST', p, h, o),
        put: (p, h, o) => route('PUT', p, h, o),
        patch: (p, h, o) => route('PATCH', p, h, o),
        delete: (p, h, o) => route('DELETE', p, h, o),
      };
    })(),
    channels: {
      handle(name, handlers) {
        if (!(manifest.channels ?? []).some((c) => c.name === name)) throw new Error(`Channel "${name}" is not declared`);
        channels.set(name, handlers);
      },
      send(id, data) {
        subs.get(id)?.messages.push(data);
      },
      broadcast(name, data) {
        for (const s of subs.values()) if (s.sub.channel === name && !s.closed) s.messages.push(data);
      },
      close(id) {
        const s = subs.get(id);
        if (s) s.closed = true;
      },
      subscriberCount(name) {
        return [...subs.values()].filter((s) => s.sub.channel === name && !s.closed).length;
      },
    },
    services: {
      provide(name, impl) {
        if (!(manifest.provides ?? []).includes(name)) throw new Error(`Service "${name}" is not declared in provides`);
        provided.set(name, impl);
      },
      async call(name, method, ...args) {
        const impl = provided.get(name);
        if (!impl) throw new Error(`Service "${name}" is unavailable`);
        if (typeof impl[method] !== 'function') throw new Error(`Service "${name}" has no method "${method}"`);
        return JSON.parse(JSON.stringify((await impl[method](...args)) ?? null));
      },
      async available(name) {
        return provided.has(name);
      },
    },
    notifications: { notify: (n) => notifications.push(n) },
    audit: { record: (e) => audit.push(e) },
    health: { register: (check) => healthChecks.push(check) },
    tasks: {
      interval(name, _ms, fn) {
        tasks.set(name, fn);
        return () => tasks.delete(name);
      },
    },
    permissions: { declared, has: (user, p) => hasPermission(user.permissions, p) },
    system: { hostname: 'test-host', platform: 'linux', arch: 'x64', simulated: true, coreVersion: '1.0.0' },
    signal: abort.signal,
  };

  const harness: TestHarness = {
    context,
    logs,
    published,
    notifications,
    audit,
    executed,
    privileged,
    routes,
    emit(type, payload, source = 'test') {
      const event = { type, source, timestamp: new Date().toISOString(), payload };
      for (const l of [...listeners]) if (matchesEventPattern(l.pattern, type)) l.handler(event);
    },
    setConfig(update) {
      const r = validateConfig(manifest.config, config, update);
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
      config = r.values;
      for (const l of configListeners) l(config, Object.keys(update));
    },
    async request(method, path, init = {}) {
      const user = init.user ?? TEST_ADMIN;
      const candidates = routes
        .filter((r) => r.method === method)
        .map((r) => ({ r, params: matchPath(r.path, path) }))
        .filter((x) => x.params)
        .sort((a, b) => b.r.path.score - a.r.path.score);
      const hit = candidates[0];
      if (!hit) return { status: 404, body: { error: 'Not found' } as any, headers: {} };
      if (!hasPermission(user.permissions, hit.r.options.permission)) return { status: 403, body: { error: 'Forbidden' } as any, headers: {} };
      try {
        const out = await hit.r.handler({ method, path, params: hit.params!, query: init.query ?? {}, body: init.body, headers: {}, user, requestId: 'test', remoteAddress: init.remoteAddress ?? '127.0.0.1', host: init.host ?? 'localhost' });
        if (isModuleResponse(out)) {
          const res = out as ModuleResponse;
          return { status: res.status ?? 200, body: res.body as any, headers: res.headers ?? {} };
        }
        return { status: out === undefined ? 204 : 200, body: out as any, headers: {} };
      } catch (e) {
        if (isHttpError(e)) return { status: e.status, body: { error: e.message, details: e.details } as any, headers: {} };
        return { status: 500, body: { error: (e as Error).message } as any, headers: {} };
      }
    },
    async subscribe(channel, params = {}, user = TEST_ADMIN) {
      const handlers = channels.get(channel);
      if (!handlers) throw new Error(`No handler for channel "${channel}"`);
      const sub: ChannelSubscription = { id: `s${++subCounter}`, channel, params, user };
      const state = { sub, messages: [] as unknown[], closed: false };
      subs.set(sub.id, state);
      await handlers.onSubscribe?.(sub);
      return {
        messages: state.messages,
        get closed() {
          return state.closed;
        },
        send: async (data: unknown) => {
          await handlers.onMessage?.(sub, data);
        },
        unsubscribe: () => {
          state.closed = true;
          handlers.onUnsubscribe?.(sub);
        },
      };
    },
    async runHealthChecks() {
      return Promise.all(healthChecks.map((c) => c()));
    },
    async tick() {
      for (const fn of tasks.values()) await fn();
    },
    async start(module) {
      current = typeof module === 'function' ? module() : module;
      await current.initialize(context);
      await current.start?.();
      return current;
    },
    async stop() {
      abort.abort();
      await current?.stop?.();
      await current?.destroy?.();
      db.close();
    },
  };
  return harness;
}
