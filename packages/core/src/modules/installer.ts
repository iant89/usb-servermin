import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { cp, lstat, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { validateManifest, type ModuleManifest } from '@servermin/sdk';
import { CORE_VERSION } from '../version';

export type InstallSource =
  | { type: 'directory'; path: string }
  /** Development only: the installed module points at the source directory (hot reload). */
  | { type: 'link'; path: string }
  | { type: 'archive'; path: string; sha256?: string }
  | { type: 'git'; url: string; ref?: string };

export interface StagedModule {
  manifest: ModuleManifest;
  /** Directory that holds the module (staging copy, or the source itself for links). */
  dir: string;
  /** Temporary directory to delete after the module was moved into place. */
  cleanup?: string;
  integrity: 'verified' | 'unverified';
  warnings: string[];
  source: InstallSource;
}

export class InstallError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface IntegrityFile {
  algorithm: 'sha256';
  files: Record<string, string>;
}

export async function sha256File(file: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej);
  });
}

async function walk(dir: string, base = dir, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, base, out);
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

/** Rejects symlinks and special files anywhere in a package (they could escape the module directory). */
async function assertPlainFiles(dir: string) {
  const bad: string[] = [];
  const visit = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      const st = await lstat(full);
      if (st.isSymbolicLink()) bad.push(relative(dir, full));
      else if (st.isDirectory()) await visit(full);
      else if (!st.isFile()) bad.push(relative(dir, full));
    }
  };
  await visit(dir);
  if (bad.length) throw new InstallError('Package contains links or special files', bad.map((b) => `Not allowed: ${b}`));
}

function run(cmd: string, args: string[], cwd?: string, timeoutMs = 120_000): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0' } });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d).length > 10_000 && (stderr = stderr.slice(-10_000)));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => (clearTimeout(timer), reject(e)));
    child.on('close', (code) => (clearTimeout(timer), resolvePromise({ code, stderr })));
  });
}

/** Locate `module.json` at the root of a directory or inside a single top-level folder. */
async function findModuleRoot(dir: string): Promise<string> {
  if (existsSync(join(dir, 'module.json'))) return dir;
  const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory());
  if (entries.length === 1 && existsSync(join(dir, entries[0].name, 'module.json'))) return join(dir, entries[0].name);
  throw new InstallError('No module.json found in the package');
}

