/**
 * servermin-agent — inspects the Servermin agent on this server.
 *
 *   servermin-agent status [--json]    identity, version, state and capabilities
 *   servermin-agent id                 print the server id and the agent id
 *
 * With API credentials (`serverctl login`, or SERVERCTL_URL and SERVERCTL_TOKEN) the running agent
 * answers. Without them, run it with sudo: the identity is read from the agent's state directory
 * and the service state from systemd, which is enough to identify the server but cannot list
 * capabilities, because only the running agent knows which modules are active.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

const USAGE = `servermin-agent — inspects the Servermin agent on this server.

  servermin-agent status [--json]    identity, version, state and capabilities
  servermin-agent id                 print the server id and the agent id

With API credentials (serverctl login) the running agent answers. Without them, run it with sudo
to read the identity from disk.\n`;

/** The unit's file name; `servermin-agent.service` is an alias of it. */
export const UNIT = 'server-control.service';

export interface LocalStatus {
  source: 'api' | 'disk';
  serverId: string;
  agentId: string;
  hostname: string;
  version: string | null;
  /** From the running agent (`RUNNING`), or from systemd (`active`, `inactive`, …) when read from disk. */
  state: string;
  name?: string;
  os?: string;
  health?: string;
  capabilities?: string[];
  machineId?: string | null;
  /** The Manager connection, from the running agent. */
  manager?: { state: string; url: string | null; lastError: string | null; connectedSince: string | null };
}

export class CliError extends Error {}

function credentials(env: NodeJS.ProcessEnv): { url: string; token: string } | null {
  if (env.SERVERCTL_URL && env.SERVERCTL_TOKEN) return { url: env.SERVERCTL_URL, token: env.SERVERCTL_TOKEN };
  const file = env.SERVERCTL_CONFIG ?? join(homedir(), '.config', 'serverctl.json');
  if (!existsSync(file)) return null;
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    return typeof c.url === 'string' && typeof c.token === 'string' ? c : null;
  } catch {
    return null;
  }
}

async function fromApi(creds: { url: string; token: string }): Promise<LocalStatus> {
  let res: Response;
  try {
    res = await fetch(new URL('/api/v1/agent', creds.url), { headers: { authorization: `Bearer ${creds.token}` }, signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new CliError(`The agent at ${creds.url} did not answer (${(e as Error).message}). Is ${UNIT} running?`);
  }
  if (res.status === 401) throw new CliError('The stored API token was rejected. Run `serverctl login` again.');
  if (res.status === 404) throw new CliError(`The server at ${creds.url} is older than the agent command and has no /api/v1/agent.`);
  if (!res.ok) throw new CliError(`The agent answered ${res.status}.`);
  const r = (await res.json()) as any;
  return { source: 'api', serverId: r.serverId, agentId: r.agentId, hostname: r.hostname, version: r.version, state: r.state, name: r.name, os: r.os?.name, health: r.health, capabilities: r.capabilities, machineId: r.machineId, manager: r.manager };
}

/** Reads the identity straight from the state directory. Needs read access to it (root or the service account). */
export function fromDisk(env: NodeJS.ProcessEnv = process.env): LocalStatus {
  const configFile = env.SERVERMIN_CONFIG ?? '/etc/servermin/config.json';
  let config: any = {};
  if (existsSync(configFile)) {
    try {
      config = JSON.parse(readFileSync(configFile, 'utf8'));
    } catch (e) {
      throw new CliError(`${configFile} cannot be read: ${(e as Error).message}`);
    }
  }
  const dataDir = env.SERVERMIN_DATA_DIR ?? config.paths?.data ?? '/var/lib/servermin';
  const stateDir = config.agent?.stateDir ?? join(dataDir, 'agent');
  const file = join(stateDir, 'identity.json');
  let identity: any;
  try {
    identity = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new CliError(`No agent identity at ${file}: the agent has not started on this server yet.`);
    if (code === 'EACCES') throw new CliError(`${file} is not readable by this user. Use sudo, or sign in with \`serverctl login\`.`);
    throw new CliError(`${file} cannot be read: ${(e as Error).message}`);
  }
  if (typeof identity?.serverId !== 'string' || typeof identity?.agentId !== 'string') throw new CliError(`${file} does not contain an agent identity.`);
  const appDir = env.SERVERMIN_APP ?? config.paths?.app ?? '/opt/servermin';
  const versionFile = join(appDir, 'VERSION');
  const version = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : null;
  const active = spawnSync(env.SERVERMIN_SYSTEMCTL ?? 'systemctl', ['is-active', UNIT], { encoding: 'utf8' });
  const state = active.error ? 'unknown' : active.stdout.trim() || 'unknown';
  return { source: 'disk', serverId: identity.serverId, agentId: identity.agentId, hostname: hostname(), version, state };
}

function managerLine(m: NonNullable<LocalStatus['manager']>): string {
  if (m.state === 'DISABLED') return m.lastError ? `none (${m.lastError})` : 'none configured';
  if (m.state === 'CONNECTED') return `connected to ${m.url} since ${m.connectedSince}`;
  return `${m.state.toLowerCase()} (${m.url})${m.lastError ? ` — ${m.lastError}` : ''}`;
}

export function format(s: LocalStatus): string {
  const rows: [string, string][] = [
    ['Server ID', s.serverId],
    ['Agent ID', s.agentId],
    ...(s.name && s.name !== s.hostname ? ([['Name', s.name]] as [string, string][]) : []),
    ['Hostname', s.hostname],
    ...(s.os ? ([['OS', s.os]] as [string, string][]) : []),
    ['Version', s.version ?? 'unknown'],
    ['State', s.health ? `${s.state} (health ${s.health})` : s.state],
    ['Capabilities', s.capabilities ? s.capabilities.join(', ') || 'none' : 'not available without API credentials (serverctl login)'],
    ...(s.manager ? ([['Manager', managerLine(s.manager)]] as [string, string][]) : []),
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join('\n') + '\n';
}

export async function status(env: NodeJS.ProcessEnv = process.env): Promise<LocalStatus> {
  const creds = credentials(env);
  return creds ? fromApi(creds) : fromDisk(env);
}

export async function run(args: string[]) {
  const [cmd] = args;
  if (!cmd || cmd === 'help' || cmd === '--help') return void process.stdout.write(USAGE);
  if (cmd === 'status') {
    const s = await status();
    return void process.stdout.write(args.includes('--json') ? JSON.stringify(s, null, 2) + '\n' : format(s));
  }
  if (cmd === 'id') {
    const s = await status();
    return void process.stdout.write(`${s.serverId}\n${s.agentId}\n`);
  }
  throw new CliError(`Unknown command "${cmd}". Try servermin-agent help.`);
}
