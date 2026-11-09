/**
 * Entry point of a module worker thread. Loads the module's backend bundle, builds the
 * ModuleContext as an RPC proxy to the core, and drives the lifecycle on the core's request.
 * Everything the module creates lives in this thread, so terminating the worker releases it.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import {
  HttpError,
  hasPermission,
  isHttpError,
  isModuleResponse,
  publishNamespaces,
  type ChannelHandlers,
  type ChannelSubscription,
  type ConfigValues,
  type HealthResult,
  type ModuleContext,
  type ModuleManifest,
  type PlatformEvent,
  type RouteHandler,
  type ServerModule,
  type SpawnHandlers,
} from '@servermin/sdk';
import { RpcPeer } from './rpc';

interface WorkerInit {
  entry: string;
  manifest: ModuleManifest;
  config: ConfigValues;
  dataDir: string;
  system: ModuleContext['system'];
}

const init = workerData as WorkerInit;
const manifest = init.manifest;
const declared = (manifest.permissions ?? []).map((p) => p.id);
let config = init.config;
let mod: ServerModule | null = null;
const abort = new AbortController();

const routes: { handler: RouteHandler }[] = [];
const channelHandlers = new Map<string, ChannelHandlers>();
const subscriptions = new Map<string, ChannelSubscription>();
const eventHandlers = new Map<string, (e: PlatformEvent) => void>();
const configListeners = new Set<(v: ConfigValues, k: string[]) => void>();
const healthChecks: (() => HealthResult | Promise<HealthResult>)[] = [];
const services = new Map<string, Record<string, (...a: any[]) => unknown>>();
const spawned = new Map<string, SpawnHandlers>();
const intervals = new Map<string, NodeJS.Timeout>();
let eventSeq = 0;

const rpc = new RpcPeer(
  parentPort!,
  {
    'lifecycle.initialize': async () => {
      const loaded = await import(pathToFileURL(init.entry).href);
      const exported = loaded.default ?? loaded.module;
      if (!exported) throw new Error('Backend bundle has no default export');
      mod = typeof exported === 'function' ? exported() : exported;
      if (!mod || typeof mod.initialize !== 'function') throw new Error('Backend default export is not a ServerModule');
      await mod.initialize(context);
    },
    'lifecycle.start': async () => {
      await mod?.start?.();
    },
    'lifecycle.stop': async () => {
      abort.abort();
      for (const t of intervals.values()) clearInterval(t);
      intervals.clear();
      await mod?.stop?.();
    },
    'lifecycle.destroy': async () => {
      await mod?.destroy?.();
      mod = null;
    },
    'http.request': async ({ routeId, request }) => {
      const route = routes[routeId];
      if (!route) throw new HttpError(404, 'Route not found');
      try {
        const out = await route.handler(request);
        if (isModuleResponse(out)) return { status: out.status ?? 200, headers: out.headers, body: out.body, raw: out.raw };
        return out === undefined ? { status: 204 } : { status: 200, body: out };
      } catch (e) {
        if (isHttpError(e)) return { status: e.status, body: { error: e.message, details: e.details } };
        // Errors from core services (e.g. 403 undeclared command, 424 command not installed) keep their status.
        const status = (e as { status?: unknown })?.status;
        if ((e as Error)?.name === 'RpcError' && typeof status === 'number' && status >= 400 && status < 600) return { status, body: { error: (e as Error).message } };
        log('ERROR', `Route ${request.method} ${request.path} failed: ${(e as Error)?.message}`, { stack: (e as Error)?.stack });
        return { status: 500, body: { error: (e as Error)?.message ?? 'Internal error' } };
      }
    },
    'channel.subscribe': async (sub: ChannelSubscription) => {
      const h = channelHandlers.get(sub.channel);
      if (!h) throw new HttpError(404, `Channel ${sub.channel} has no handler`);
      subscriptions.set(sub.id, sub);
      try {
        await h.onSubscribe?.(sub);
      } catch (e) {
        subscriptions.delete(sub.id);
        throw e;
      }
    },
    'channel.message': async ({ id, data }) => {
      const sub = subscriptions.get(id);
      if (sub) await channelHandlers.get(sub.channel)?.onMessage?.(sub, data);
    },
    'channel.unsubscribe': async ({ id }) => {
      const sub = subscriptions.get(id);
      if (!sub) return;
      subscriptions.delete(id);
      channelHandlers.get(sub.channel)?.onUnsubscribe?.(sub);
    },
    'health.check': async () => {
      if (!healthChecks.length) return { status: 'HEALTHY' };
      const results = await Promise.all(healthChecks.map((c) => Promise.resolve().then(c).catch((e) => ({ status: 'ERROR', message: (e as Error).message }) as HealthResult)));
      const rank = { HEALTHY: 0, DEGRADED: 1, ERROR: 2, OFFLINE: 3 } as const;
      return results.reduce((worst, r) => (rank[r.status] > rank[worst.status] ? r : worst), { status: 'HEALTHY' } as HealthResult);
    },
    'service.invoke': async ({ name, method, args }) => {
      const impl = services.get(name);
      if (!impl) throw new HttpError(503, `Service ${name} is not provided`);
      const fn = impl[method];
      if (typeof fn !== 'function') throw new HttpError(404, `Service ${name} has no method ${method}`);
      return fn.apply(impl, args ?? []);
    },
  },
  {
    event: ({ subId, event }) => eventHandlers.get(subId)?.(event),
    'config.changed': ({ values, keys }) => {
      config = values;
      for (const l of configListeners) l(values, keys);
    },
    'process.output': ({ id, stream, data }) => {
      const h = spawned.get(id);
      if (stream === 'stdout') h?.onStdout?.(data);
      else h?.onStderr?.(data);
    },
    'process.exit': ({ id, exitCode, signal }) => {
      spawned.get(id)?.onExit?.({ exitCode, signal });
      spawned.delete(id);
    },
  },
  (e, method) => log('ERROR', `Handler for ${method} failed: ${(e as Error)?.message}`),
);

function log(level: string, message: string, metadata?: Record<string, unknown>) {
  rpc.notify('log', { level, message: String(message), metadata: safe(metadata) });
}

function safe(v: unknown) {
  if (v === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return { value: String(v) };
  }
}

process.on('unhandledRejection', (reason) => {
  log('ERROR', `Unhandled promise rejection: ${(reason as Error)?.message ?? String(reason)}`, { stack: (reason as Error)?.stack });
});

const namespaces = publishNamespaces(manifest);

const context: ModuleContext = {
  module: { id: manifest.id, version: manifest.version, manifest, dataDir: init.dataDir },
  logger: {
    debug: (m, md) => log('DEBUG', m, md),
    info: (m, md) => log('INFO', m, md),
    warn: (m, md) => log('WARN', m, md),
    error: (m, md) => log('ERROR', m, md),
  },
  events: {
    publish(type, payload) {
      if (!namespaces.some((ns) => type.startsWith(ns + '.'))) throw new Error(`Event "${type}" is outside this module's namespaces (${namespaces.join(', ')})`);
      rpc.notify('events.publish', { type, payload: safe(payload) });
    },
    subscribe(pattern, handler) {
      const subId = `e${++eventSeq}`;
      eventHandlers.set(subId, (e) => {
        try {
          handler(e);
        } catch (err) {
          log('ERROR', `Event handler for ${pattern} failed: ${(err as Error).message}`);
        }
      });
      rpc.notify('events.subscribe', { subId, pattern });
      return () => {
        eventHandlers.delete(subId);
        rpc.notify('events.unsubscribe', { subId });
      };
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
    // Generous timeouts: on slow media the storage thread may need a while; only this module waits.
    migrate: (migrations) => rpc.call('db.migrate', migrations, 300_000),
    run: (sql, params) => rpc.call('db.run', { sql, params }, 300_000),
    get: (sql, params) => rpc.call('db.get', { sql, params }, 60_000),
    all: (sql, params) => rpc.call('db.all', { sql, params }, 60_000),
    transaction: (statements) => rpc.call('db.transaction', statements, 300_000),
  },
  process: {
    async execute(options) {
      const { signal, ...rest } = options;
      if (signal?.aborted) throw new Error('Aborted');
      const callId = `x${++eventSeq}`;
      const onAbort = () => rpc.notify('process.cancel', { callId });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        return await rpc.call('process.execute', { ...rest, callId }, (rest.timeoutMs ?? 30_000) + 10_000);
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
    async spawn(options, handlers) {
      const id = await rpc.call<string>('process.spawn', options);
      spawned.set(id, handlers);
      return {
        id,
        write: (data: string) => rpc.notify('process.write', { id, data }),
        kill: (signal?: string) => rpc.notify('process.kill', { id, signal }),
        control: (message: unknown) => rpc.notify('process.control', { id, message }),
      };
    },
    privileged: (operation, args, options) => rpc.call('process.privileged', { operation, args, confirmed: options?.confirmed, user: typeof options?.user === 'string' ? options.user : options?.user?.username }, 35 * 60_000),
    which: (command) => rpc.call('process.which', { command }),
  },
  http: (() => {
    const route = (method: string, path: string, handler: RouteHandler, options: { permission: string; audit?: string; timeoutMs?: number }) => {
      if (options.permission !== 'authenticated' && !declared.includes(options.permission))
        throw new Error(`Route ${method} ${path} requires undeclared permission "${options.permission}"`);
      if (!path.startsWith('/')) throw new Error(`Route path must start with "/": ${path}`);
      const id = routes.push({ handler }) - 1;
      rpc.notify('http.route', { id, method, path, permission: options.permission, audit: options.audit, timeoutMs: options.timeoutMs });
    };
    return {
      route: route as ModuleContext['http']['route'],
      get: (p, h, o) => route('GET', p, h, o),
      post: (p, h, o) => route('POST', p, h, o),
      put: (p, h, o) => route('PUT', p, h, o),
      patch: (p, h, o) => route('PATCH', p, h, o),
      delete: (p, h, o) => route('DELETE', p, h, o),
    };
  })(),
  channels: {
    handle(name, handlers) {
      if (!(manifest.channels ?? []).some((c) => c.name === name)) throw new Error(`Channel "${name}" is not declared in the manifest`);
      channelHandlers.set(name, handlers);
      rpc.notify('channels.handle', { name });
    },
    send: (subscriptionId, data) => rpc.notify('channels.send', { id: subscriptionId, data: safe(data) }),
    broadcast: (name, data) => rpc.notify('channels.broadcast', { name, data: safe(data) }),
    close: (subscriptionId, reason) => {
      subscriptions.delete(subscriptionId);
      rpc.notify('channels.close', { id: subscriptionId, reason });
    },
    subscriberCount: (name) => [...subscriptions.values()].filter((s) => s.channel === name).length,
  },
  services: {
    provide(name, implementation) {
      if (!(manifest.provides ?? []).includes(name)) throw new Error(`Service "${name}" is not declared in provides`);
      services.set(name, implementation);
      rpc.notify('services.provide', { name, methods: Object.keys(implementation).filter((k) => typeof implementation[k] === 'function') });
    },
    call: (name, method, ...args) => rpc.call('services.call', { name, method, args: safe(args) }, 60_000),
    available: (name) => rpc.call('services.available', { name }),
  },
  notifications: { notify: (n) => rpc.notify('notify', safe(n)) },
  audit: { record: (e) => rpc.notify('audit', safe({ ...e, user: typeof e.user === 'object' ? e.user.username : e.user })) },
  health: {
    register(check) {
      healthChecks.push(check);
    },
  },
  tasks: {
    interval(name, intervalMs, fn, options) {
      const run = () =>
        Promise.resolve()
          .then(fn)
          .catch((e) => log('ERROR', `Task ${name} failed: ${(e as Error)?.message}`));
      const existing = intervals.get(name);
      if (existing) clearInterval(existing);
      const timer = setInterval(run, Math.max(intervalMs, 250));
      intervals.set(name, timer);
      if (options?.immediate) void run();
      return () => {
        clearInterval(timer);
        intervals.delete(name);
      };
    },
  },
  permissions: { declared, has: (user, permission) => hasPermission(user.permissions, permission) },
  system: init.system,
  get signal() {
    return abort.signal;
  },
};

parentPort!.postMessage({ t: 'ready' });