export async function readManifest(dir: string): Promise<ModuleManifest> {
  let raw: string;
  try {
    raw = await readFile(join(dir, 'module.json'), 'utf8');
  } catch {
    throw new InstallError(`No module.json in ${dir}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new InstallError(`module.json is not valid JSON: ${(e as Error).message}`);
  }
}

/** Validates manifest, compatibility and referenced files (§34). */
export async function checkModule(dir: string): Promise<{ manifest: ModuleManifest; warnings: string[] }> {
  const manifest = await readManifest(dir);
  const result = validateManifest(manifest, { coreVersion: CORE_VERSION });
  if (!result.valid) throw new InstallError(`Invalid manifest for ${manifest?.id ?? 'module'}`, result.errors);
  for (const [kind, rel] of [
    ['backend', manifest.backend?.entry],
    ['frontend', manifest.frontend?.entry],
    ['style', manifest.frontend?.style],
  ] as const) {
    if (!rel) continue;
    const full = resolve(dir, rel);
    if (!full.startsWith(resolve(dir) + sep)) throw new InstallError(`${kind} entry escapes the module directory`);
    if (!existsSync(full) || !(await stat(full)).isFile()) throw new InstallError(`${kind} entry "${rel}" does not exist. Was the module built?`);
  }
  return { manifest, warnings: result.warnings };
}

/** Verifies `integrity.json`. Returns false when the package has none. */
export async function verifyIntegrity(dir: string, strict: boolean): Promise<boolean> {
  const file = join(dir, 'integrity.json');
  if (!existsSync(file)) {
    if (strict) throw new InstallError('Package has no integrity.json; build it with `npm run build` / tools/build-module.mjs --pack');
    return false;
  }
  let integrity: IntegrityFile;
  try {
    integrity = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new InstallError('integrity.json is not valid JSON');
  }
  if (integrity.algorithm !== 'sha256' || typeof integrity.files !== 'object') throw new InstallError('integrity.json has an unsupported format');
  const problems: string[] = [];
  for (const [rel, expected] of Object.entries(integrity.files)) {
    const full = resolve(dir, rel);
    if (!full.startsWith(resolve(dir) + sep)) {
      problems.push(`Invalid path ${rel}`);
      continue;
    }
    if (!existsSync(full)) problems.push(`Missing file ${rel}`);
    else if ((await sha256File(full)) !== expected) problems.push(`Checksum mismatch: ${rel}`);
  }
  if (strict) {
    const listed = new Set([...Object.keys(integrity.files), 'integrity.json']);
    for (const f of await walk(dir)) if (!listed.has(f)) problems.push(`Unlisted file ${f}`);
  }
  if (problems.length) throw new InstallError('Package integrity check failed', problems);
  return true;
}

/** Files copied from a source directory when it has no integrity list. */
async function copyModuleFiles(src: string, dest: string, manifest: ModuleManifest) {
  await mkdir(dest, { recursive: true });
  const integrity = join(src, 'integrity.json');
  if (existsSync(integrity)) {
    const files = Object.keys((JSON.parse(await readFile(integrity, 'utf8')) as IntegrityFile).files ?? {});
    for (const f of [...files, 'integrity.json']) {
      if (!/^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9_.@+/-]+$/.test(f)) throw new InstallError(`integrity.json lists an invalid path: ${f}`);
      if (!existsSync(join(src, f))) throw new InstallError(`integrity.json lists a missing file: ${f}`);
      await mkdir(dirname(join(dest, f)), { recursive: true });
      await cp(join(src, f), join(dest, f));
    }
    return;
  }
  const tops = new Set(['module.json', 'README.md', 'LICENSE']);
  for (const e of [manifest.backend?.entry, manifest.frontend?.entry, manifest.frontend?.style]) if (e) tops.add(e.split('/')[0]);
  for (const t of tops) if (existsSync(join(src, t))) await cp(join(src, t), join(dest, t), { recursive: true, dereference: false });
}

export class ModuleInstaller {
  constructor(private readonly tmpDir: string) {}

  private async stagingDir() {
    const dir = join(this.tmpDir, `staging-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /** Acquire and validate a module without installing it. */
  async stage(source: InstallSource): Promise<StagedModule> {
    switch (source.type) {
      case 'link': {
        const dir = resolve(source.path);
        const { manifest, warnings } = await checkModule(dir);
        return { manifest, dir, integrity: 'unverified', warnings: [...warnings, 'Linked development install: files are not copied or verified'], source };
      }
      case 'directory': {
        const src = resolve(source.path);
        if (!existsSync(src) || !(await stat(src)).isDirectory()) throw new InstallError(`Directory not found: ${source.path}`);
        const { manifest } = await checkModule(src);
        const staging = await this.stagingDir();
        try {
          const dir = join(staging, 'module');
          await copyModuleFiles(src, dir, manifest);
          await assertPlainFiles(dir);
          const verified = await verifyIntegrity(dir, false);
          const checked = await checkModule(dir);
          const warnings = [...checked.warnings];
          if (!verified) warnings.push('Module has no integrity.json; its files were not verified');
          return { manifest: checked.manifest, dir, cleanup: staging, integrity: verified ? 'verified' : 'unverified', warnings, source };
        } catch (e) {
          await rm(staging, { recursive: true, force: true });
          throw e;
        }
      }
      case 'archive': {
        const staging = await this.stagingDir();
        try {
          if (source.sha256) {
            const actual = await sha256File(source.path);
            if (actual !== source.sha256.toLowerCase()) throw new InstallError('Archive checksum does not match', [`Expected ${source.sha256}`, `Actual ${actual}`]);
          }
          const extract = join(staging, 'extract');
          await mkdir(extract);
          // GNU tar refuses absolute paths and `..` members by default; links are rejected afterwards.
          const r = await run('tar', ['-xzf', source.path, '-C', extract, '--no-same-owner', '--no-same-permissions', '--no-overwrite-dir']);
          if (r.code !== 0) throw new InstallError('The archive could not be extracted', [r.stderr.trim()]);
          await assertPlainFiles(extract);
          const dir = await findModuleRoot(extract);
          await verifyIntegrity(dir, true);
          const { manifest, warnings } = await checkModule(dir);
          return { manifest, dir, cleanup: staging, integrity: 'verified', warnings, source };
        } catch (e) {
          await rm(staging, { recursive: true, force: true });
          throw e;
        }
      }
      case 'git': {
        if (!/^(https:\/\/|git@|ssh:\/\/)[^\s]+$/.test(source.url)) throw new InstallError('Use an https:// or ssh git URL');
        if (source.ref && !/^[A-Za-z0-9._/-]{1,100}$/.test(source.ref)) throw new InstallError('Invalid git ref');
        const staging = await this.stagingDir();
        try {
          const clone = join(staging, 'clone');
          const args = ['clone', '--depth', '1', ...(source.ref ? ['--branch', source.ref] : []), '--', source.url, clone];
          const r = await run('git', args, undefined, 300_000);
          if (r.code !== 0) throw new InstallError('git clone failed', [r.stderr.trim()]);
          await rm(join(clone, '.git'), { recursive: true, force: true });
          const root = await findModuleRoot(clone);
          const { manifest } = await checkModule(root);
          const dir = join(staging, 'module');
          await copyModuleFiles(root, dir, manifest);
          await assertPlainFiles(dir);
          const verified = await verifyIntegrity(dir, false);
          const checked = await checkModule(dir);
          return { manifest: checked.manifest, dir, cleanup: staging, integrity: verified ? 'verified' : 'unverified', warnings: verified ? checked.warnings : [...checked.warnings, 'Repository has no integrity.json'], source };
        } catch (e) {
          await rm(staging, { recursive: true, force: true });
          throw e;
        }
      }
      default:
        throw new InstallError('Unsupported installation source');
    }
  }

  /** Lists modules in local source directories (DISCOVERED, §12). */
  async discover(dirs: string[]): Promise<{ path: string; manifest?: ModuleManifest; errors: string[] }[]> {
    const out: { path: string; manifest?: ModuleManifest; errors: string[] }[] = [];
    for (const base of dirs) {
      if (!existsSync(base)) continue;
      for (const e of await readdir(base, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const path = join(base, e.name);
        if (!existsSync(join(path, 'module.json'))) continue;
        try {
          const { manifest } = await checkModule(path);
          out.push({ path, manifest, errors: [] });
        } catch (err) {
          const manifest = await readManifest(path).catch(() => undefined);
          out.push({ path, manifest, errors: [(err as Error).message, ...((err as InstallError).problems ?? [])] });
        }
      }
    }
    return out;
  }
}
