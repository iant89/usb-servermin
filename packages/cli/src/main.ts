/**
 * serverctl — talks to the platform REST API; it never duplicates platform logic (§37).
 *
 *   serverctl login [--url URL] [--token TOKEN]     store credentials (~/.config/serverctl.json)
 *   serverctl status
 *   serverctl module list | info <id> | discover
 *   serverctl module install <path|file.tgz|git-url> [--ref REF] [--sha256 SUM]
 *   serverctl module update <id> <path|file.tgz|git-url>
 *   serverctl module remove <id> [--delete-data]
 *   serverctl module enable|disable|reload|restart <id>
 *   serverctl module logs <id> [--level LEVEL] [--limit N]
 *   serverctl module config <id> [key=value ...]
 *   serverctl update [check]                        show or look for a newer signed release
 *   serverctl update apply [--yes]                  install it (the server restarts; rolls back on failure)
 *   serverctl update module <id>                    install one module package from the latest release
 *   serverctl update auto on|off [--window HH:MM]   automatic installation in a maintenance window
 *   serverctl update rollback [--yes]               reinstall the previous version
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promptCredentials } from './prompt';

const USAGE = `serverctl — talks to the platform REST API; it never duplicates platform logic (§37).

  serverctl login [--url URL] [--token TOKEN]     store credentials (~/.config/serverctl.json)
  serverctl status
  serverctl module list | info <id> | discover
  serverctl module install <path|file.tgz|git-url> [--ref REF] [--sha256 SUM]
  serverctl module update <id> <path|file.tgz|git-url>
  serverctl module remove <id> [--delete-data]
  serverctl module enable|disable|reload|restart <id>
  serverctl module logs <id> [--level LEVEL] [--limit N]
  serverctl module config <id> [key=value ...]
  serverctl update [check]                        show or look for a newer signed release
  serverctl update apply [--yes]                  install it (the server restarts; rolls back on failure)
  serverctl update module <id>                    install one module package from the latest release
  serverctl update auto on|off [--window HH:MM]   automatic installation in a maintenance window
  serverctl update rollback [--yes]               reinstall the previous version\n`;

interface Credentials {
  url: string;
  token: string;
}

const CONFIG = process.env.SERVERCTL_CONFIG ?? join(homedir(), '.config', 'serverctl.json');

function loadCredentials(): Credentials {
  const url = process.env.SERVERCTL_URL;
  const token = process.env.SERVERCTL_TOKEN;
  if (url && token) return { url, token };
  if (!existsSync(CONFIG)) fail('Not logged in. Run `serverctl login` first (or set SERVERCTL_URL and SERVERCTL_TOKEN).');
  return JSON.parse(readFileSync(CONFIG, 'utf8'));
}

function fail(message: string, code = 1): never {
  process.stderr.write(`serverctl: ${message}\n`);
  process.exit(code);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function bool(args: string[], name: string): boolean {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

async function call<T = any>(creds: Credentials, method: string, path: string, body?: unknown, raw?: Buffer, query?: Record<string, string>): Promise<T> {
  const url = new URL(path, creds.url);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${creds.token}`, ...(raw ? { 'content-type': 'application/octet-stream' } : body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: raw ? new Uint8Array(raw) : body !== undefined ? JSON.stringify(body) : undefined,
  }).catch((e) => fail(`Cannot reach ${creds.url}: ${e.message}`));
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined;
  if (!res.ok) {
    const problems = data?.problems?.length ? '\n  - ' + data.problems.join('\n  - ') : '';
    fail(`${data?.error ?? res.statusText} (HTTP ${res.status})${problems}`);
  }
  return data as T;
}

function table(rows: Record<string, unknown>[], cols: string[]) {
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join('  ');
  console.log(line(cols.map((c) => c.toUpperCase())));
  for (const r of rows) console.log(line(cols.map((c) => String(r[c] ?? ''))));
}

function sourceFor(arg: string, args: string[]) {
  if (/^(https:\/\/|git@|ssh:\/\/)/.test(arg)) return { body: { source: 'git', url: arg, ref: flag(args, 'ref') } };
  const path = resolve(arg);
  if (!existsSync(path)) fail(`${arg} does not exist`);
  if (statSync(path).isFile()) return { file: readFileSync(path), sha256: flag(args, 'sha256') };
  return { body: { source: 'directory', path } };
}

async function login(args: string[]) {
  const url = flag(args, 'url') ?? process.env.SERVERCTL_URL ?? 'http://127.0.0.1';
  let token = flag(args, 'token');
  if (!token) {
    const [username, password] = await promptCredentials().catch((e) => fail(e.message));
    const res = await fetch(new URL('/api/v1/auth/login', url), { method: 'POST', headers: { 'content-type': 'application/json', 'x-servermin-request': '1' }, body: JSON.stringify({ username, password }) });
    if (!res.ok) fail((await res.json().catch(() => ({}))).error ?? 'Login failed');
    const cookie = res.headers.get('set-cookie')?.split(';')[0];
    const t = await fetch(new URL('/api/v1/auth/tokens', url), { method: 'POST', headers: { cookie: cookie ?? '', 'content-type': 'application/json', 'x-servermin-request': '1' }, body: JSON.stringify({ name: 'serverctl', expiresInDays: 365 }) });
    if (!t.ok) fail('Could not create an API token');
    token = (await t.json()).token as string;
  }
  await call({ url, token: token! }, 'GET', '/api/v1/auth/session');
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify({ url, token }, null, 2), { mode: 0o600 });
  console.log(`Logged in to ${url}. Credentials saved to ${CONFIG}.`);
}

function printUpdates(u: any) {
  console.log(`Installed: ${u.currentVersion}   Releases: github.com/${u.repository}`);
  if (u.blocker) console.log(`Not available: ${u.blocker}`);
  console.log(`Last checked: ${u.checkedAt ?? 'never'}${u.error ? ` (${u.error})` : ''}`);
  console.log(u.available ? `Available: ${u.available.version} (published ${u.available.publishedAt})  ${u.available.url}` : 'Up to date');
  if (u.lastResult?.finishedAt) console.log(`Last update: ${u.lastResult.state} ${u.lastResult.from} → ${u.lastResult.to ?? '?'} at ${u.lastResult.finishedAt}${u.lastResult.error ? ` — ${u.lastResult.error}` : ''}`);
  if (u.applying) console.log(`An update is in progress (${u.lastResult.state}).`);
  console.log(`Automatic installation: ${u.settings.autoInstall ? `on, at ${u.settings.window}` : 'off'}`);
  if (u.previousVersion) console.log(`Previous version kept for rollback: ${u.previousVersion}`);
  if (u.moduleUpdates.length) {
    console.log('');
    table(u.moduleUpdates.map((m: any) => ({ ...m, note: m.compatible ? '' : 'needs a newer core' })), ['id', 'installed', 'available', 'note']);
  }
}

async function confirm(question: string, args: string[]) {
  if (bool(args, 'yes')) return;
  if (!process.stdin.isTTY) fail(`${question} Pass --yes to confirm.`);
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  if (answer !== 'y' && answer !== 'yes') fail('Cancelled');
}

async function update(creds: Credentials, args: string[]) {
  const [sub = 'status', arg] = args;
  switch (sub) {
    case 'status':
      return printUpdates(await call(creds, 'GET', '/api/v1/updates'));
    case 'check':
      return printUpdates(await call(creds, 'POST', '/api/v1/updates/check'));
    case 'apply': {
      const u = await call(creds, 'GET', '/api/v1/updates');
      if (!u.available) fail('No newer release is known. Run `serverctl update check` first.');
      await confirm(`Install Server Control ${u.available.version}? The server restarts.`, args);
      const r = await call(creds, 'POST', '/api/v1/updates/apply');
      return console.log(r.simulated ? `Simulated: the update to ${r.version} would start now.` : `Installing ${r.version}. The server restarts; run \`serverctl update\` in a minute or two to see the result.`);
    }
    case 'rollback': {
      const u = await call(creds, 'GET', '/api/v1/updates');
      if (!u.previousVersion) fail('There is no previous version to roll back to.');
      await confirm(`Roll back to ${u.previousVersion}? The server restarts and changes since the last update are lost.`, args);
      const r = await call(creds, 'POST', '/api/v1/updates/rollback');
      return console.log(`Rolling back to ${r.version}.`);
    }
    case 'module': {
      if (!arg) fail('Module id required');
      const r = await call(creds, 'POST', `/api/v1/updates/modules/${encodeURIComponent(arg)}`);
      return console.log(`${arg} is now ${r.module?.version ?? 'updated'}.`);
    }
    case 'auto': {
      if (arg !== 'on' && arg !== 'off') fail('Usage: serverctl update auto on|off [--window HH:MM]');
      const window = flag(args, 'window');
      const s = await call(creds, 'PUT', '/api/v1/updates/settings', { autoInstall: arg === 'on', ...(window ? { window } : {}) });
      return console.log(`Automatic installation ${s.autoInstall ? `on, at ${s.window} (server time)` : 'off'}.`);
    }
    default:
      fail(`Unknown update command "${sub}"`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const [cmd, sub, ...rest] = args;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    process.stdout.write(USAGE);
    return;
  }
  if (cmd === 'login') return login(args.slice(1));
  const creds = loadCredentials();
  if (cmd === 'status') {
    const s = await call(creds, 'GET', '/api/v1/system');
    console.log(`${s.hostname}  ${s.os}  core ${s.coreVersion}  health ${s.health.status}`);
    table(Object.entries(s.health.modules).map(([id, m]: [string, any]) => ({ module: id, state: m.state, health: m.health, message: m.message ?? '' })), ['module', 'state', 'health', 'message']);
    return;
  }
  if (cmd === 'update') return update(creds, args.slice(1));
  if (cmd !== 'module') fail(`Unknown command "${cmd}". Try serverctl help.`);
  const id = rest[0];
  const need = () => id ?? fail('Module id required');
  switch (sub) {
    case 'list':
      return table(await call(creds, 'GET', '/api/v1/platform/modules'), ['id', 'name', 'version', 'state', 'enabled']);
    case 'discover':
      return table(await call(creds, 'GET', '/api/v1/platform/modules/discover'), ['id', 'version', 'state', 'installedVersion', 'path']);
    case 'info':
      return console.log(JSON.stringify(await call(creds, 'GET', `/api/v1/platform/modules/${need()}`), null, 2));
    case 'install':
    case 'update': {
      const target = sub === 'install' ? id : rest[1];
      if (!target) fail('Source required: a directory, a .tgz package or a git URL');
      const s = sourceFor(target, rest);
      const base = sub === 'install' ? '/api/v1/platform/modules' : `/api/v1/platform/modules/${need()}`;
      const r = s.file
        ? await call(creds, 'POST', `${base}/upload`, undefined, s.file, s.sha256 ? { sha256: s.sha256 } : undefined)
        : await call(creds, 'POST', sub === 'install' ? base : `${base}/update`, s.body);
      console.log(`${r.module.id} ${r.module.version}: ${r.module.state}`);
      for (const w of r.warnings ?? []) console.log(`warning: ${w}`);
      return;
    }
    case 'remove': {
      const deleteData = bool(rest, 'delete-data');
      const r = await call(creds, 'DELETE', `/api/v1/platform/modules/${need()}`, undefined, undefined, deleteData ? { deleteData: 'true' } : undefined);
      console.log(`Removed ${r.removed}${r.dataDeleted ? ' and its data' : ' (data kept)'}`);
      return;
    }
    case 'enable':
    case 'disable':
    case 'reload':
    case 'restart': {
      const r = await call(creds, 'POST', `/api/v1/platform/modules/${need()}/${sub}`);
      console.log(`${r.id}: ${r.state}${r.error ? ` — ${r.error}` : ''}`);
      return;
    }
    case 'logs': {
      const level = flag(rest, 'level');
      const limit = flag(rest, 'limit') ?? '100';
      const rows = await call<any[]>(creds, 'GET', `/api/v1/platform/modules/${need()}/logs`, undefined, undefined, { limit, ...(level ? { level } : {}) });
      for (const r of rows.reverse()) console.log(`${r.timestamp} ${r.level.padEnd(5)} ${r.message}`);
      return;
    }
    case 'config': {
      const pairs = rest.slice(1);
      if (!pairs.length) return console.log(JSON.stringify(await call(creds, 'GET', `/api/v1/platform/modules/${need()}/config`), null, 2));
      const update: Record<string, unknown> = {};
      for (const p of pairs) {
        const i = p.indexOf('=');
        if (i < 1) fail(`Expected key=value, got "${p}"`);
        const v = p.slice(i + 1);
        update[p.slice(0, i)] = v === 'true' ? true : v === 'false' ? false : v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
      }
      return console.log(JSON.stringify(await call(creds, 'PUT', `/api/v1/platform/modules/${need()}/config`, update), null, 2));
    }
    default:
      fail(`Unknown module command "${sub}"`);
  }
}

main().catch((e) => fail(e?.message ?? String(e)));
