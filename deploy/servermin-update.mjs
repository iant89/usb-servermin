#!/usr/bin/env node
/**
 * servermin-update — installs a signed release, or rolls back to the previous one. Runs as root.
 *
 * Started by the privilege helper in its own transient systemd unit (servermin-update.service),
 * outside server-control.service, so stopping the server does not stop the update.
 *
 *   servermin-update apply <release.json> <release.json.sig> <archive.tar.gz>
 *   servermin-update rollback
 *   servermin-update status
 *
 * Everything is checked here, as root, with root-owned code and the root-owned public key of the
 * installed release: the core that downloaded the files is not trusted.
 *
 * Progress and the outcome go to <data>/update-status.json, which the core reads.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, join } from 'node:path';

// Overridable only for tests; the helper starts this with a clean environment.
const APP = process.env.SERVERMIN_APP ?? '/opt/servermin';
const STATE = process.env.SERVERMIN_UPDATE_STATE ?? '/var/lib/servermin-helper/update';
const CONFIG = process.env.SERVERMIN_CONFIG ?? '/etc/servermin/config.json';
const SYSTEMCTL = process.env.SERVERMIN_SYSTEMCTL ?? 'systemctl';
const SYSTEM_ROOT = process.env.SERVERMIN_SYSTEM_ROOT ?? '/';
const HEALTH_TIMEOUT_MS = Number(process.env.SERVERMIN_HEALTH_TIMEOUT_MS ?? 180_000);

const config = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : {};
const DATA = process.env.SERVERMIN_DATA ?? config.paths?.data ?? '/var/lib/servermin';
const STATUS_FILE = join(DATA, 'update-status.json');
const LOG_FILE = join(STATE, 'update.log');

// The agent's unit. Releases up to now ship it as server-control.service (with
// servermin-agent.service as an alias); a later release may ship it under the new name, and a
// rollback can cross that change in either direction, so both are handled.
const UNIT = 'servermin-agent.service';
const LEGACY_UNIT = 'server-control.service';

class UpdateError extends Error {}

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stdout.write(line);
  try {
    mkdirSync(STATE, { recursive: true });
    writeFileSync(LOG_FILE, line, { flag: 'a' });
  } catch {
    /* logging must not stop the update */
  }
}

function writeStatus(status) {
  const previous = readStatus();
  const next = { ...previous, ...status, updatedAt: new Date().toISOString() };
  mkdirSync(DATA, { recursive: true });
  writeFileSync(STATUS_FILE + '.tmp', JSON.stringify(next, null, 2) + '\n', { mode: 0o644 });
  renameSync(STATUS_FILE + '.tmp', STATUS_FILE);
  return next;
}

function readStatus() {
  try {
    return JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout ?? 300_000, env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', ...testEnv() } });
  for (const out of [r.stdout, r.stderr]) if (out?.trim()) log(out.trim().split('\n').slice(-40).join('\n'));
  if (opts.check !== false && r.status !== 0) throw new UpdateError(`${cmd} ${args[0] ?? ''} failed (exit ${r.status ?? r.signal})`);
  return r;
}

/** SERVERMIN_* overrides (tests only) reach the release's install.sh too. */
const testEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('SERVERMIN_')));

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const currentVersion = () => (existsSync(join(APP, 'VERSION')) ? readFileSync(join(APP, 'VERSION'), 'utf8').trim() : '0.0.0');

function newer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

