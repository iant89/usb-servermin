import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Platform, defaultConfig, mergeConfig, type CoreConfig } from '../../packages/core/src/index';

export const ROOT = resolve(import.meta.dirname, '../..');
export const fixture = (name: string) => join(ROOT, 'tests/fixtures', name);
export const example = (name: string) => join(ROOT, 'examples', name);

export interface TestServer {
  platform: Platform;
  url: string;
  dir: string;
  cookie: string;
  api<T = any>(method: string, path: string, body?: unknown, opts?: { cookie?: string; headers?: Record<string, string> }): Promise<{ status: number; body: T }>;
  stop(): Promise<void>;
}

/** Starts a real platform (HTTP, workers, SQLite) in a temporary directory and signs in as admin. */
export async function startServer(overrides: Partial<CoreConfig['modules']> = {}, opts: { login?: boolean; storageWriteDelayMs?: number } = {}): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'servermin-it-'));
  const base = defaultConfig(dir);
  const config = mergeConfig(base, {
    http: { host: '127.0.0.1', port: 0 },
    paths: { shell: join(dir, 'no-shell') },
    modules: { preinstall: [], sources: [join(ROOT, 'examples'), join(ROOT, 'tests/fixtures')], lifecycleTimeoutMs: 5000, healthIntervalMs: 60_000, ...overrides },
    privileged: { mode: 'simulate' },
    logging: { level: 'DEBUG', stdout: false },
  } as any);
  const platform = new Platform(config, { workerScript: join(ROOT, '.vitest-tmp/core/module-host.js'), storageScript: join(ROOT, '.vitest-tmp/core/storage-host.js'), storageWriteDelayMs: opts.storageWriteDelayMs });
  const quiet = process.stdout.write;
  process.stdout.write = (() => true) as any;
  try {
    await platform.start();
  } finally {
    process.stdout.write = quiet;
  }
  const url = `http://127.0.0.1:${platform.address!.port}`;
  const server: TestServer = {
    platform,
    url,
    dir,
    cookie: '',
    async api(method, path, body, o = {}) {
      const res = await fetch(url + path, {
        method,
        headers: { 'x-servermin-request': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), cookie: o.cookie ?? server.cookie, ...o.headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      const setCookie = res.headers.get('set-cookie');
      if (setCookie && path.includes('/auth/') && o.cookie === undefined) server.cookie = setCookie.split(';')[0];
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    },
    async stop() {
      await platform.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  if (opts.login !== false) {
    const token = readFileSync(join(config.paths.data, 'setup-token'), 'utf8').trim();
    const r = await server.api('POST', '/api/v1/auth/setup', { setupToken: token, username: 'admin', password: 'test-password-1' });
    if (r.status !== 200) throw new Error(`setup failed: ${JSON.stringify(r.body)}`);
  }
  return server;
}

export async function waitFor<T>(fn: () => T | Promise<T>, check: (v: T) => boolean, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (check(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Condition not met within ${timeoutMs} ms (last: ${JSON.stringify(v)})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
