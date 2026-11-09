import { describe, expect, it } from 'vitest';
import { StorageActivity, type StorageStatus } from '../src/storage/storage-client';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const after = <T,>(ms: number, v?: T) => new Promise<T>((r) => setTimeout(() => r(v as T), ms));

describe('storage activity (saving indicator)', () => {
  it('never reports busy for writes faster than the threshold', async () => {
    const a = new StorageActivity(80, 100);
    const seen: StorageStatus[] = [];
    a.subscribe((s) => seen.push(s));
    await Promise.all([a.track('logs', after(10)), a.track('monitoring', after(30))]);
    await wait(150);
    expect(seen.filter((s) => s.busy)).toEqual([]);
    expect(a.status()).toMatchObject({ busy: false, pending: 0 });
  });

  it('reports busy while a write lags, names its source, and stays visible briefly', async () => {
    const a = new StorageActivity(50, 300);
    const seen: StorageStatus[] = [];
    a.subscribe((s) => seen.push(s));
    const started = Date.now();
    const slow = a.track('monitoring', after(120));
    void a.track('logs', after(20));
    await wait(80);
    expect(a.status()).toMatchObject({ busy: true, pending: 1, sources: ['monitoring'] });
    await slow;
    await wait(20);
    // Write finished at ~120 ms, but the indicator was shown at ~55 ms and stays at least 300 ms.
    expect(a.status().busy).toBe(true);
    await wait(320);
    expect(a.status()).toMatchObject({ busy: false, pending: 0 });
    const flips = seen.map((s) => s.busy).filter((b, i, all) => i === 0 || b !== all[i - 1]);
    expect(flips).toEqual([true, false]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  });

  it('counts failed writes as finished', async () => {
    const a = new StorageActivity(30, 0);
    await a.track('logs', Promise.reject(new Error('disk full'))).catch(() => undefined);
    await wait(60);
    expect(a.status()).toMatchObject({ busy: false, pending: 0 });
  });
});
