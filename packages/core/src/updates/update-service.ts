import { createHash, createPublicKey, verify } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { compareVersions, isValidVersion, satisfies } from '@servermin/sdk';
import type { Platform } from '../platform';
import { CORE_VERSION } from '../version';

/** Signed release manifest written by tools/package.mjs (format 1). */
export interface ReleaseManifest {
  format: 1;
  version: string;
  createdAt: string;
  signingKey: string | null;
  core: Record<string, { file: string; sha256: string; size: number; nodeBundled?: boolean }>;
  modules: Record<string, { version: string; coreVersion: string; file: string; sha256: string; size: number }>;
}

export interface UpdateSettings {
  /** Install new releases automatically in the maintenance window. */
  autoInstall: boolean;
  /** Start of the one-hour maintenance window, local time (HH:MM). */
  window: string;
}

export interface ApplyStatus {
  state: 'verifying' | 'installing' | 'checking' | 'succeeded' | 'rolling-back' | 'rolled-back' | 'failed';
  from?: string;
  to?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
  updatedAt?: string;
  error?: string | null;
  reason?: string | null;
}

interface Available {
  version: string;
  name: string;
  notes: string;
  url: string;
  publishedAt: string;
  manifest: ReleaseManifest;
  /** Download URLs of the release assets, by file name. */
  assets: Record<string, string>;
  manifestBytes: string;
  signature: string;
}

interface StoredState {
  checkedAt: string | null;
  error: string | null;
  available: Available | null;
  notifiedVersion: string | null;
  announcedFinish: string | null;
  autoAttempted: string | null;
}

const KV_STATE = 'updates.state';
const KV_SETTINGS = 'updates.settings';
const DEFAULT_SETTINGS: UpdateSettings = { autoInstall: false, window: '03:00' };
const MAX_MANIFEST = 1024 * 1024;
const MAX_ARCHIVE = 512 * 1024 * 1024;