function platformKey() {
  if (process.platform !== 'linux') throw new UpdateError(`Unsupported platform ${process.platform}`);
  return `linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
}

/** Signature, version and checksum checks. Returns the manifest entry for this machine. */
function verifyRelease(manifestFile, signatureFile, archiveFile) {
  const keyFile = join(APP, 'release-signing.pub');
  if (!existsSync(keyFile)) throw new UpdateError('This installation has no release signing key; install the update manually with install.sh');
  const bytes = readFileSync(manifestFile);
  const signature = Buffer.from(readFileSync(signatureFile, 'utf8').trim(), 'base64');
  if (!verify(null, bytes, createPublicKey(readFileSync(keyFile, 'utf8')), signature)) throw new UpdateError('The release signature is not valid for this installation\'s signing key');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.format !== 1 || !/^\d+\.\d+\.\d+$/.test(manifest.version ?? '')) throw new UpdateError('Unsupported release manifest');
  const from = currentVersion();
  if (!newer(manifest.version, from)) throw new UpdateError(`Release ${manifest.version} is not newer than the installed ${from}`);
  const entry = manifest.core?.[platformKey()];
  if (!entry) throw new UpdateError(`Release ${manifest.version} has no build for ${platformKey()}`);
  if (basename(archiveFile) !== entry.file) throw new UpdateError(`Expected ${entry.file}, got ${basename(archiveFile)}`);
  if (sha256(archiveFile) !== entry.sha256) throw new UpdateError(`${entry.file} does not match the checksum in the signed manifest`);
  return { manifest, entry, from };
}

function assertPlainFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    const st = lstatSync(full);
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) throw new UpdateError(`The release contains a link or special file: ${full}`);
    if (st.isDirectory()) assertPlainFiles(full);
  }
}

function extract(archiveFile, version) {
  const staging = join(STATE, 'staging');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  run('tar', ['-xzf', archiveFile, '-C', staging, '--no-same-owner', '--no-same-permissions']);
  assertPlainFiles(staging);
  const dirs = readdirSync(staging);
  if (dirs.length !== 1) throw new UpdateError('Unexpected archive layout');
  const root = join(staging, dirs[0]);
  for (const f of ['install.sh', 'server/server.js', 'VERSION', 'bin/servermin-update.mjs']) if (!existsSync(join(root, f))) throw new UpdateError(`The release is incomplete: ${f} is missing`);
  if (readFileSync(join(root, 'VERSION'), 'utf8').trim() !== version) throw new UpdateError('The archive version does not match the manifest');
  return root;
}

function healthUrl() {
  const port = Number(config.http?.port ?? 80);
  const bound = config.http?.host;
  const host = !bound || bound === '0.0.0.0' || bound === '::' ? '127.0.0.1' : bound.includes(':') ? `[${bound}]` : bound;
  return process.env.SERVERMIN_HEALTH_URL ?? `${config.http?.tls ? 'https' : 'http'}://${host}:${port}/api/v1/health`;
}

function getHealth(url) {
  return new Promise((resolve) => {
    const req = (url.startsWith('https') ? httpsRequest : httpRequest)(url, { timeout: 5000, rejectUnauthorized: false }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(body) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => req.destroy());
    req.end();
  });
}

/** Waits until the server answers its health check with the expected version. */
async function waitHealthy(version) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await getHealth(healthUrl());
    if (last?.version === version && last.status !== 'ERROR') return last;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new UpdateError(last ? `The server answered with version ${last.version} (${last.status}), expected a working ${version}` : `The server did not answer within ${HEALTH_TIMEOUT_MS / 1000} s`);
}

