import type { ConfigValues } from './config-schema';
import type { PlatformEvent } from './events';
import type { HttpMethod, RequestUser, RouteHandler, RouteOptions } from './http';
import type { ModuleManifest } from './manifest';
import type { PrivilegedOperationId } from './privileged';
import type { HealthResult } from './states';

export type Unsubscribe = () => void;

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface Logger {
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

export interface EventsApi {
  /** Publish an event. The type must start with one of the module's event namespaces. */
  publish(type: string, payload?: unknown): void;
  /** Subscribe to events matching a pattern (`docker.container.*`, `*.metrics`). */
  subscribe(pattern: string, handler: (event: PlatformEvent) => void): Unsubscribe;
}

export interface ConfigApi {
  get<T extends ConfigValues = ConfigValues>(): T;
  onChange(handler: (values: ConfigValues, changedKeys: string[]) => void): Unsubscribe;
}

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface Migration {
  /** Monotonic version number. Applied migrations are recorded and never re-run. */
  version: number;
  name: string;
  sql: string;
}

/** The module's own SQLite database. Modules cannot reach core tables or other modules' data (§23). */
export interface DatabaseApi {
  migrate(migrations: Migration[]): Promise<void>;
  run(sql: string, params?: SqlValue[] | Record<string, SqlValue>): Promise<{ changes: number; lastInsertRowid: number }>;
  get<T = Record<string, unknown>>(sql: string, params?: SqlValue[] | Record<string, SqlValue>): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, params?: SqlValue[] | Record<string, SqlValue>): Promise<T[]>;
  /** Runs statements atomically. */
  transaction(statements: { sql: string; params?: SqlValue[] | Record<string, SqlValue> }[]): Promise<void>;
}

export interface ExecuteOptions {
  /** Executable declared in `host.commands`. */
  command: string;
  args?: string[];
  /** @default 30000 */
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
  /** Data written to stdin. */
  input?: string;
  /** Maximum bytes captured per stream. @default 4 MiB */
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

export interface SpawnHandlers {
  onStdout?(chunk: string): void;
  onStderr?(chunk: string): void;
  onExit?(result: { exitCode: number | null; signal: string | null }): void;
}

export interface ProcessHandle {
  readonly id: string;
  write(data: string): void;
  kill(signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP'): void;
  /** For PTY bridges: extra control channel (fd 3) written as JSON lines. */
  control(message: unknown): void;
}

export interface ProcessApi {
  /** Run a declared command to completion, capturing output. */
  execute(options: ExecuteOptions): Promise<ProcessResult>;
  /** Start a long-running declared command and stream its output. Killed automatically on unload. */
  spawn(options: Omit<ExecuteOptions, 'input' | 'maxOutputBytes' | 'signal'> & { timeoutMs?: number; control?: boolean }, handlers: SpawnHandlers): Promise<ProcessHandle>;
  /** Ask the privilege helper to perform a catalogued operation declared in `host.privileged`. */
  privileged(operation: PrivilegedOperationId, args?: Record<string, string>, options?: { confirmed?: boolean; user?: RequestUser | string }): Promise<ProcessResult>;
  /** Is a command available on this host? */
  which(command: string): Promise<string | null>;
}

export interface HttpApi {
  route(method: HttpMethod, path: string, handler: RouteHandler, options: RouteOptions): void;
  get(path: string, handler: RouteHandler, options: RouteOptions): void;
  post(path: string, handler: RouteHandler, options: RouteOptions): void;
  put(path: string, handler: RouteHandler, options: RouteOptions): void;
  patch(path: string, handler: RouteHandler, options: RouteOptions): void;
  delete(path: string, handler: RouteHandler, options: RouteOptions): void;
}

export interface ChannelSubscription {
  id: string;
  channel: string;
  params: Record<string, unknown>;
  user: RequestUser;
}

export interface ChannelHandlers {
  /** Called when a client subscribes. Throw to reject the subscription. */
  onSubscribe?(sub: ChannelSubscription): void | Promise<void>;
  /** Called with data a client sends on its subscription (e.g. terminal input). */
  onMessage?(sub: ChannelSubscription, data: unknown): void | Promise<void>;
  onUnsubscribe?(sub: ChannelSubscription): void;
}

export interface ChannelsApi {
  /** Handle a channel declared in the manifest. */
  handle(name: string, handlers: ChannelHandlers): void;
  /** Send to a single subscription. */
  send(subscriptionId: string, data: unknown): void;
  /** Send to every subscriber of a channel. */
  broadcast(name: string, data: unknown): void;
  /** End a subscription from the server side. */
  close(subscriptionId: string, reason?: string): void;
  /** Number of active subscribers of a channel. */
  subscriberCount(name: string): number;
}

export interface ServicesApi {
  /** Provide a service declared in `provides`. Methods must accept and return JSON values. */
  provide(name: string, implementation: Record<string, (...args: any[]) => unknown>): void;
  /** Call a method of a required service. */
  call<T = unknown>(name: string, method: string, ...args: unknown[]): Promise<T>;
  /** Whether a provider of the service is active right now. */
  available(name: string): Promise<boolean>;
}

export interface NotificationsApi {
  notify(notification: { title: string; message?: string; tone?: 'information' | 'success' | 'warning' | 'error'; permission?: string }): void;
}

export interface AuditApi {
  record(entry: { action: string; target?: string; result?: 'success' | 'failure'; user?: RequestUser | string; metadata?: Record<string, unknown> }): void;
}

export interface HealthApi {
  /** Register a health check; called periodically by the core with a timeout. */
  register(check: () => HealthResult | Promise<HealthResult>): void;
}

export interface TasksApi {
  /** Run `fn` every `intervalMs`. Errors are logged; the task keeps running. Cleared on stop. */
  interval(name: string, intervalMs: number, fn: () => unknown | Promise<unknown>, options?: { immediate?: boolean }): Unsubscribe;
}

export interface SystemApi {
  hostname: string;
  platform: string;
  arch: string;
  /** Whether privileged operations are simulated (development and tests). */
  simulated: boolean;
  coreVersion: string;
}

/** The controlled API surface a module receives (§16). */
export interface ModuleContext {
  module: { id: string; version: string; manifest: ModuleManifest; dataDir: string };
  logger: Logger;
  events: EventsApi;
  config: ConfigApi;
  database: DatabaseApi;
  process: ProcessApi;
  http: HttpApi;
  channels: ChannelsApi;
  services: ServicesApi;
  notifications: NotificationsApi;
  audit: AuditApi;
  health: HealthApi;
  tasks: TasksApi;
  permissions: { declared: string[]; has(user: RequestUser, permission: string): boolean };
  system: SystemApi;
  /** Aborted when the module is stopping. Pass it to long-running work. */
  signal: AbortSignal;
}