export class UpdateError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export const platformKey = () => `linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;

/** Verifies a manifest's Ed25519 signature with the installation's public key and parses it. */
export function verifyManifest(bytes: string | Buffer, signatureBase64: string, publicKeyPem: string): ReleaseManifest {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const signature = Buffer.from(signatureBase64.trim(), 'base64');
  let ok = false;
  try {
    ok = verify(null, data, createPublicKey(publicKeyPem), signature);
  } catch {
    ok = false;
  }
  if (!ok) throw new UpdateError('The release signature is not valid for this installation\'s signing key', 422);
  const manifest = JSON.parse(data.toString('utf8')) as ReleaseManifest;
  if (manifest.format !== 1 || !isValidVersion(manifest.version ?? '')) throw new UpdateError('Unsupported release manifest', 422);
  return manifest;
}

/**
 * Updates without rebuilding (§ operations): checks GitHub Releases for a newer signed release,
 * downloads and verifies it, and hands the install to the root updater through the privilege
 * helper. Module packs from the same release can be installed on their own.
 *
 * Nothing downloaded is trusted until the signature over release.json verifies with the public
 * key shipped in the installed release; the root updater checks everything again.
 */
export class UpdateService {
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<(state: ReturnType<UpdateService['state']>) => void>();
  private busy: Promise<unknown> | null = null;
  private log;

  constructor(private readonly p: Platform) {
    this.log = p.logs.logger('updates');
  }

  private get cfg() {
    return this.p.config.updates;
  }
  get keyFile() {
    return join(this.p.config.paths.app, 'release-signing.pub');
  }
  get downloadDir() {
    return join(this.p.config.paths.tmp, 'updates');
  }
  private get statusFile() {
    return join(this.p.config.paths.data, 'update-status.json');
  }

  start() {
    this.announceFinishedUpdate();
    void this.refreshBundledModules();
    if (!this.cfg.enabled) return;
    // Check a minute after start-up, then every ten minutes see whether a check or an automatic install is due.
    const first = setTimeout(() => void this.tick(), 60_000);
    first.unref();
    this.timer = setInterval(() => void this.tick(), 10 * 60_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Live state for the `platform.updates` channel. */
  subscribe(l: (state: ReturnType<UpdateService['state']>) => void) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }

  private emit() {
    if (!this.listeners.size) return;
    const state = this.state();
    for (const l of this.listeners) l(state);
  }

  // ── State ──────────────────────────────────────────────────────────────────────

  private stored(): StoredState {
    const row = this.p.db.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', [KV_STATE]);
    return { checkedAt: null, error: null, available: null, notifiedVersion: null, announcedFinish: null, autoAttempted: null, ...(row ? JSON.parse(row.value) : {}) };
  }

  private save(patch: Partial<StoredState>) {
    const next = { ...this.stored(), ...patch };
    this.p.db.run('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', [KV_STATE, JSON.stringify(next)]);
    this.emit();
    return next;
  }

  settings(): UpdateSettings {
    const row = this.p.db.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', [KV_SETTINGS]);
    return { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.value) : {}) };
  }

  updateSettings(patch: Partial<UpdateSettings>, user?: string): UpdateSettings {
    const next = { ...this.settings() };
    if (patch.autoInstall !== undefined) {
      if (typeof patch.autoInstall !== 'boolean') throw new UpdateError('autoInstall must be true or false');
      next.autoInstall = patch.autoInstall;
    }
    if (patch.window !== undefined) {
      if (typeof patch.window !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.window)) throw new UpdateError('window must be HH:MM (24-hour)');
      next.window = patch.window;
    }
    this.p.db.run('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', [KV_SETTINGS, JSON.stringify(next)]);
    this.p.audit.record({ user, action: 'updates.settings', result: 'success', metadata: { ...next } });
    this.emit();
    return next;
  }

  applyStatus(): ApplyStatus | null {
    try {
      return JSON.parse(readFileSync(this.statusFile, 'utf8')) as ApplyStatus;
    } catch {
      return null;
    }
  }

  /** Why this installation cannot install core updates by itself, or null when it can. */
  blocker(): string | null {
    if (!this.cfg.enabled) return 'Updates are turned off in the configuration (updates.enabled)';
    if (!existsSync(this.keyFile)) return 'This installation has no release signing key; it was built without one. Install a signed release once with install.sh';
    if (this.p.config.privileged.mode === 'disabled') return 'Privileged operations are disabled on this server';
    return null;
  }

  state() {
    const s = this.stored();
    const status = this.applyStatus();
    const available = s.available && compareVersions(s.available.version, CORE_VERSION) > 0 ? s.available : null;
    const installed = new Map(this.p.modules.list().map((m) => [m.id, m]));
    const moduleUpdates = Object.entries(s.available?.manifest.modules ?? {})
      .filter(([id, m]) => installed.has(id) && compareVersions(m.version, installed.get(id)!.version) > 0)
      .map(([id, m]) => ({
        id,
        name: installed.get(id)!.name,
        installed: installed.get(id)!.version,
        available: m.version,
        compatible: satisfies(CORE_VERSION, m.coreVersion),
      }));
    return {
      currentVersion: CORE_VERSION,
      repository: this.cfg.repository,
      enabled: this.cfg.enabled,
      blocker: this.blocker(),
      checkedAt: s.checkedAt,
      error: s.error,
      available: available && {
        version: available.version,
        name: available.name,
        notes: available.notes,
        url: available.url,
        publishedAt: available.publishedAt,
        hasBuild: !!available.manifest.core[platformKey()],
      },
      moduleUpdates,
      previousVersion: this.previousVersion(),
      applying: !!status && ['verifying', 'installing', 'checking', 'rolling-back'].includes(status.state),
      lastResult: status,
      settings: this.settings(),
      simulated: this.p.config.privileged.mode === 'simulate',
    };
  }

  private previousVersion(): string | null {
    try {
      return readFileSync(`${this.p.config.paths.app}.previous/VERSION`, 'utf8').trim() || null;
    } catch {
      return null;
    }
  }

  // ── Check ──────────────────────────────────────────────────────────────────────

  private async get(url: string, accept = 'application/octet-stream') {
    const res = await fetch(url, { headers: { accept, 'user-agent': `servermin/${CORE_VERSION}` }, redirect: 'follow', signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new UpdateError(`${new URL(url).host} answered ${res.status} ${res.statusText}`.trim(), 502);
    return res;
  }

  private async text(url: string, limit: number) {
    const res = await this.get(url);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > limit) throw new UpdateError(`${url} is larger than expected`, 502);
    return body.toString('utf8');
  }

  /** Looks for a newer release. Notifies once per new version. */
  check(user?: string) {
    return this.exclusive(async () => {
      if (!this.cfg.enabled) throw new UpdateError('Updates are turned off in the configuration (updates.enabled)', 403);
      if (!existsSync(this.keyFile)) throw new UpdateError(this.blocker()!, 409);
      try {
        const res = await this.get(`${this.cfg.apiBase.replace(/\/$/, '')}/repos/${this.cfg.repository}/releases/latest`, 'application/vnd.github+json');
        const release = (await res.json()) as { tag_name: string; name?: string; body?: string; html_url: string; published_at: string; assets: { name: string; browser_download_url: string }[] };
        const assets = Object.fromEntries((release.assets ?? []).map((a) => [a.name, a.browser_download_url]));
        if (!assets['release.json'] || !assets['release.json.sig']) throw new UpdateError(`Release ${release.tag_name} has no signed release.json`, 502);
        const manifestBytes = await this.text(assets['release.json'], MAX_MANIFEST);
        const signature = await this.text(assets['release.json.sig'], 4096);
        const manifest = verifyManifest(manifestBytes, signature, readFileSync(this.keyFile, 'utf8'));
        if (`v${manifest.version}` !== release.tag_name) throw new UpdateError(`Release ${release.tag_name} contains a manifest for ${manifest.version}`, 502);
        const available: Available = {
          version: manifest.version,
          name: release.name || release.tag_name,
          notes: (release.body ?? '').slice(0, 20_000),
          url: release.html_url,
          publishedAt: release.published_at,
          manifest,
          assets,
          manifestBytes,
          signature,
        };
        const previous = this.stored();
        const isNew = compareVersions(manifest.version, CORE_VERSION) > 0;
        this.save({ checkedAt: new Date().toISOString(), error: null, available, notifiedVersion: isNew ? manifest.version : previous.notifiedVersion });
        if (isNew && previous.notifiedVersion !== manifest.version) {
          this.log.info(`Server Control ${manifest.version} is available (installed: ${CORE_VERSION})`);
          this.p.notifications.notify({
            title: `Server Control ${manifest.version} is available`,
            message: this.settings().autoInstall ? `It will be installed automatically at ${this.settings().window}. Open Settings → Updates to install it now.` : 'Open Settings → Updates to install it.',
            tone: 'information',
            permission: 'platform.update',
          });
        }
        if (user) this.p.audit.record({ user, action: 'updates.check', result: 'success', metadata: { latest: manifest.version } });
        return this.state();
      } catch (e) {
        const message = (e as Error).message;
        this.save({ checkedAt: new Date().toISOString(), error: message });
        this.log.warn(`Update check failed: ${message}`);
        if (user) this.p.audit.record({ user, action: 'updates.check', result: 'failure', metadata: { error: message } });
        throw e instanceof UpdateError ? e : new UpdateError(`Update check failed: ${message}`, 502);
      }
    });
  }

  // ── Download ───────────────────────────────────────────────────────────────────

  /** Downloads a release asset and checks its size and checksum against the signed manifest. */
  private async download(available: Available, entry: { file: string; sha256: string; size: number }) {
    const url = available.assets[entry.file];
    if (!url) throw new UpdateError(`Release ${available.version} is missing ${entry.file}`, 502);
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(entry.file)) throw new UpdateError(`Unexpected file name ${entry.file}`, 502);
    if (entry.size > MAX_ARCHIVE) throw new UpdateError(`${entry.file} is too large`, 502);
    await mkdir(this.downloadDir, { recursive: true });
    const file = join(this.downloadDir, entry.file);
    const res = await this.get(url);
    if (!res.body) throw new UpdateError(`Empty download for ${entry.file}`, 502);
    const hash = createHash('sha256');
    let size = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.length;
        if (size > entry.size) throw new UpdateError(`${entry.file} is larger than the signed manifest says`, 502);
        hash.update(chunk);
        controller.enqueue(chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body.pipeThrough(counter) as never), createWriteStream(file, { mode: 0o644 }));
    if (size !== entry.size || hash.digest('hex') !== entry.sha256) {
      await rm(file, { force: true });
      throw new UpdateError(`${entry.file} does not match the checksum in the signed manifest`, 502);
    }
    return file;
  }

  private async clearDownloads() {
    if (!existsSync(this.downloadDir)) return;
    for (const f of await readdir(this.downloadDir)) await rm(join(this.downloadDir, f), { recursive: true, force: true });
  }

  // ── Apply ──────────────────────────────────────────────────────────────────────

  /** Downloads the core release for this machine and starts the root updater. The server restarts. */
  apply(user?: string, opts: { automatic?: boolean } = {}) {
    return this.exclusive(async () => {
      const blocker = this.blocker();
      if (blocker) throw new UpdateError(blocker, 409);
      const status = this.applyStatus();
      if (status && ['verifying', 'installing', 'checking', 'rolling-back'].includes(status.state) && Date.now() - Date.parse(status.updatedAt ?? '') < 15 * 60_000) {
        throw new UpdateError('An update is already in progress', 409);
      }
      const available = this.stored().available;
      if (!available || compareVersions(available.version, CORE_VERSION) <= 0) throw new UpdateError('No newer release is known; check for updates first', 409);
      // The stored manifest was verified when it was fetched; verify again in case the database was altered.
      verifyManifest(available.manifestBytes, available.signature, readFileSync(this.keyFile, 'utf8'));
      const entry = available.manifest.core[platformKey()];
      if (!entry) throw new UpdateError(`Release ${available.version} has no build for ${platformKey()}`, 409);
      await this.clearDownloads();
      this.log.info(`Downloading Server Control ${available.version}`);
      const archive = await this.download(available, entry);
      const manifest = join(this.downloadDir, 'release.json');
      const signature = join(this.downloadDir, 'release.json.sig');
      await writeFile(manifest, available.manifestBytes, { mode: 0o644 });
      await writeFile(signature, available.signature, { mode: 0o644 });
      const actor = user ?? 'system:auto-update';
      const result = await this.p.processes.privileged('core', ['platform.update'], 'platform.update', { manifest, signature, archive }, { confirmed: true, user: actor });
      if (result.exitCode !== 0) throw new UpdateError(`The update could not start: ${result.stderr.trim() || `exit ${result.exitCode}`}`, 500);
      this.log.info(`Installing Server Control ${available.version}${opts.automatic ? ' (automatic)' : ''}; the server will restart`);
      this.p.audit.record({ user: actor, action: 'updates.apply', target: available.version, result: 'success', metadata: { from: CORE_VERSION, automatic: !!opts.automatic } });
      return { started: true, version: available.version, simulated: this.p.config.privileged.mode === 'simulate' };
    });
  }

  rollback(user?: string) {
    return this.exclusive(async () => {
      const previous = this.previousVersion();
      if (!previous) throw new UpdateError('There is no previous version to roll back to', 409);
      const result = await this.p.processes.privileged('core', ['platform.rollback'], 'platform.rollback', {}, { confirmed: true, user });
      if (result.exitCode !== 0) throw new UpdateError(`The rollback could not start: ${result.stderr.trim() || `exit ${result.exitCode}`}`, 500);
      this.p.audit.record({ user, action: 'updates.rollback', target: previous, result: 'success', metadata: { from: CORE_VERSION } });
      return { started: true, version: previous };
    });
  }

  /** Installs one module pack from the latest checked release (no restart of the core). */
  updateModule(id: string, user?: string) {
    return this.exclusive(async () => {
      const available = this.stored().available;
      const entry = available?.manifest.modules[id];
      if (!available || !entry) throw new UpdateError(`The latest release has no package for ${id}`, 404);
      verifyManifest(available.manifestBytes, available.signature, readFileSync(this.keyFile, 'utf8'));
      if (!satisfies(CORE_VERSION, entry.coreVersion)) throw new UpdateError(`${id} ${entry.version} needs Server Control ${entry.coreVersion}; update Server Control first`, 409);
      const file = await this.download(available, entry);
      try {
        return await this.p.modules.update(id, { type: 'archive', path: file, sha256: entry.sha256 }, user);
      } finally {
        await rm(file, { force: true });
        this.emit();
      }
    });
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new UpdateError('Another update operation is running', 409);
    const run = fn();
    this.busy = run;
    try {
      return await run;
    } finally {
      this.busy = null;
    }
  }

  // ── Scheduling ─────────────────────────────────────────────────────────────────

  /** Is `now` inside the hour that starts at `window` (local time)? */
  static inWindow(window: string, now = new Date()) {
    const [h, m] = window.split(':').map(Number);
    const start = h * 60 + m;
    const minute = now.getHours() * 60 + now.getMinutes();
    return (minute - start + 1440) % 1440 < 60;
  }

  async tick(now = new Date()) {
    if (this.busy) return;
    const s = this.stored();
    const due = !s.checkedAt || now.getTime() - Date.parse(s.checkedAt) >= this.cfg.checkIntervalHours * 3_600_000;
    if (due) await this.check().catch(() => undefined);
    const settings = this.settings();
    const available = this.stored().available;
    if (!settings.autoInstall || !available || compareVersions(available.version, CORE_VERSION) <= 0) return;
    if (!UpdateService.inWindow(settings.window, now)) return;
    // One automatic attempt per version, so a release that rolls back is not retried every night.
    if (this.stored().autoAttempted === available.version) return;
    this.save({ autoAttempted: available.version });
    try {
      for (const m of this.state().moduleUpdates) if (m.compatible) await this.updateModule(m.id, 'system:auto-update').catch((e) => this.log.warn(`Automatic update of ${m.id} failed: ${(e as Error).message}`));
      await this.apply(undefined, { automatic: true });
    } catch (e) {
      this.log.error(`Automatic update to ${available.version} failed: ${(e as Error).message}`);
      this.p.notifications.notify({ title: `Automatic update to ${available.version} failed`, message: (e as Error).message, tone: 'error', permission: 'platform.update' });
    }
  }

  // ── After a restart ────────────────────────────────────────────────────────────

  /** Reports the outcome of an update or rollback the root updater finished while the core was down. */
  private announceFinishedUpdate() {
    const status = this.applyStatus();
    if (!status?.finishedAt || this.stored().announcedFinish === status.finishedAt) return;
    this.save({ announcedFinish: status.finishedAt });
    const user = 'system:updater';
    if (status.state === 'succeeded') {
      this.log.info(`Updated from ${status.from} to ${status.to}`);
      this.p.notifications.notify({ title: `Server Control was updated to ${status.to}`, message: `Previous version: ${status.from}. It can be restored from Settings → Updates.`, tone: 'success', permission: 'platform.update' });
      this.p.audit.record({ user, action: 'updates.installed', target: status.to ?? undefined, result: 'success', metadata: { from: status.from } });
    } else if (status.state === 'rolled-back') {
      const requested = status.reason === 'requested';
      this.log.warn(requested ? `Rolled back to ${CORE_VERSION}` : `The update to ${status.to} failed and was rolled back: ${status.error}`);
      this.p.notifications.notify({
        title: requested ? `Server Control was rolled back to ${CORE_VERSION}` : `The update to ${status.to} failed and was rolled back`,
        message: requested ? undefined : status.error ?? undefined,
        tone: requested ? 'information' : 'error',
        permission: 'platform.update',
      });
      this.p.audit.record({ user, action: 'updates.rolled-back', target: status.to ?? undefined, result: requested ? 'success' : 'failure', metadata: { error: status.error } });
    } else if (status.state === 'failed') {
      this.log.error(`The last update failed: ${status.error}`);
      this.p.notifications.notify({ title: 'An update failed', message: status.error ?? undefined, tone: 'error', permission: 'platform.update' });
      this.p.audit.record({ user, action: 'updates.failed', target: status.to ?? undefined, result: 'failure', metadata: { error: status.error } });
    }
  }

  /**
   * After a core update the release brings newer bundled modules. Installed copies that came from
   * the bundled directory are updated to them, through the regular verified module pipeline.
   */
  async refreshBundledModules() {
    const bundledDirs = this.p.config.modules.preinstall;
    for (const m of this.p.modules.list()) {
      if (m.sourceType !== 'directory') continue;
      for (const dir of bundledDirs) {
        const manifestFile = join(dir, m.id, 'module.json');
        if (!existsSync(manifestFile)) continue;
        try {
          const bundled = JSON.parse(readFileSync(manifestFile, 'utf8')) as { version: string };
          if (compareVersions(bundled.version, m.version) <= 0) continue;
          this.log.info(`Updating bundled module ${m.id} ${m.version} → ${bundled.version}`);
          await this.p.modules.update(m.id, { type: 'directory', path: join(dir, m.id) }, 'system:updater');
        } catch (e) {
          this.log.error(`Updating bundled module ${m.id} failed: ${(e as Error).message}`);
        }
      }
    }
  }
}
