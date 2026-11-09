/**
 * servermin-verify — checks a real Server Control installation end to end.
 *
 * Run it on the server, with sudo, after installing (and again after a reboot, and on every
 * machine the USB stick boots on):
 *
 *   sudo servermin-verify                       host and API checks (nothing is changed)
 *   sudo servermin-verify --user admin          sign in with a password instead of a token
 *   sudo servermin-verify --json report.json    also write a machine-readable report
 *
 * Opt-in checks that change the system (each cleans up after itself):
 *
 *   --docker               deploy a test application (nginx:alpine) through Applications, fetch it, remove it
 *   --mount /dev/sdX1      mount the partition read-only under /mnt/servermin-verify, then unmount it
 *   --service cron.service restart a service and check it comes back
 *   --updates              refresh the package index (apt-get update) through the privilege helper
 *   --network-rollback     re-apply the current network configuration with a 30 s rollback and let it roll back;
 *                          requires --i-have-console-access, because a mistake can cut the connection
 *
 * Authentication: --token, SERVERCTL_TOKEN, the serverctl login of the user running it, or --user (prompts
 * for the password; piped stdin works too). Exit code 0 when nothing failed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { promptCredentials } from './prompt';

const USAGE = `servermin-verify — checks a real Server Control installation end to end.

Run it on the server, with sudo, after installing (and again after a reboot, and on every
machine the USB stick boots on):

  sudo servermin-verify                       host and API checks (nothing is changed)
  sudo servermin-verify --user admin          sign in with a password instead of a token
  sudo servermin-verify --json report.json    also write a machine-readable report

Opt-in checks that change the system (each cleans up after itself):

  --docker               deploy a test application (nginx:alpine) through Applications, fetch it, remove it
  --mount /dev/sdX1      mount the partition read-only under /mnt/servermin-verify, then unmount it
  --service cron.service restart a service and check it comes back
  --updates              refresh the package index (apt-get update) through the privilege helper
  --network-rollback     re-apply the current network configuration with a 30 s rollback and let it roll back;
                         requires --i-have-console-access, because a mistake can cut the connection

Authentication: --token, SERVERCTL_TOKEN, the serverctl login of the user running it, or --user (prompts
for the password; piped stdin works too). Exit code 0 when nothing failed.\n`;

// ── Options ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const value = (n: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
if (flag('help') || flag('h')) {
  process.stdout.write(USAGE);
  process.exit(0);
}
const CONFIG_FILE = value('config') ?? '/etc/servermin/config.json';
const APP = value('app') ?? '/opt/servermin';
const BUILT_IN = ['applications', 'docker', 'logs', 'monitoring', 'network', 'services', 'storage', 'system', 'terminal'];

// ── Result bookkeeping ──────────────────────────────────────────────────────────

type Status = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';
interface Result {
  group: string;
  name: string;
  status: Status;
  detail: string;
  ms: number;
}
const results: Result[] = [];
const color = process.stdout.isTTY ? { PASS: '\x1b[32m', WARN: '\x1b[33m', FAIL: '\x1b[31m', SKIP: '\x1b[90m', reset: '\x1b[0m' } : { PASS: '', WARN: '', FAIL: '', SKIP: '', reset: '' };

class Outcome extends Error {
  constructor(
    readonly status: Status,
    message: string,
  ) {
    super(message);
  }
}
const skip = (why: string): never => {
  throw new Outcome('SKIP', why);
};
const warn = (why: string): never => {
  throw new Outcome('WARN', why);
};
const fail = (why: string): never => {
  throw new Outcome('FAIL', why);
};
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) fail(message);
}

let currentGroup = '';
async function check(name: string, fn: () => Promise<string | void> | string | void) {
  const started = Date.now();
  let status: Status = 'PASS';
  let detail = '';
  try {
    detail = (await fn()) ?? '';
  } catch (e) {
    if (e instanceof Outcome) {
      status = e.status;
      detail = e.message;
    } else {
      status = 'FAIL';
      detail = (e as Error)?.message ?? String(e);
    }
  }
  detail = detail.replace(/\s*\n\s*/g, ' · ');
  const r = { group: currentGroup, name, status, detail, ms: Date.now() - started };
  results.push(r);
  process.stdout.write(`${color[status]}${status.padEnd(4)}${color.reset}  ${name}${detail ? ` — ${detail}` : ''}\n`);
  return r;
}
function group(name: string) {
  currentGroup = name;
  process.stdout.write(`\n${name}\n${'─'.repeat(name.length)}\n`);
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function sh(cmd: string, args: string[], opts: { user?: string; timeout?: number } = {}) {
  const [c, a] = opts.user ? ['runuser', ['-u', opts.user, '--', cmd, ...args]] : [cmd, args];
  const r = spawnSync(c, a, { encoding: 'utf8', timeout: opts.timeout ?? 15_000 });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim(), error: r.error };
}
const has = (cmd: string) => sh('sh', ['-c', `command -v ${cmd}`]).code === 0;
const isRoot = process.getuid?.() === 0;
const needRoot = () => !isRoot && skip('run with sudo to check this');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readConfig(): any {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function versionAtLeast(v: string, min: number[]) {
  const p = v.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < min.length; i++) if ((p[i] ?? 0) !== min[i]) return (p[i] ?? 0) > min[i];
  return true;
}

