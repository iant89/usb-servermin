import { describe, expect, it } from 'vitest';
import { createTestContext } from '@servermin/sdk/testing';
import manifest from '../module.json';
import monitoring from '../src/backend/index';
import { HostSampler } from '../src/backend/sampler';

describe('host sampler', () => {
  it('reads host metrics from /proc and computes rates on the second sample', async () => {
    const s = new HostSampler();
    const first = await s.sample(Date.now() - 1000);
    expect(first['memory.usage']).toBeGreaterThan(0);
    expect(first['load.1']).toBeGreaterThanOrEqual(0);
    expect(first['cpu.usage']).toBeUndefined();
    await new Promise((r) => setTimeout(r, 250));
    const second = await s.sample(Date.now());
    expect(second['cpu.usage']).toBeGreaterThanOrEqual(0);
    expect(second['network.rx']).toBeGreaterThanOrEqual(0);
  });
});

describe('monitoring module', () => {
  it('stores samples, serves series and accepts metrics from other modules', async () => {
    const t = createTestContext(manifest as any);
    await t.start(monitoring);
    await new Promise((r) => setTimeout(r, 250));
    await t.tick();
    t.emit('docker.metrics', { metrics: [{ name: 'containers.running', value: 3, unit: 'count' }] }, 'docker');
    t.emit('network.metrics', { metrics: [{ name: 'rx.bytes', value: 1000, unit: 'bytes', counter: true }] }, 'network');
    await new Promise((r) => setTimeout(r, 1100));
    t.emit('network.metrics', { metrics: [{ name: 'rx.bytes', value: 3200, unit: 'bytes', counter: true }] }, 'network');
    await new Promise((r) => setTimeout(r, 50));
    const metrics = (await t.request<any[]>('GET', '/metrics')).body;
    expect(metrics.map((m) => m.name)).toEqual(expect.arrayContaining(['cpu.usage', 'memory.usage', 'docker.containers.running', 'network.rx.bytes']));
    expect(metrics.find((m) => m.name === 'network.rx.bytes')).toMatchObject({ unit: 'bytes/s', source: 'network' });
    const series = (await t.request<any>('GET', '/series', { query: { metrics: 'memory.usage,docker.containers.running', range: '15m' } })).body;
    expect(series.points.length).toBeGreaterThan(0);
    expect(series.points.some((p: any) => p['docker.containers.running'] === 3)).toBe(true);
    expect((await t.request('GET', '/series', { query: { metrics: 'x', range: '2y' } })).status).toBe(400);
    await t.stop();
  });

  it('raises an alert after consecutive samples above the threshold', async () => {
    const t = createTestContext(manifest as any, { config: { memoryAlert: 1, alertAfterSamples: 2, cpuAlert: 0, diskAlert: 0 } });
    await t.start(monitoring);
    await t.tick();
    expect(t.notifications).toHaveLength(1);
    expect(t.notifications[0].title).toBe('Memory usage is high');
    await t.tick();
    expect(t.notifications).toHaveLength(1);
    await t.stop();
  });
});
