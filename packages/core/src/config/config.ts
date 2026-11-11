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
  /** This server as a Servermin agent. */
  agent: {
    /**
     * Directory that holds the agent identity. `null` means `<paths.data>/agent`, so the identity
     * travels with the data. Point it at a disk of the machine to tie the identity to the machine.
     */
    stateDir: string | null;
    /** The Servermin Manager this agent reports to. Without a `url` the server is standalone. */
    manager: {
      /** `https://manager:8480` (or `wss://`). Plain `http://`/`ws://` needs `insecure: true`. */
      url: string | null;
      /** SHA-256 fingerprint of the Manager's certificate: accept exactly that certificate (self-signed included). */
      fingerprint: string | null;
      /** PEM file of the CA that signed the Manager's certificate, when it is neither public nor pinned. */
      ca: string | null;
      /** Allow a connection without TLS. Only for a Manager on the same machine or a network you fully trust. */
      insecure: boolean;
    };
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
    agent: { stateDir: null, manager: { url: null, fingerprint: null, ca: null, insecure: false } },
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

/** Where the agent identity lives (see `agent.stateDir`). */
export function agentStateDir(config: CoreConfig): string {
  return config.agent.stateDir ?? join(config.paths.data, 'agent');
}

export type ManagerSettings = CoreConfig['agent']['manager'];

/** Checks Manager connection settings, from the configuration file or from a registration. */
export function validateManagerSettings(m: ManagerSettings, prefix: string): string[] {
  const problems: string[] = [];
  if (!m || typeof m !== 'object') return [`${prefix} must be an object`];
  if (m.url !== null) {
    let url: URL | null = null;
    try {
      url = typeof m.url === 'string' ? new URL(m.url) : null;
    } catch {
      /* reported below */
    }
    if (!url || !['https:', 'wss:', 'http:', 'ws:'].includes(url.protocol) || !url.hostname) problems.push(`${prefix}.url must be an https:// or wss:// URL`);
    else if (url.username || url.password) problems.push(`${prefix}.url must not contain credentials`);
    else if (['http:', 'ws:'].includes(url.protocol) && m.insecure !== true) problems.push(`${prefix}.url is not encrypted; use https:// (or set ${prefix}.insecure to true on a network you fully trust)`);
    if (m.fingerprint !== null && (typeof m.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(m.fingerprint.replace(/^sha-?256[:=]/i, '').replace(/[:\s]/g, '').toLowerCase())))
      problems.push(`${prefix}.fingerprint must be a SHA-256 certificate fingerprint (64 hex digits)`);
    if (m.ca !== null && (typeof m.ca !== 'string' || !isAbsolute(m.ca))) problems.push(`${prefix}.ca must be an absolute path`);
  }
  return problems;
}

/** Written by `servermin-agent register` into the agent state directory (ADR-004). */
export const REGISTRATION_FILE = 'manager.json';

export interface RegisteredManager extends ManagerSettings {
  registeredAt: string;
  registrationId: string;
}

/**
 * The Manager this agent registered with, from `<stateDir>/manager.json`. Returns null when there
 * is none, and the problem when the file exists but cannot be used (the agent then stays standalone
 * and says why).
 */
export function readRegisteredManager(stateDir: string): { manager: RegisteredManager | null; problem?: string } {
  const file = join(stateDir, REGISTRATION_FILE);
  if (!existsSync(file)) return { manager: null };
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { manager: null, problem: `${file} is not valid JSON: ${(e as Error).message}` };
  }
  const m: RegisteredManager = {
    url: typeof raw?.url === 'string' ? raw.url : null,
    fingerprint: typeof raw?.fingerprint === 'string' ? raw.fingerprint : null,
    ca: typeof raw?.ca === 'string' ? raw.ca : null,
    insecure: raw?.insecure === true,
    registeredAt: String(raw?.registeredAt ?? ''),
    registrationId: String(raw?.registrationId ?? ''),
  };
  if (!m.url) return { manager: null, problem: `${file} names no Manager url` };
  const problems = validateManagerSettings(m, REGISTRATION_FILE);
  return problems.length ? { manager: null, problem: problems.join('; ') } : { manager: m };
}

export function validateConfig(config: CoreConfig): CoreConfig {
  const problems: string[] = [];
  if (!Number.isInteger(config.http.port) || config.http.port < 0 || config.http.port > 65535) problems.push('http.port must be 0-65535');
  for (const [k, v] of Object.entries(config.paths)) if (!isAbsolute(v)) problems.push(`paths.${k} must be absolute`);
  if (!['sudo', 'simulate', 'disabled'].includes(config.privileged.mode)) problems.push('privileged.mode must be sudo, simulate or disabled');
  if (!['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(config.logging.level)) problems.push('logging.level is invalid');
  if (config.agent.stateDir !== null && (typeof config.agent.stateDir !== 'string' || !isAbsolute(config.agent.stateDir))) problems.push('agent.stateDir must be an absolute path or null');
  problems.push(...validateManagerSettings(config.agent.manager, 'agent.manager'));
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.updates.repository)) problems.push('updates.repository must be owner/name');
  if (!/^https?:\/\//.test(config.updates.apiBase)) problems.push('updates.apiBase must be an http(s) URL');
  if (!(config.updates.checkIntervalHours >= 1)) problems.push('updates.checkIntervalHours must be at least 1');
  if (problems.length) throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  return config;
}