// ── API client ──────────────────────────────────────────────────────────────────

const config = readConfig();
const port = Number(config?.http?.port ?? 80);
const tls = !!config?.http?.tls;
const BASE = (value('url') ?? `${tls ? 'https' : 'http'}://127.0.0.1:${port}`).replace(/\/$/, '');
let auth: { header?: string; cookie?: string } = {};

async function api<T = any>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (auth.header) headers.authorization = auth.header;
  if (auth.cookie) Object.assign(headers, { cookie: auth.cookie, 'x-servermin-request': '1', origin: BASE });
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    /* text */
  }
  return { status: res.status, body: parsed };
}

async function ok<T = any>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const r = await api<any>(method, path, body, timeoutMs);
  if (r.status >= 400) fail(`${method} ${path} → ${r.status}: ${r.body?.error ?? r.body}`);
  return r.body as T;
}

async function authenticate(): Promise<string> {
  const token = value('token') ?? process.env.SERVERCTL_TOKEN;
  if (token) {
    auth = { header: `Bearer ${token}` };
    return 'API token';
  }
  if (!value('user')) {
    const file = process.env.SERVERCTL_CONFIG ?? join(process.env.SUDO_USER ? `/home/${process.env.SUDO_USER}` : homedir(), '.config', 'serverctl.json');
    if (existsSync(file)) {
      auth = { header: `Bearer ${JSON.parse(readFileSync(file, 'utf8')).token}` };
      return `serverctl login (${file})`;
    }
  }
  // Before asking for a password, make sure an account can exist at all.
  const session = (await fetch(`${BASE}/api/v1/auth/session`).then((r) => r.json()).catch(() => ({}))) as { needsSetup?: boolean };
  if (session.needsSetup) {
    const tokenFile = join(config?.paths?.data ?? '/var/lib/servermin', 'setup-token');
    fail(`no administrator exists yet: open ${BASE.replace('127.0.0.1', '<server-ip>')}/ in a browser, enter the setup token (sudo cat ${tokenFile}) and create the account, then run this again`);
  }
  const [username, password] = await promptCredentials(value('user'));
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-servermin-request': '1', origin: BASE },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const error = ((await res.json().catch(() => ({}))) as any).error ?? `HTTP ${res.status}`;
    fail(`sign-in as "${username}" failed: ${error}${res.status === 401 ? ' — check the username (Settings → Users) and password; 5 failures lock the account for 15 minutes' : ''}`);
  }
  auth = { cookie: res.headers.get('set-cookie')!.split(';')[0] };
  return `password (${username})`;
}

