import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { mergeConfig, type CoreConfig } from '@servermin/core';

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

/** Manager configuration. Loaded from a JSON file, then environment overrides. */
export interface ManagerConfig {
  /**
   * `tls` names your own certificate and key. Without it the Manager uses a self-signed
   * certificate it creates in `<paths.data>/tls` (`selfSigned`, the default) or, with
   * `selfSigned: false`, plain HTTP, which sends passwords and agent traffic in clear text.
   */
  http: CoreConfig['http'] & { selfSigned: boolean };
  paths: {
    /** Persistent state: `manager.db` and the setup token. */
    data: string;
  };
  logging: { level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'; stdout: boolean };
  auth: CoreConfig['auth'];
  /** The agent endpoint (ADR-002). */
  agents: {
    /** How often agents send a heartbeat; told to every agent when it connects. */
    heartbeatIntervalMs: number;
    /** Silence after which a connected server is STALE. */
    staleAfterMs: number;
    /** Silence after which the connection is closed and the server is OFFLINE. Agents use the same value. */
    timeoutMs: number;
    /** Time a new connection has to authenticate. */
    authTimeoutMs: number;
    /** How long an existing connection may take to answer a ping when a second one claims the same agent id. */
    duplicateProbeMs: number;
    /**
     * Refuse agents that saw a different TLS key than the Manager's own. Turn off only behind a
     * reverse proxy that terminates TLS, and then pin the proxy's key on the agents.
     */
    requireKeyBinding: boolean;
  };
  dev: boolean;
}

export const MANAGER_CONFIG_FILE = '/etc/servermin-manager/config.json';
/** Not 80/443: a Manager often shares a host with an agent, which listens on 80 by default. */
export const MANAGER_DEFAULT_PORT = 8480;

export function defaultManagerConfig(base = '/'): ManagerConfig {
  return {
    http: { host: '0.0.0.0', port: MANAGER_DEFAULT_PORT, trustProxy: false, selfSigned: true },
    paths: { data: join(base, 'var/lib/servermin-manager') },
    logging: { level: 'INFO', stdout: true },
    auth: { sessionHours: 12, secureCookies: 'auto', loginAttempts: 5, lockoutMinutes: 15 },
    agents: { heartbeatIntervalMs: 15_000, staleAfterMs: 35_000, timeoutMs: 60_000, authTimeoutMs: 10_000, duplicateProbeMs: 5_000, requireKeyBinding: true },
    dev: false,
  };
}

export function validateManagerConfig(config: ManagerConfig): ManagerConfig {
  const problems: string[] = [];
  if (!Number.isInteger(config.http.port) || config.http.port < 0 || config.http.port > 65535) problems.push('http.port must be 0-65535');
  if (typeof config.http.host !== 'string' || !config.http.host) problems.push('http.host is required');
  if (config.http.tls && (typeof config.http.tls.cert !== 'string' || typeof config.http.tls.key !== 'string' || !isAbsolute(config.http.tls.cert) || !isAbsolute(config.http.tls.key)))
    problems.push('http.tls needs absolute cert and key paths');
  if (typeof config.paths.data !== 'string' || !isAbsolute(config.paths.data)) problems.push('paths.data must be absolute');
  if (!['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(config.logging.level)) problems.push('logging.level is invalid');
  if (typeof config.http.selfSigned !== 'boolean') problems.push('http.selfSigned must be true or false');
  for (const k of ['sessionHours', 'loginAttempts', 'lockoutMinutes'] as const) if (!(Number(config.auth[k]) >= 1)) problems.push(`auth.${k} must be at least 1`);
  const a = config.agents;
  for (const k of ['heartbeatIntervalMs', 'staleAfterMs', 'timeoutMs', 'authTimeoutMs', 'duplicateProbeMs'] as const) if (!Number.isInteger(a[k]) || a[k] < 50 || a[k] > 3_600_000) problems.push(`agents.${k} must be an integer from 50 to 3600000`);
  if (!(a.staleAfterMs > a.heartbeatIntervalMs)) problems.push('agents.staleAfterMs must be longer than agents.heartbeatIntervalMs');
  if (!(a.timeoutMs > a.staleAfterMs)) problems.push('agents.timeoutMs must be longer than agents.staleAfterMs');
  if (typeof a.requireKeyBinding !== 'boolean') problems.push('agents.requireKeyBinding must be true or false');
  if (problems.length) throw new Error(`Invalid Manager configuration:\n  ${problems.join('\n  ')}`);
  return config;
}

/** Loads `/etc/servermin-manager/config.json` (or `$SERVERMIN_MANAGER_CONFIG`) and applies environment overrides. */
export function loadManagerConfig(env: NodeJS.ProcessEnv = process.env): ManagerConfig {
  let config = defaultManagerConfig();
  const file = env.SERVERMIN_MANAGER_CONFIG ?? MANAGER_CONFIG_FILE;
  if (existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} must contain a JSON object`);
    config = mergeConfig(config, parsed as DeepPartial<ManagerConfig>);
  }
  if (env.SERVERMIN_MANAGER_DATA_DIR) config.paths.data = resolve(env.SERVERMIN_MANAGER_DATA_DIR);
  if (env.SERVERMIN_MANAGER_HOST) config.http.host = env.SERVERMIN_MANAGER_HOST;
  if (env.SERVERMIN_MANAGER_PORT) config.http.port = Number(env.SERVERMIN_MANAGER_PORT);
  if (env.SERVERMIN_MANAGER_TLS === 'off') config.http.selfSigned = false;
  else if (env.SERVERMIN_MANAGER_TLS === 'self-signed') config.http.selfSigned = true;
  else if (env.SERVERMIN_MANAGER_TLS !== undefined) throw new Error('Invalid Manager configuration:\n  SERVERMIN_MANAGER_TLS must be "off" or "self-signed"');
  if (env.SERVERMIN_MANAGER_LOG_LEVEL) config.logging.level = env.SERVERMIN_MANAGER_LOG_LEVEL as ManagerConfig['logging']['level'];
  return validateManagerConfig(config);
}
