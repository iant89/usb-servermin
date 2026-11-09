import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export type PrivilegedMode = 'sudo' | 'simulate' | 'disabled';

/** Core configuration (§24, §48). Loaded from a JSON file, then environment overrides. */
export interface CoreConfig {
  http: {
    host: string;
    port: number;
    tls?: { cert: string; key: string };
    /** Trust X-Forwarded-For (only behind a local reverse proxy). */
    trustProxy: boolean;
  };
  paths: {
    /** Application files: shell bundle, bundled modules. Read-only at runtime. */
    app: string;
    /** Persistent state: SQLite databases, module data. */
    data: string;
    /** Installed modules. */
    modules: string;
    /** Rotated JSON log files (journald receives the same lines on stdout). */
    logs: string;
    /** Scratch space for staging installs. */
    tmp: string;
    /** Built shell (React app). */
    shell: string;
  };
  modules: {
    /** Directories whose modules are installed on first start (the bundled set). */
    preinstall: string[];
    /** Directories scanned for modules that can be installed (local sources). */
    sources: string[];
    /** Development: install `preinstall` modules as links and hot-reload them on change. */
    watch: boolean;
    /** Upper bound for any module worker heap. */
    maxMemoryMb: number;
    /** Timeout for initialize/start/stop of a module. */
    lifecycleTimeoutMs: number;
    healthIntervalMs: number;
  };
  privileged: {
    mode: PrivilegedMode;
    helper: string;
  };
  logging: {
    level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
    retentionDays: number;
    /** Write JSON lines to stdout (journald). */
    stdout: boolean;
    /** Also keep a rotated JSON log file in paths.logs. Off by default: journald and SQLite already keep the logs, and every extra write hurts on USB flash. */
    file: boolean;
  };
  auth: {
    sessionHours: number;
    /** `auto` sets the Secure flag when TLS is enabled. */
    secureCookies: 'auto' | boolean;
    loginAttempts: number;
    lockoutMinutes: number;
  };
  /** Updates from signed GitHub releases. Only settable in the file: where updates come from is not a runtime setting. */
  updates: {
    enabled: boolean;
    /** owner/name of the GitHub repository that publishes releases. */
    repository: string;
    apiBase: string;
    checkIntervalHours: number;
  };
  /** Development mode: relaxed CSP for the Vite dev server, verbose errors. */
  dev: boolean;
}

export function defaultConfig(base = '/'): CoreConfig {
  const p = (...s: string[]) => join(base, ...s);
  return {
    http: { host: '0.0.0.0', port: 80, trustProxy: false },
    paths: {
      app: p('opt/servermin'),
      data: p('var/lib/servermin'),
      modules: p('var/lib/servermin/modules'),
      logs: p('var/log/servermin'),
      tmp: p('var/tmp/servermin'),
      shell: p('opt/servermin/shell'),
    },
    modules: {
      preinstall: [p('opt/servermin/modules')],
      sources: [p('opt/servermin/modules')],
      watch: false,
      maxMemoryMb: 512,
      // Generous for slow media; a hung module still cannot stall the core, it only delays its own start.
      lifecycleTimeoutMs: 60_000,
      healthIntervalMs: 30_000,
    },
    privileged: { mode: 'sudo', helper: p('usr/lib/servermin/servermin-privileged') },
    logging: { level: 'INFO', retentionDays: 14, stdout: true, file: false },
    auth: { sessionHours: 12, secureCookies: 'auto', loginAttempts: 5, lockoutMinutes: 15 },
    updates: { enabled: true, repository: 'iant89/usb-servermin', apiBase: 'https://api.github.com', checkIntervalHours: 24 },
    dev: false,
  };
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

export function mergeConfig<T>(base: T, override: DeepPartial<T> | undefined): T {
  if (!override) return base;
  const out: any = Array.isArray(base) ? [...(base as unknown[])] : { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    const cur = (base as any)[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur) ? mergeConfig(cur, v as any) : v;
  }
  return out;
}

/** Loads `/etc/servermin/config.json` (or `$SERVERMIN_CONFIG`) and applies environment overrides. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  let config = defaultConfig();
  const file = env.SERVERMIN_CONFIG ?? '/etc/servermin/config.json';
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as DeepPartial<CoreConfig>;
    config = mergeConfig(config, parsed);
  }
  if (env.SERVERMIN_ROOT) {
    // Development: everything lives under one directory.
    const root = resolve(env.SERVERMIN_ROOT);
    config = mergeConfig(config, defaultConfig(root));
  }
  if (env.SERVERMIN_DATA_DIR) {
    const data = resolve(env.SERVERMIN_DATA_DIR);
    config.paths.data = data;
    config.paths.modules = join(data, 'modules');
  }
  if (env.SERVERMIN_HOST) config.http.host = env.SERVERMIN_HOST;
  if (env.SERVERMIN_PORT) config.http.port = Number(env.SERVERMIN_PORT);
  if (env.SERVERMIN_PRIVILEGED_MODE) config.privileged.mode = env.SERVERMIN_PRIVILEGED_MODE as PrivilegedMode;
  if (env.SERVERMIN_LOG_LEVEL) config.logging.level = env.SERVERMIN_LOG_LEVEL as CoreConfig['logging']['level'];
  if (env.SERVERMIN_DEV === '1') config.dev = true;
  return validateConfig(config);
}

export function validateConfig(config: CoreConfig): CoreConfig {
  const problems: string[] = [];
  if (!Number.isInteger(config.http.port) || config.http.port < 0 || config.http.port > 65535) problems.push('http.port must be 0-65535');
  for (const [k, v] of Object.entries(config.paths)) if (!isAbsolute(v)) problems.push(`paths.${k} must be absolute`);
  if (!['sudo', 'simulate', 'disabled'].includes(config.privileged.mode)) problems.push('privileged.mode must be sudo, simulate or disabled');
  if (!['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(config.logging.level)) problems.push('logging.level is invalid');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.updates.repository)) problems.push('updates.repository must be owner/name');
  if (!/^https?:\/\//.test(config.updates.apiBase)) problems.push('updates.apiBase must be an http(s) URL');
  if (!(config.updates.checkIntervalHours >= 1)) problems.push('updates.checkIntervalHours must be at least 1');
  if (problems.length) throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  return config;
}