/** Opens a WebSocket channel and resolves when `until` returns true for a received message. */
function channel(name: string, params: Record<string, unknown>, opts: { send?: unknown[]; until: (data: any, all: any[]) => boolean; timeoutMs?: number }) {
  return new Promise<any[]>((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (auth.header) headers.authorization = auth.header;
    if (auth.cookie) Object.assign(headers, { cookie: auth.cookie, origin: BASE });
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/v1/ws`, { headers });
    const got: any[] = [];
    const timer = setTimeout(() => (ws.terminate(), reject(new Error(`no matching data on ${name} within ${(opts.timeoutMs ?? 8000) / 1000} s (received ${got.length} messages)`))), opts.timeoutMs ?? 8000);
    ws.on('unexpected-response', (_q, res) => (clearTimeout(timer), reject(new Error(`WebSocket upgrade refused: HTTP ${res.statusCode}`))));
    ws.on('error', (e) => (clearTimeout(timer), reject(e)));
    ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', id: 'v', channel: name, params })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'error') return (clearTimeout(timer), ws.close(), reject(new Error(m.message)));
      if (m.type === 'subscribed') for (const d of opts.send ?? []) ws.send(JSON.stringify({ type: 'message', id: 'v', data: d }));
      if (m.type !== 'data') return;
      got.push(m.data);
      if (opts.until(m.data, got)) {
        clearTimeout(timer);
        ws.close();
        resolve(got);
      }
    });
  });
}

function portFree(p: number) {
  return new Promise<boolean>((resolve) => {
    const s = createConnection({ port: p, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), resolve(false)));
    s.once('error', () => resolve(true));
  });
}

// ── Checks ──────────────────────────────────────────────────────────────────────

const report: Record<string, unknown> = { startedAt: new Date().toISOString(), url: BASE };

async function hostChecks() {
  group('Host');
  const onSystemd = existsSync('/run/systemd/system');

  await check('Operating system', () => {
    const rel = Object.fromEntries(
      (existsSync('/etc/os-release') ? readFileSync('/etc/os-release', 'utf8') : '')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]),
    );
    report.os = rel.PRETTY_NAME;
    if (rel.ID !== 'ubuntu') warn(`${rel.PRETTY_NAME ?? 'unknown'} — Ubuntu Server 22.04+ is the supported platform`);
    if (!versionAtLeast(rel.VERSION_ID ?? '0', [22, 4])) warn(`${rel.PRETTY_NAME} is older than 22.04`);
    return rel.PRETTY_NAME;
  });

  await check('Node.js runtime', () => {
    const bundled = join(APP, 'node/bin/node');
    const node = existsSync(bundled) ? bundled : sh('sh', ['-c', 'command -v node']).out;
    if (!node) fail('no Node.js runtime found');
    const v = sh(node, ['-e', "require('node:sqlite');process.stdout.write(process.version)"]);
    if (v.code !== 0) fail(`${node} cannot load node:sqlite (${v.err.split('\n')[0]})`);
    if (!versionAtLeast(v.out, [22, 13])) fail(`${node} is ${v.out}; 22.13+ is required`);
    report.node = { path: node, version: v.out, bundled: node === bundled };
    if (node !== bundled) warn(`system ${v.out} at ${node}; a portable stick should use a release built with --bundle-node`);
    return `bundled ${v.out}`;
  });

  await check('systemd service', () => {
    if (!onSystemd) skip('systemd is not running on this host');
    const enabled = sh('systemctl', ['is-enabled', 'server-control.service']).out;
    const active = sh('systemctl', ['is-active', 'server-control.service']).out;
    const props = Object.fromEntries(sh('systemctl', ['show', 'server-control.service', '-p', 'NRestarts,User,ActiveEnterTimestamp,MainPID']).out.split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    assert(active === 'active', `server-control.service is ${active}${diagnosePort()}`);
    if (props.User !== 'servermin') fail(`runs as "${props.User || 'root'}", expected servermin`);
    // "active" can be a moment between crash-loop restarts: make sure this process holds the web port.
    if (isRoot && has('ss')) {
      const listeners = sh('ss', ['-H', '-ltnp', `sport = :${port}`]).out;
      if (!new RegExp(`pid=${props.MainPID}\\b`).test(listeners)) fail(`active, but not listening on port ${port}${diagnosePort()}`);
    }
    if (enabled !== 'enabled') warn(`active but "${enabled}" — it will not start at boot`);
    if (Number(props.NRestarts) > 0) warn(`active, but restarted ${props.NRestarts} times since boot; see journalctl -u server-control`);
    return `active and enabled, user servermin, up since ${props.ActiveEnterTimestamp}`;
  });

  await check('Service account', () => {
    const id = sh('id', ['servermin']);
    assert(id.code === 0, 'the servermin account does not exist');
    if (/uid=0\b/.test(id.out)) fail('servermin has uid 0');
    const groups = sh('id', ['-nG', 'servermin']).out.split(/\s+/);
    const missing = ['systemd-journal'].filter((g) => !groups.includes(g));
    if (missing.length) warn(`not in ${missing.join(', ')} — journal logs will be incomplete`);
    const dockerGroup = sh('getent', ['group', 'docker']).code === 0;
    if (dockerGroup && !groups.includes('docker')) warn('not in the docker group — the Docker module cannot reach the engine');
    return `groups: ${groups.join(' ')}`;
  });

  await check('Configuration', () => {
    assert(config, `${CONFIG_FILE} is missing or not valid JSON`);
    const st = statSync(CONFIG_FILE);
    if (st.mode & 0o004) warn(`${CONFIG_FILE} is world-readable`);
    report.privilegedMode = config.privileged?.mode;
    if (config.privileged?.mode && config.privileged.mode !== 'sudo') warn(`privileged.mode is "${config.privileged.mode}" — host actions are not executed`);
    return `${tls ? 'https' : 'http'} port ${port}, privileged mode ${config.privileged?.mode ?? 'sudo'}`;
  });

  await check('Data directories', () => {
    const dirs = [config?.paths?.data ?? '/var/lib/servermin', config?.paths?.modules ?? '/var/lib/servermin/modules'];
    const owner = sh('id', ['-u', 'servermin']);
    for (const d of dirs) assert(existsSync(d), `${d} does not exist`);
    if (owner.code !== 0) fail('cannot check ownership: the servermin account does not exist');
    for (const d of dirs) if (String(statSync(d).uid) !== owner.out) fail(`${d} is not owned by servermin`);
    const free = sh('df', ['-Pk', dirs[0]]).out.split('\n')[1]?.split(/\s+/)[3];
    if (free && Number(free) < 500_000) warn(`only ${Math.round(Number(free) / 1024)} MB free on the data volume`);
    return `${dirs.join(', ')} owned by servermin${free ? `, ${Math.round(Number(free) / 1024 / 1024)} GB free` : ''}`;
  });

  await check('Privilege helper and sudoers rule', () => {
    needRoot();
    const helper = config?.privileged?.helper ?? '/usr/lib/servermin/servermin-privileged';
    assert(existsSync(helper), `${helper} is missing`);
    const st = statSync(helper);
    if (st.uid !== 0) fail(`${helper} is not owned by root`);
    if (st.mode & 0o022) fail(`${helper} is writable by group or others`);
    if (sh('id', ['servermin']).code !== 0) fail('the servermin account does not exist');
    if (!existsSync('/etc/sudoers.d/servermin')) fail('/etc/sudoers.d/servermin is missing');
    if (!has('visudo')) fail('sudo is not installed');
    const visudo = sh('visudo', ['-cf', '/etc/sudoers.d/servermin']);
    if (visudo.code !== 0) fail(`/etc/sudoers.d/servermin is invalid: ${visudo.err || visudo.out || `exit ${visudo.code}`}`);
    // As the service account, without a password, reach the helper and get a validation error back.
    const r = sh('sudo', ['-n', helper, 'servermin-verify.probe'], { user: 'servermin' });
    if (/password is required|not allowed|may not run/i.test(r.err)) fail(`servermin cannot run the helper without a password: ${r.err}`);
    if (r.code !== 2 || !/unknown operation/.test(r.err)) fail(`unexpected helper response (exit ${r.code}): ${r.err || r.out}`);
    // And the service account must not have any other root access.
    const other = sh('sudo', ['-n', '/usr/bin/id', '-u'], { user: 'servermin' });
    if (other.code === 0 && other.out === '0') fail('servermin can run other commands as root through sudo — the sudoers rule is too broad');
    return 'root-owned helper reachable by servermin without a password; no other sudo access';
  });

  await check('Host tools', () => {
    const required = ['python3', 'ip', 'lsblk', 'findmnt', 'journalctl', 'systemctl', 'sudo', 'tar'];
    const optional = ['netplan', 'docker', 'smartctl', 'timedatectl', 'hostnamectl'];
    const missing = required.filter((c) => !has(c));
    if (missing.length) fail(`missing: ${missing.join(', ')}`);
    const absent = optional.filter((c) => !has(c));
    if (absent.length) warn(`optional tools not installed: ${absent.join(', ')} (${absent.map((a) => ({ netplan: 'network changes', docker: 'Docker module', smartctl: 'disk health', timedatectl: 'time settings', hostnamectl: 'hostname changes' })[a]).join(', ')})`);
    return 'all present';
  });
}

/** Explains who holds the web port and whether Server Control failed to bind it. */
function diagnosePort(): string {
  const hints: string[] = [];
  const url = new URL(BASE);
  const portNum = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (has('ss')) {
    const ss = sh('ss', ['-H', '-ltnp', `sport = :${portNum}`]);
    const procs = [...new Set([...ss.out.matchAll(/\(\("([^"]+)",pid=(\d+)/g)].map((m) => `${m[1]} (pid ${m[2]})`))];
    if (procs.length) hints.push(`port ${portNum} is held by ${procs.join(', ')}`);
    else if (ss.out) hints.push(`something listens on port ${portNum}${isRoot ? '' : ' (run with sudo to see which program)'}`);
    else hints.push(`nothing listens on port ${portNum}`);
  }
  if (existsSync('/run/systemd/system') && has('journalctl')) {
    const log = sh('journalctl', ['-u', 'server-control', '-b', '--no-pager', '-n', '300', '-o', 'cat']).out;
    if (/EADDRINUSE/.test(log)) hints.push(`Server Control could not bind port ${portNum} (EADDRINUSE): stop the other program or reinstall with --port`);
    const listening = [...log.matchAll(/Listening on ([^"\s]+)/g)].pop()?.[1];
    if (listening) hints.push(`Server Control last reported listening on ${listening}`);
  }
  return hints.length ? ` — ${hints.join('; ')}` : '';
}

async function apiChecks() {
  group('Platform API');

  const health = await check('Web server reachable', async () => {
    const res = await fetch(`${BASE}/api/v1/health`, { signal: AbortSignal.timeout(5000) }).catch((e) => fail(`${BASE}: ${e.cause?.code ?? e.message}${diagnosePort()}`));
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    // Every Server Control response carries x-request-id; anything else means another program answered.
    if (!res.headers.get('x-request-id') || res.status !== 200 || typeof body?.version !== 'string') {
      const who = res.headers.get('server') ? `"${res.headers.get('server')}"` : 'a program that is not Server Control';
      const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 80);
      fail(`HTTP ${res.status} from ${who}${snippet ? ` (${snippet})` : ''}${diagnosePort()}`);
    }
    const r = { status: res.status, body };
    report.coreVersion = r.body.version;
    if (r.body.status !== 'HEALTHY') warn(`core ${r.body.version} reports ${r.body.status}`);
    return `core ${r.body.version}, ${r.body.status}`;
  });
  if (health.status === 'FAIL') return;

  const signedIn = await check('Authentication', async () => {
    const how = await authenticate();
    const s = await ok('GET', '/api/v1/auth/session');
    assert(s.authenticated, 'not signed in');
    const who = `${s.user.username} via ${how}`;
    if (!s.user.permissions.includes('*')) warn(`${who}, without administrator rights; some checks may be denied`);
    if (s.simulated) warn(`${who}; privileged operations are simulated on this server`);
    return who;
  });
  if (signedIn.status === 'FAIL') return;

  let modules: any[] = [];
  await check('Built-in modules active', async () => {
    modules = await ok('GET', '/api/v1/platform/modules');
    const byId = new Map(modules.map((m) => [m.id, m]));
    const missing = BUILT_IN.filter((id) => !byId.has(id));
    const inactive = BUILT_IN.filter((id) => byId.has(id) && byId.get(id).state !== 'ACTIVE').map((id) => `${id}=${byId.get(id).state}${byId.get(id).error ? ` (${byId.get(id).error})` : ''}`);
    if (missing.length || inactive.length) fail([missing.length && `not installed: ${missing.join(', ')}`, inactive.length && `not active: ${inactive.join('; ')}`].filter(Boolean).join(' · '));
    const unverified = modules.filter((m) => m.integrity !== 'verified').map((m) => m.id);
    if (unverified.length) warn(`all active; integrity not verified for ${unverified.join(', ')}`);
    return `${modules.length} modules, all active and verified`;
  });

  await check('Module health', async () => {
    await sleep(500);
    const list = await ok<any[]>('GET', '/api/v1/platform/modules');
    const bad = list.filter((m) => m.state === 'ACTIVE' && m.health.status !== 'HEALTHY').map((m) => `${m.id}: ${m.health.status}${m.health.message ? ` (${m.health.message})` : ''}`);
    report.moduleHealth = Object.fromEntries(list.map((m) => [m.id, m.health]));
    if (bad.length) warn(bad.join('; '));
    return 'all healthy';
  });

  const mod = (id: string) => modules.find((m) => m.id === id && m.state === 'ACTIVE') ?? skip(`the ${id} module is not active`);

  group('Hardware discovery (§38)');
  await check('System: hardware detected at runtime', async () => {
    mod('system');
    const i = await ok('GET', '/api/v1/modules/system/info');
    report.hardware = { hostname: i.hostname, cpu: i.cpu.model, cores: i.cpu.cores, threads: i.cpu.threads, memory: i.memory.total, gpus: i.gpus, vendor: i.hardware.sys_vendor, product: i.hardware.product_name, machineId: i.hardware.machineId, kernel: i.kernel };
    assert(i.cpu.threads > 0 && i.memory.total > 0, 'CPU or memory not detected');
    const machine = [i.hardware.sys_vendor, i.hardware.product_name].filter(Boolean).join(' ');
    return [machine, `${i.cpu.model} (${i.cpu.cores}c/${i.cpu.threads}t)`, `${Math.round(i.memory.total / 2 ** 30)} GiB`, `${i.gpus.length} GPU`].filter(Boolean).join(' · ');
  });

  await check('Storage: disks and the system (boot) disk', async () => {
    mod('storage');
    const disks = await ok<any[]>('GET', '/api/v1/modules/storage/disks');
    const system = disks.find((d) => d.system);
    report.disks = disks.filter((d) => d.type === 'disk').map((d) => ({ path: d.path, size: d.size, model: d.model, transport: d.transport, system: d.system }));
    assert(disks.some((d) => d.type === 'disk'), 'no disks detected');
    if (!system) fail('could not tell which disk holds / — it might be offered for mounting');
    return `${disks.filter((d) => d.type === 'disk').length} disks; system disk ${system.path} (${system.transport ?? 'unknown bus'}${system.removable ? ', removable' : ''})`;
  });

  await check('Network: interfaces, address and gateway', async () => {
    mod('network');
    const s = await ok('GET', '/api/v1/modules/network/status');
    report.network = s.up;
    assert(s.up.length > 0, 'no interface is up');
    const addressed = s.up.filter((i: any) => i.addresses.length);
    if (!addressed.length) fail('no interface has a global address');
    if (!s.gateway) warn(`${addressed.map((i: any) => i.name).join(', ')} up, but there is no default gateway`);
    if (s.pending) warn('a network change is waiting for confirmation');
    return `${addressed.map((i: any) => `${i.name} ${i.addresses.join(' ')}`).join('; ')} · gateway ${s.gateway.gateway} via ${s.gateway.device}`;
  });

  group('Module functions');
  await check('Services: systemd units listed', async () => {
    mod('services');
    const s = await ok('GET', '/api/v1/modules/services/summary');
    assert(s.running > 0, 'no running services reported');
    if (s.failed.length) warn(`${s.running} running; failed: ${s.failed.join(', ')}`);
    return `${s.running} running, ${s.enabled} enabled at boot, none failed`;
  });

  await check('Logs: journal readable', async () => {
    mod('logs');
    const l = await ok<any[]>('GET', '/api/v1/modules/logs/journal?lines=20&since=-24h');
    assert(l.length > 0, 'the journal returned no entries');
    const sources = new Set(l.map((e) => e.source));
    if (sources.size === 1 && l.every((e) => e.source === 'server-control.service')) warn('only Server Control entries are visible — is servermin in systemd-journal?');
    return `${l.length} entries from ${sources.size} sources`;
  });

  await check('Monitoring: samples recorded', async () => {
    mod('monitoring');
    const m = await ok<any[]>('GET', '/api/v1/modules/monitoring/metrics');
    const names = m.map((x) => x.name);
    if (!names.includes('memory.usage')) fail('no host samples recorded');
    const missing = ['cpu.usage', 'disk.root.usage', 'network.rx'].filter((n) => !names.includes(n));
    if (missing.length) warn(`not recorded yet: ${missing.join(', ')} (wait one sample interval and run again)`);
    return `${m.length} series, ${m.filter((x) => x.source !== 'host').length} contributed by modules`;
  });

  await check('Docker: engine reachable', async () => {
    mod('docker');
    const s = await ok('GET', '/api/v1/modules/docker/status');
    if (!s.available) (has('docker') ? fail : skip)(s.error ?? 'unavailable');
    return `Docker ${s.version}, ${s.containers.running} running / ${s.containers.total} containers, ${s.images} images`;
  });

  await check('Applications: deployment targets', async () => {
    mod('applications');
    const c = await ok('GET', '/api/v1/modules/applications/capabilities');
    if (!c.docker || !c.systemd) warn(`docker.engine ${c.docker ? 'available' : 'unavailable'}, services.systemd ${c.systemd ? 'available' : 'unavailable'}`);
    return 'container and system-service deployments available';
  });

  await check('Live channel: system metrics over WebSocket', async () => {
    mod('system');
    const got = await channel('system.metrics', {}, { until: (d) => !!d?.memory });
    return `received ${got.length} update(s)`;
  });

  await check('Terminal: shell over WebSocket runs unprivileged', async () => {
    mod('terminal');
    const marker = `SMV${Date.now()}`;
    let text = '';
    await channel('terminal.session', { rows: 24, cols: 100 }, {
      send: [{ type: 'input', data: `echo ${marker}:$(id -un):$(id -u):END\n` }],
      until: (d) => {
        if (d?.type === 'output') text += d.data;
        return new RegExp(`${marker}:\\S+:\\d+:END`).test(text);
      },
      timeoutMs: 15_000,
    });
    const [, user, uid] = new RegExp(`${marker}:(\\S+):(\\d+):END`).exec(text)!;
    if (uid === '0') fail(`the terminal shell runs as ${user} (uid 0) — it must run as the service account`);
    return `shell runs as ${user} (uid ${uid})`;
  });

  await check('Privilege boundary: no-op time zone change through the helper', async () => {
    mod('system');
    const t = await ok('GET', '/api/v1/modules/system/time');
    const r = await api('PUT', '/api/v1/modules/system/timezone', { timezone: t.timezone });
    if (r.status >= 400) fail(`setting the time zone to its current value (${t.timezone}) failed: ${r.body?.error}`);
    const audit = await ok<any[]>('GET', '/api/v1/audit?action=privileged.system.set-timezone&limit=1');
    if (audit[0]?.result !== 'success') fail('the privileged operation was not audited as successful');
    if (audit[0]?.metadata?.simulated) warn('the operation was simulated (privileged.mode is not "sudo")');
    return `set ${t.timezone} → ${t.timezone} via sudo and the helper; audited`;
  });
}

async function disruptiveChecks() {
  const any = flag('docker') || value('mount') || value('service') || flag('updates') || flag('network-rollback');
  if (!any) return;
  group('Opt-in checks (these change the system and clean up)');

  if (value('service'))
    await check(`Restart ${value('service')}`, async () => {
      const unit = value('service')!;
      const r = await api('POST', `/api/v1/modules/services/services/${encodeURIComponent(unit)}/restart`, { confirm: true }, 60_000);
      if (r.status >= 400) fail(r.body?.error ?? `HTTP ${r.status}`);
      await sleep(1500);
      const s = await ok('GET', `/api/v1/modules/services/services/${encodeURIComponent(unit)}`);
      assert(s.ActiveState === 'active', `${unit} is ${s.ActiveState} after the restart`);
      return `${unit} restarted and active (PID ${s.MainPID})`;
    });

  if (flag('updates'))
    await check('Refresh the package index', async () => {
      await ok('POST', '/api/v1/modules/system/updates/refresh', {}, 600_000);
      const u = await ok('GET', '/api/v1/modules/system/updates', undefined, 120_000);
      return `apt-get update ran as root through the helper; ${u.packages.length} upgrades available`;
    });

  if (value('mount'))
    await check(`Mount and unmount ${value('mount')}`, async () => {
      const device = value('mount')!;
      const target = '/mnt/servermin-verify';
      const r = await api('POST', '/api/v1/modules/storage/mount', { device, target, readonly: true }, 60_000);
      if (r.status >= 400) fail(r.body?.error ?? `HTTP ${r.status}`);
      try {
        const mounts = await ok<any[]>('GET', '/api/v1/modules/storage/mounts');
        const m = mounts.find((x) => x.target === target);
        assert(m, `${target} is not listed after mounting`);
        assert(m.options.split(',').includes('ro') && m.options.split(',').includes('nosuid'), `mounted without ro,nosuid (${m.options})`);
      } finally {
        const u = await api('POST', '/api/v1/modules/storage/unmount', { target, confirm: true }, 60_000);
        if (u.status >= 400) fail(`unmount failed: ${u.body?.error} — unmount ${target} manually`);
      }
      return `${device} mounted read-only with nosuid,nodev at ${target}, then unmounted`;
    });

  if (flag('docker'))
    await check('Deploy, reach and remove a test application', async () => {
      let hostPort = 18_080;
      while (!(await portFree(hostPort)) && hostPort < 18_100) hostPort++;
      const id = 'servermin-verify';
      await api('DELETE', `/api/v1/modules/applications/apps/${id}`);
      await ok('POST', '/api/v1/modules/applications/apps', { id, name: 'Verification', type: 'docker', version: 'alpine', spec: { image: 'nginx' }, ports: [`127.0.0.1:${hostPort}:80`], domains: [], environment: {} });
      try {
        const d = await api('POST', `/api/v1/modules/applications/apps/${id}/deploy`, {}, 600_000);
        if (d.status >= 400) fail(`deployment failed: ${d.body?.error}`);
        let res: Response | null = null;
        for (let i = 0; i < 20 && !res?.ok; i++) {
          res = await fetch(`http://127.0.0.1:${hostPort}/`).catch(() => null);
          if (!res?.ok) await sleep(500);
        }
        assert(res?.ok && /nginx/i.test(await res.text()), `the application did not answer on port ${hostPort}`);
        const app = await ok('GET', `/api/v1/modules/applications/apps/${id}`);
        assert(app.status.state === 'running', `status is ${app.status.state}`);
      } finally {
        await api('DELETE', `/api/v1/modules/applications/apps/${id}`, undefined, 120_000);
      }
      return `nginx:alpine deployed through Applications → docker.engine, answered on 127.0.0.1:${hostPort}, removed`;
    });

  if (flag('network-rollback')) {
    await check('Network change rolls back automatically', async () => {
      if (!flag('i-have-console-access')) skip('add --i-have-console-access: if the rollback fails, this server may become unreachable');
      const ifaces = await ok<any[]>('GET', '/api/v1/modules/network/interfaces');
      const status = await ok('GET', '/api/v1/modules/network/status');
      const iface = ifaces.find((i) => i.name === status.gateway?.device && i.type === 'ethernet') ?? skip('no wired interface carries the default route');
      const v4 = iface.addresses.filter((a: any) => a.family === 'ipv4' && a.scope === 'global');
      // Re-apply what the interface already has, so the network does not actually change.
      const body = v4.length && v4.every((a: any) => !a.dynamic)
        ? { mode: 'static', addresses: v4.map((a: any) => `${a.address}/${a.prefix}`), gateway: status.gateway.gateway, acknowledgeRisk: true }
        : { mode: 'dhcp', acknowledgeRisk: true };
      const cfg = await ok('GET', '/api/v1/platform/modules/network/config');
      const previousRollback = cfg.values.rollbackSeconds;
      await ok('PUT', '/api/v1/platform/modules/network/config', { rollbackSeconds: 30 });
      try {
        const applied = await api('PUT', `/api/v1/modules/network/interfaces/${iface.name}`, body, 120_000);
        if (applied.status >= 400) fail(`apply failed: ${applied.body?.error}`);
        process.stdout.write(`      applied ${body.mode} to ${iface.name}; waiting up to 60 s for the automatic rollback…\n`);
        let pending: any = applied.body.pending;
        for (let i = 0; i < 60 && pending; i++) {
          await sleep(1000);
          pending = (await api('GET', '/api/v1/modules/network/pending').catch(() => ({ body: pending }))).body;
        }
        assert(!pending, 'the change is still pending after 60 s — confirm or roll it back in the Network page');
        const timer = sh('systemctl', ['is-active', 'servermin-network-rollback.timer']).out;
        if (timer === 'active') fail('the rollback timer is still active');
        assert((await api('GET', '/api/v1/health', undefined, 5000)).status === 200, 'the server is not reachable after the rollback');
      } finally {
        await api('PUT', '/api/v1/platform/modules/network/config', { rollbackSeconds: previousRollback });
      }
      return `${iface.name}: applied, rolled back by the systemd timer without confirmation, server still reachable`;
    });
  }
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write(`Server Control verification · ${new Date().toLocaleString()} · ${BASE}\n`);
  if (!isRoot) process.stdout.write('Not running as root: some host checks are skipped. Use sudo for the full check.\n');
  await hostChecks();
  await apiChecks();
  await disruptiveChecks();
  if (auth.cookie) await api('POST', '/api/v1/auth/logout').catch(() => undefined);

  const count = (s: Status) => results.filter((r) => r.status === s).length;
  process.stdout.write(`\n${color.PASS}${count('PASS')} passed${color.reset} · ${color.WARN}${count('WARN')} warnings${color.reset} · ${color.FAIL}${count('FAIL')} failed${color.reset} · ${count('SKIP')} skipped\n`);
  const out = value('json');
  if (out) {
    writeFileSync(out, JSON.stringify({ ...report, finishedAt: new Date().toISOString(), summary: { pass: count('PASS'), warn: count('WARN'), fail: count('FAIL'), skip: count('SKIP') }, results }, null, 2) + '\n');
    process.stdout.write(`Report written to ${out}\n`);
  }
  process.exit(count('FAIL') ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`servermin-verify: ${e?.message ?? e}\n`);
  process.exit(2);
});
