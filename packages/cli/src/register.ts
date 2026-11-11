/**
 * `servermin-agent register CODE --manager URL [--fingerprint SHA256 | --ca FILE | --insecure] [--name NAME]`
 * `servermin-agent leave`
 *
 * Registration (ADR-004): runs as root on the server, reads the agent's identity and public key
 * from its state directory (never the private key), presents them to the Manager with a one-time
 * code, and on success writes `<stateDir>/manager.json`. The running agent notices the file and
 * connects by itself; nothing is restarted.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync, chownSync, chmodSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { CliError } from './agent';

export const REGISTRATION_FILE = 'manager.json';

export interface AgentPaths {
  configFile: string;
  config: any;
  stateDir: string;
  appDir: string;
}

/** Where the agent keeps its state, from the same configuration the service reads. */
export function agentPaths(env: NodeJS.ProcessEnv = process.env): AgentPaths {
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
  return { configFile, config, stateDir: config.agent?.stateDir ?? join(dataDir, 'agent'), appDir: env.SERVERMIN_APP ?? config.paths?.app ?? '/opt/servermin' };
}

/** The registration the agent uses, if any (what `manager.json` says). */
export function readRegistration(stateDir: string): { url: string; fingerprint: string | null; ca: string | null; insecure: boolean; registrationId?: string; registeredAt?: string } | null {
  try {
    const r = JSON.parse(readFileSync(join(stateDir, REGISTRATION_FILE), 'utf8'));
    return typeof r?.url === 'string' ? r : null;
  } catch {
    return null;
  }
}

const normalizeFp = (v: string) => v.replace(/^sha-?256[:=]/i, '').replace(/[:\s]/g, '').toLowerCase();

interface Options {
  code: string;
  manager: string;
  fingerprint: string | null;
  ca: string | null;
  insecure: boolean;
  name: string | null;
  json: boolean;
}

function parse(args: string[]): Options {
  const o: Options = { code: '', manager: '', fingerprint: null, ca: null, insecure: false, name: null, json: false };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = () => {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) throw new CliError(`${a} needs a value`);
      return v;
    };
    if (a === '--manager') o.manager = value();
    else if (a === '--fingerprint') o.fingerprint = value();
    else if (a === '--ca') o.ca = value();
    else if (a === '--name') o.name = value();
    else if (a === '--insecure') o.insecure = true;
    else if (a === '--json') o.json = true;
    else if (a.startsWith('--')) throw new CliError(`Unknown option ${a}`);
    else rest.push(a);
  }
  if (rest.length !== 1) throw new CliError('Usage: sudo servermin-agent register CODE --manager https://manager:8480 --fingerprint SHA256\n(The Manager prints the whole command when you create the code.)');
  o.code = rest[0];
  if (!o.manager) throw new CliError('--manager is required: the address of the Servermin Manager, e.g. https://manager:8480');
  if (o.fingerprint !== null) {
    const fp = normalizeFp(o.fingerprint);
    if (!/^[0-9a-f]{64}$/.test(fp)) throw new CliError('--fingerprint must be the SHA-256 fingerprint of the Manager certificate (64 hex digits)');
    o.fingerprint = fp;
  }
  if (o.fingerprint && o.ca) throw new CliError('Use either --fingerprint or --ca, not both');
  if (o.ca && !o.ca.startsWith('/')) throw new CliError('--ca must be an absolute path');
  return o;
}

function managerUrl(o: Options): URL {
  let u: URL;
  try {
    u = new URL(o.manager.includes('://') ? o.manager : `https://${o.manager}`);
  } catch {
    throw new CliError(`${o.manager} is not a URL`);
  }
  if (u.protocol === 'wss:') u.protocol = 'https:';
  if (u.protocol === 'ws:') u.protocol = 'http:';
  if (!['https:', 'http:'].includes(u.protocol)) throw new CliError('--manager must be an https:// URL');
  if (u.username || u.password) throw new CliError('--manager must not contain credentials');
  if (u.protocol === 'http:' && !o.insecure) throw new CliError('The Manager address is not encrypted. Use https://, or add --insecure on a network you fully trust.');
  return new URL(u.origin);
}

/** The certificate fingerprint a TLS server presents, without trusting it. For a helpful error. */
function peekFingerprint(u: URL): Promise<string | null> {
  return new Promise((resolve) => {
    const s = tlsConnect({ host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port || 443), servername: /^[\d.:[\]]+$/.test(u.hostname) ? undefined : u.hostname, rejectUnauthorized: false, timeout: 10_000 }, () => {
      const fp = s.getPeerCertificate()?.fingerprint256;
      s.destroy();
      resolve(fp ? normalizeFp(fp) : null);
    });
    s.on('error', () => resolve(null));
    s.on('timeout', () => (s.destroy(), resolve(null)));
  });
}

/**
 * POSTs JSON. With a pinned fingerprint the body is written only after the certificate was
 * checked, so a code never reaches anyone but that Manager.
 */
