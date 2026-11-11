import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeConfig } from '../../packages/core/src/index';
import { Manager, defaultManagerConfig, type ManagerConfig } from '../../packages/manager/src/index';

export interface TestManager {
  manager: Manager;
  url: string;
  dir: string;
  cookie: string;
  api<T = any>(method: string, path: string, body?: unknown, opts?: { cookie?: string; headers?: Record<string, string> }): Promise<{ status: number; body: T; setCookie: string | null }>;
  restart(): Promise<void>;
  stop(): Promise<void>;
}

const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const write = process.stdout.write;
  process.stdout.write = (() => true) as any;
  try {
    return await fn();
  } finally {
    process.stdout.write = write;
  }
};

/** Starts a real Manager (HTTP, WebSocket, SQLite) in a temporary directory and creates its administrator. */
export async function startManager(opts: { setup?: boolean; config?: Record<string, unknown> } = {}): Promise<TestManager> {
  const dir = mkdtempSync(join(tmpdir(), 'servermin-mgr-'));
  const config: ManagerConfig = mergeConfig(mergeConfig(defaultManagerConfig(dir), { http: { host: '127.0.0.1', port: 0 }, logging: { level: 'DEBUG', stdout: false } }), (opts.config ?? {}) as any);
  let manager = await quietly(() => new Manager(config).start());
  const t: TestManager = {
    manager,
    url: `${config.http.tls ? 'https' : 'http'}://127.0.0.1:${manager.address!.port}`,
    dir,
    cookie: '',
    async api(method, path, body, o = {}) {
      const res = await fetch(t.url + path, {
        method,
        headers: { connection: 'close', 'x-servermin-request': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), cookie: o.cookie ?? t.cookie, ...o.headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      const setCookie = res.headers.get('set-cookie');
      if (setCookie && path.includes('/auth/') && o.cookie === undefined) t.cookie = setCookie.split(';')[0];
      // Paths outside /api answer in plain text.
      const json = (res.headers.get('content-type') ?? '').includes('application/json');
      return { status: res.status, body: text ? (json ? JSON.parse(text) : text) : undefined, setCookie };
    },
    async restart() {
      await manager.stop();
      // The same address, as after a real restart: agents find it again.
      config.http.port = Number(new URL(t.url).port);
      manager = await quietly(() => new Manager(config).start());
      t.manager = manager;
      t.url = `${config.http.tls ? 'https' : 'http'}://127.0.0.1:${manager.address!.port}`;
    },
    async stop() {
      await manager.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  if (opts.setup !== false) {
    const token = readFileSync(join(config.paths.data, 'setup-token'), 'utf8').trim();
    const r = await t.api('POST', '/api/v1/auth/setup', { setupToken: token, username: 'admin', password: 'test-password-1' });
    if (r.status !== 200) throw new Error(`setup failed: ${JSON.stringify(r.body)}`);
  }
  return t;
}

