import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { mergeConfig, type CoreConfig } from '@servermin/core';

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

/** Manager configuration. Loaded from a JSON file, then environment overrides. */
export interface ManagerConfig {
  http: CoreConfig['http'];
  paths: {
    /** Persistent state: `manager.db` and the setup token. */
    data: string;
  };
  logging: { level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'; stdout: boolean };
  auth: CoreConfig['auth'];
  /** Agent connections. */
  agents: {
    /** How often agents send a heartbeat. */
    heartbeatSeconds: number;
    /** Silence after which an agent's connection is closed and its server is OFFLINE. At least twice the heartbeat. */
    timeoutSeconds: number;
    /** How long a new connection has to authenticate. */
    handshakeSeconds: number;
    /**
     * When a second connection authenticates as an agent that is already connected, how long the
     * existing connection has to answer a ping. If it answers, the newcomer is refused (two
     * installations share one identity); if not, it was a dead connection and is replaced.
     */
    duplicateProbeSeconds: number;
  };
  dev: boolean;
}

export const MANAGER_CONFIG_FILE = '/etc/servermin-manager/config.json';
/** Not 80/443: a Manager often shares a host with an agent, which listens on 80 by default. */
export const MANAGER_DEFAULT_PORT = 8480;

export function defaultManagerConfig(base = '/'): ManagerConfig {
  return {
    http: { host: '0.0.0.0', port: MANAGER_DEFAULT_PORT, trustProxy: false },
    paths: { data: join(base, 'var/lib/servermin-manager') },
    logging: { level: 'INFO', stdout: true },
    auth: { sessionHours: 12, secureCookies: 'auto', loginAttempts: 5, lockoutMinutes: 15 },
    agents: { heartbeatSeconds: 15, timeoutSeconds: 60, handshakeSeconds: 10, duplicateProbeSeconds: 5 },
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
  for (const k of ['sessionHours', 'loginAttempts', 'lockoutMinutes'] as const) if (!(Number(config.auth[k]) >= 1)) problems.push(`auth.${k} must be at least 1`);
  if (!(Number(config.agents.heartbeatSeconds) >= 0.1 && Number(config.agents.heartbeatSeconds) <= 3600)) problems.push('agents.heartbeatSeconds must be between 0.1 and 3600');
  else if (!(Number(config.agents.timeoutSeconds) >= 2 * config.agents.heartbeatSeconds && Number(config.agents.timeoutSeconds) <= 86400)) problems.push('agents.timeoutSeconds must be at least twice agents.heartbeatSeconds');
  if (!(Number(config.agents.handshakeSeconds) >= 0.1 && Number(config.agents.handshakeSeconds) <= 120)) problems.push('agents.handshakeSeconds must be between 0.1 and 120');
  if (!(Number(config.agents.duplicateProbeSeconds) >= 0.05 && Number(config.agents.duplicateProbeSeconds) <= 60)) problems.push('agents.duplicateProbeSeconds must be between 0.05 and 60');
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
  if (env.SERVERMIN_MANAGER_LOG_LEVEL) config.logging.level = env.SERVERMIN_MANAGER_LOG_LEVEL as ManagerConfig['logging']['level'];
  return validateManagerConfig(config);
}