function snapshotDatabase(version) {
  const dir = join(STATE, `pre-update-${version}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(DATA)) if (/^core\.db(-wal|-shm)?$/.test(f)) copyFileSync(join(DATA, f), join(dir, f));
  return dir;
}

function restoreDatabase(dir) {
  if (!existsSync(dir)) return false;
  for (const f of readdirSync(DATA)) if (/^core\.db(-wal|-shm)?$/.test(f)) rmSync(join(DATA, f));
  for (const f of readdirSync(dir)) copyFileSync(join(dir, f), join(DATA, f));
  run('chown', ['servermin:servermin', ...readdirSync(DATA).filter((f) => f.startsWith('core.db')).map((f) => join(DATA, f))], { check: false });
  return true;
}

function stopAgent() {
  // Both names: whichever one is not installed is simply "not loaded".
  run(SYSTEMCTL, ['stop', UNIT, LEGACY_UNIT], { check: false });
}

/**
 * Installs the unit that the release in `deploy` ships and returns its name. The other name is
 * then either a unit file left by a release that used it, or an alias link; neither may stay,
 * or two units could be enabled for the same server. Enabling recreates the alias the installed
 * unit declares.
 */
function installUnit(deploy) {
  const dir = join(SYSTEM_ROOT, 'etc/systemd/system');
  const unit = existsSync(join(deploy, UNIT)) ? UNIT : LEGACY_UNIT;
  if (!existsSync(join(deploy, unit))) return unit;
  const otherName = unit === UNIT ? LEGACY_UNIT : UNIT;
  const other = join(dir, otherName);
  const stat = lstatSync(other, { throwIfNoEntry: false });
  // Never "disable" an alias name: that would disable the unit it points to.
  if (stat?.isFile()) run(SYSTEMCTL, ['disable', otherName], { check: false });
  if (stat) rmSync(other, { force: true });
  run('install', ['-m', '644', join(deploy, unit), join(dir, unit)], { check: false });
  run(SYSTEMCTL, ['daemon-reload'], { check: false });
  run(SYSTEMCTL, ['enable', unit], { check: false });
  return unit;
}

/** Puts the previous installation back, with its privilege helper and unit, and starts it. */
async function restorePrevious(fromVersion, reason) {
  const previous = `${APP}.previous`;
  if (!existsSync(previous)) throw new UpdateError(`Cannot roll back: ${previous} does not exist`);
  writeStatus({ state: 'rolling-back', reason });
  log(`Rolling back to ${fromVersion}: ${reason}`);
  stopAgent();
  const failed = join(STATE, 'failed-release');
  rmSync(failed, { recursive: true, force: true });
  if (existsSync(APP)) renameSync(APP, failed);
  renameSync(previous, APP);
  const deploy = join(APP, 'deploy');
  let unit = LEGACY_UNIT;
  if (existsSync(deploy)) {
    mkdirSync(join(SYSTEM_ROOT, 'usr/lib/servermin'), { recursive: true });
    mkdirSync(join(SYSTEM_ROOT, 'etc/systemd/system'), { recursive: true });
    run('install', ['-m', '755', join(deploy, 'servermin-privileged'), join(SYSTEM_ROOT, 'usr/lib/servermin/servermin-privileged')], { check: false });
    unit = installUnit(deploy);
  }
  restoreDatabase(join(STATE, `pre-update-${fromVersion}`));
  run(SYSTEMCTL, ['start', unit], { check: false });
  // A Manager on this server runs from the same program directory: put it on the restored code too.
  run(SYSTEMCTL, ['try-restart', 'servermin-manager.service'], { check: false });
  await waitHealthy(fromVersion);
}

async function apply(manifestFile, signatureFile, archiveFile) {
  const startedAt = new Date().toISOString();
  writeStatus({ state: 'verifying', startedAt, finishedAt: null, error: null, reason: null, from: currentVersion(), to: null, log: LOG_FILE });
  rmSync(LOG_FILE, { force: true });
  let from = currentVersion();
  let to = null;
  let installStarted = false;
  try {
    const checked = verifyRelease(manifestFile, signatureFile, archiveFile);
    from = checked.from;
    to = checked.manifest.version;
    log(`Verified signed release ${to} (installed: ${from})`);
    writeStatus({ state: 'installing', from, to });
    const root = extract(archiveFile, to);
    stopAgent();
    snapshotDatabase(from);
    installStarted = true;
    run('bash', [join(root, 'install.sh')], { timeout: 600_000 });
    writeStatus({ state: 'checking' });
    await waitHealthy(to);
    rmSync(join(STATE, 'staging'), { recursive: true, force: true });
    for (const f of [manifestFile, signatureFile, archiveFile]) rmSync(f, { force: true });
    log(`Updated ${from} → ${to}`);
    writeStatus({ state: 'succeeded', finishedAt: new Date().toISOString() });
  } catch (e) {
    const message = e instanceof UpdateError ? e.message : `Unexpected error: ${e?.message ?? e}`;
    log(`Update failed: ${message}`);
    if (!installStarted) {
      writeStatus({ state: 'failed', error: message, finishedAt: new Date().toISOString() });
      process.exitCode = 1;
      return;
    }
    try {
      await restorePrevious(from, message);
      writeStatus({ state: 'rolled-back', error: message, finishedAt: new Date().toISOString() });
    } catch (rollbackError) {
      writeStatus({ state: 'failed', error: `${message}; rollback also failed: ${rollbackError.message}`, finishedAt: new Date().toISOString() });
    }
    process.exitCode = 1;
  }
}

async function rollback() {
  const current = currentVersion();
  const previousVersion = existsSync(`${APP}.previous/VERSION`) ? readFileSync(`${APP}.previous/VERSION`, 'utf8').trim() : null;
  if (!previousVersion) {
    writeStatus({ state: 'failed', error: 'There is no previous version to roll back to', finishedAt: new Date().toISOString() });
    process.exitCode = 1;
    return;
  }
  writeStatus({ state: 'rolling-back', from: current, to: previousVersion, startedAt: new Date().toISOString(), finishedAt: null, error: null });
  try {
    await restorePrevious(previousVersion, `Rollback from ${current} requested`);
    writeStatus({ state: 'rolled-back', reason: 'requested', finishedAt: new Date().toISOString() });
  } catch (e) {
    writeStatus({ state: 'failed', error: `Rollback failed: ${e.message}`, finishedAt: new Date().toISOString() });
    process.exitCode = 1;
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === 'apply' && args.length === 3) await apply(...args);
else if (command === 'rollback') await rollback();
else if (command === 'status') process.stdout.write(JSON.stringify(readStatus(), null, 2) + '\n');
else {
  process.stderr.write('usage: servermin-update apply <release.json> <release.json.sig> <archive> | rollback | status\n');
  process.exitCode = 2;
}
