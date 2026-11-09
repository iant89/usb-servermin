import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { example, startServer, type TestServer } from './helpers';

/**
 * A USB 2.0 flash drive can take seconds per synced write. Every write on the storage thread is
 * delayed here to simulate that; the core's main thread must stay responsive regardless (§43).
 */
const DELAY = 1500;
let s: TestServer;

beforeAll(async () => {
  s = await startServer({ lifecycleTimeoutMs: 20_000 }, { storageWriteDelayMs: DELAY });
});
afterAll(() => s?.stop());

async function timed<T>(fn: () => Promise<T>) {
  const t = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t };
}

describe('slow storage media', () => {
  it('keeps the API responsive while a module waits on its database', async () => {
    // Installing the module runs its migration on the (slow) storage thread.
    const install = timed(() => s.api('POST', '/api/v1/platform/modules', { source: 'directory', path: example('hello') }));
    const samples: number[] = [];
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const h = await timed(() => s.api('GET', '/api/v1/health'));
      expect(h.value.status).toBe(200);
      samples.push(h.ms);
    }
    const done = await install;
    expect(done.value.body.module.state).toBe('ACTIVE');
    // The install itself had to wait for the slow disk…
    expect(done.ms).toBeGreaterThanOrEqual(DELAY);
    // …but the core answered every health request quickly in the meantime.
    expect(Math.max(...samples)).toBeLessThan(500);
  });

  it('module writes are slow, reads of other data are not', async () => {
    const write = timed(() => s.api('POST', '/api/v1/modules/hello/greeting', { name: 'Slow' }));
    const read = await timed(() => s.api('GET', '/api/v1/platform/modules'));
    expect(read.value.status).toBe(200);
    expect(read.ms).toBeLessThan(500);
    const w = await write;
    expect(w.value.status).toBe(200);
    expect(w.ms).toBeGreaterThanOrEqual(DELAY);
  });

  it('still persists logs and serves them', async () => {
    s.platform.logs.write({ level: 'WARN', source: 'test', message: 'written on slow media' });
    const logs = await s.api('GET', '/api/v1/logs?search=written%20on%20slow%20media');
    expect(logs.body.map((l: any) => l.message)).toContain('written on slow media');
  });
});