function post(u: URL, path: string, payload: unknown, o: Options): Promise<{ status: number; body: any; fingerprint: string | null }> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const https = u.protocol === 'https:';
    let seen: string | null = null;
    const req = (https ? httpsRequest : httpRequest)(
      new URL(path, u),
      {
        method: 'POST',
        agent: false,
        timeout: 20_000,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-servermin-request': '1', 'user-agent': 'servermin-agent-register' },
        ...(https ? { rejectUnauthorized: !o.fingerprint, ...(o.ca ? { ca: readFileSync(o.ca) } : {}) } : {}),
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (text += d));
        res.on('end', () => {
          let parsed: any = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = { error: text.slice(0, 200) };
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, fingerprint: seen });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('the Manager did not answer in time')));
    req.on('error', reject);
    if (!https) return void req.end(body);
    req.on('socket', (socket) => {
      (socket as TLSSocket).once('secureConnect', () => {
        const fp = (socket as TLSSocket).getPeerCertificate()?.fingerprint256;
        seen = fp ? normalizeFp(fp) : null;
        if (o.fingerprint && seen !== o.fingerprint) {
          return req.destroy(new CliError(`The Manager presented certificate ${seen ?? '(none)'}, not ${o.fingerprint}. Nothing was sent. Check the address and the fingerprint.`));
        }
        req.end(body);
      });
    });
  });
}

/** Writes `manager.json` atomically, owned like the state directory (the agent's account), 0600. */
function writeRegistration(stateDir: string, data: unknown) {
  const file = join(stateDir, REGISTRATION_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  const owner = statSync(stateDir);
  if (process.getuid?.() === 0) chownSync(tmp, owner.uid, owner.gid);
  renameSync(tmp, file);
}

export async function register(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const o = parse(args);
  const u = managerUrl(o);
  const paths = agentPaths(env);
  if (paths.config.agent?.manager?.url)
    throw new CliError(`${paths.configFile} already names a Manager (agent.manager.url = ${paths.config.agent.manager.url}), and it takes precedence over a registration. Remove agent.manager from it first.`);
  let identity: any;
  let publicKey: string;
  try {
    identity = JSON.parse(readFileSync(join(paths.stateDir, 'identity.json'), 'utf8'));
    publicKey = readFileSync(join(paths.stateDir, 'agent-key.pub'), 'utf8').trim();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EACCES') throw new CliError(`${paths.stateDir} is not readable by this user. Run it with sudo.`);
    if (code === 'ENOENT') throw new CliError(`No agent identity or key in ${paths.stateDir}: start the agent once (systemctl start server-control) and try again.`);
    throw new CliError(`Cannot read the agent identity: ${(e as Error).message}`);
  }
  const versionFile = join(paths.appDir, 'VERSION');
  const agentVersion = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : undefined;
  const payload = { code: o.code, agentId: identity.agentId, serverId: identity.serverId, publicKey, hostname: hostname(), ...(o.name ? { name: o.name } : {}), ...(agentVersion ? { agentVersion } : {}) };

  let res: Awaited<ReturnType<typeof post>>;
  try {
    res = await post(u, '/api/v1/registrations', payload, o);
  } catch (e) {
    if (e instanceof CliError) throw e;
    const err = e as NodeJS.ErrnoException;
    if (['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED'].includes(String(err.code))) {
      const fp = await peekFingerprint(u);
      throw new CliError(
        `The Manager's certificate is not trusted (${err.code}). Nothing was sent.\n` +
          (fp ? `It presented the certificate SHA-256 ${fp}.\nIf that is the fingerprint the Manager shows, run the command again with --fingerprint ${fp}` : 'Pass --fingerprint with the fingerprint the Manager shows when you create the code.'),
      );
    }
    throw new CliError(`Cannot reach the Manager at ${u.origin}: ${err.message}`);
  }
  if (res.status !== 200) throw new CliError(`The Manager refused the registration: ${res.body?.error ?? `HTTP ${res.status}`}`);
  const r = res.body as { registrationId: string; status: string; serverId: string | null; fingerprint: string | null };
  // The Manager says which certificate it has; behind something that re-encrypts, these differ.
  if (res.fingerprint && r.fingerprint && res.fingerprint !== r.fingerprint)
    throw new CliError(`The Manager reports certificate ${r.fingerprint} but the connection presented ${res.fingerprint}. Something between this server and the Manager terminates TLS; the agent would not be able to authenticate.`);

  writeRegistration(paths.stateDir, { url: u.origin, fingerprint: o.fingerprint, ca: o.ca, insecure: o.insecure, registrationId: r.registrationId, registeredAt: new Date().toISOString() });
  if (o.json) return JSON.stringify({ ...r, manager: u.origin, file: join(paths.stateDir, REGISTRATION_FILE) }, null, 2) + '\n';
  const lines = [`Registered with the Servermin Manager at ${u.origin} (registration ${r.registrationId}).`];
  if (r.status === 'APPROVED') lines.push(`Approved: this server is ${r.serverId} in the Manager. The agent connects within a few seconds.`);
  else lines.push('Waiting for approval: an administrator approves it in the Manager. The agent keeps trying and connects within 30 seconds of the approval.');
  lines.push('', 'Check the connection with:  sudo servermin-agent status');
  return lines.join('\n') + '\n';
}

/** Forgets the registration: the agent disconnects and runs standalone. The Manager keeps the server until someone removes it. */
export function leave(env: NodeJS.ProcessEnv = process.env): string {
  const paths = agentPaths(env);
  const file = join(paths.stateDir, REGISTRATION_FILE);
  const current = readRegistration(paths.stateDir);
  if (!existsSync(file)) {
    if (paths.config.agent?.manager?.url) throw new CliError(`This agent is connected through ${paths.configFile} (agent.manager), not a registration. Remove agent.manager there and restart the service.`);
    return 'This agent is not registered with a Manager.\n';
  }
  unlinkSync(file);
  return `This agent has left the Manager${current ? ` at ${current.url}` : ''} and runs standalone. The Manager still lists the server; remove it or revoke its agent there.\n`;
}
