import { HttpError, defineModule, type ModuleContext } from '@servermin/sdk';
import { HostSampler, RANGES, UNITS, round } from './sampler';

export default defineModule(() => {
  let ctx: ModuleContext;
  const sampler = new HostSampler();
  const units = new Map<string, string>(Object.entries(UNITS));
  const last = new Map<string, { value: number; at: number }>();
  const counters = new Map<string, { value: number; at: number }>();
  const breaches = new Map<string, number>();
  const alerting = new Set<string>();
  let stopSampling: (() => void) | null = null;

  async function store(at: number, values: Record<string, number>) {
    const ts = Math.floor(at / 1000);
    const entries = Object.entries(values).filter(([, v]) => Number.isFinite(v));
    if (!entries.length) return;
    await ctx.database.transaction(entries.map(([m, v]) => ({ sql: 'INSERT INTO samples (ts, metric, value) VALUES (?, ?, ?)', params: [ts, m, v] })));
    for (const [m, v] of entries) last.set(m, { value: v, at });
  }

  function checkAlerts(values: Record<string, number>) {
    const cfg = ctx.config.get();
    const rules: [string, string, number][] = [
      ['cpu.usage', 'CPU usage', Number(cfg.cpuAlert)],
      ['memory.usage', 'Memory usage', Number(cfg.memoryAlert)],
      ['disk.root.usage', 'Root disk usage', Number(cfg.diskAlert)],
    ];
    for (const [metric, label, threshold] of rules) {
      const v = values[metric];
      if (v === undefined || !threshold) continue;
      const n = v >= threshold ? (breaches.get(metric) ?? 0) + 1 : 0;
      breaches.set(metric, n);
      if (n >= Number(cfg.alertAfterSamples) && !alerting.has(metric)) {
        alerting.add(metric);
        ctx.notifications.notify({ title: `${label} is high`, message: `${label} has been at or above ${threshold}% (now ${v}%).`, tone: 'warning', permission: 'monitoring.read' });
        ctx.events.publish('monitoring.alert.raised', { metric, value: v, threshold });
      } else if (n === 0 && alerting.has(metric) && v < threshold - 5) {
        alerting.delete(metric);
        ctx.events.publish('monitoring.alert.cleared', { metric, value: v });
      }
    }
  }

  async function tick() {
    const at = Date.now();
    const values = await sampler.sample(at);
    await store(at, values);
    checkAlerts(values);
    if (ctx.channels.subscriberCount('live')) ctx.channels.broadcast('live', { at: new Date(at).toISOString(), values });
  }

  /** Metrics contributed by other modules through `<module>.metrics` events (§32.9). */
  async function contributed(source: string, metrics: unknown) {
    if (!Array.isArray(metrics)) return;
    const at = Date.now();
    const values: Record<string, number> = {};
    for (const m of metrics.slice(0, 100)) {
      if (!m || typeof m.name !== 'string' || !/^[a-z0-9_.-]{1,80}$/i.test(m.name) || typeof m.value !== 'number') continue;
      const key = `${source}.${m.name}`;
      if (typeof m.unit === 'string') units.set(key, m.counter ? `${m.unit}/s` : m.unit.slice(0, 20));
      if (m.counter) {
        const prev = counters.get(key);
        counters.set(key, { value: m.value, at });
        if (!prev || at <= prev.at || m.value < prev.value) continue;
        values[key] = round((m.value - prev.value) / ((at - prev.at) / 1000));
      } else values[key] = m.value;
    }
    await store(at, values);
  }

  return {
    async initialize(c) {
      ctx = c;
      await ctx.database.migrate([
        { version: 1, name: 'samples', sql: 'CREATE TABLE samples (ts INTEGER NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL); CREATE INDEX samples_metric_ts ON samples(metric, ts);' },
      ]);
      const R = { permission: 'monitoring.read' };

      ctx.http.get('/metrics', async () => {
        const rows = await ctx.database.all<{ metric: string; n: number; first: number }>('SELECT metric, COUNT(*) AS n, MIN(ts) AS first FROM samples GROUP BY metric ORDER BY metric');
        return rows.map((r) => ({ name: r.metric, unit: units.get(r.metric) ?? '', source: UNITS[r.metric] !== undefined ? 'host' : r.metric.split('.')[0], samples: r.n, since: new Date(r.first * 1000).toISOString(), last: last.get(r.metric)?.value ?? null }));
      }, R);

      ctx.http.get('/series', async (req) => {
        const range = RANGES[req.query.range ?? '1h'];
        if (!range) throw new HttpError(400, `range must be one of ${Object.keys(RANGES).join(', ')}`);
        const names = (req.query.metrics ?? '').split(',').filter((m) => /^[a-z0-9_.-]{1,120}$/i.test(m)).slice(0, 12);
        if (!names.length) throw new HttpError(400, 'metrics is required');
        const points = Math.min(Math.max(Number(req.query.points) || 240, 10), 1000);
        const bucket = Math.max(Math.ceil(range / points), Number(ctx.config.get().intervalSeconds));
        const from = Math.floor(Date.now() / 1000) - range;
        const rows = await ctx.database.all<{ b: number; metric: string; v: number; mx: number }>(
          `SELECT (ts / ${bucket}) * ${bucket} AS b, metric, AVG(value) AS v, MAX(value) AS mx FROM samples WHERE ts >= ? AND metric IN (${names.map(() => '?').join(',')}) GROUP BY b, metric ORDER BY b`,
          [from, ...names],
        );
        const byTime = new Map<number, Record<string, number | string>>();
        for (const r of rows) {
          const p = byTime.get(r.b) ?? { t: new Date(r.b * 1000).toISOString() };
          p[r.metric] = round(r.v);
          byTime.set(r.b, p);
        }
        return { range: req.query.range ?? '1h', bucketSeconds: bucket, units: Object.fromEntries(names.map((n) => [n, units.get(n) ?? ''])), points: [...byTime.values()] };
      }, R);

      ctx.http.get('/current', () => Object.fromEntries([...last].map(([k, v]) => [k, { value: v.value, unit: units.get(k) ?? '', at: new Date(v.at).toISOString() }])), R);
      ctx.http.get('/alerts', () => [...alerting].map((m) => ({ metric: m, value: last.get(m)?.value ?? null })), R);

      ctx.channels.handle('live', {});
      ctx.events.subscribe('*.metrics', (e) => {
        if (e.source === ctx.module.id) return;
        void contributed(e.source, (e.payload as { metrics?: unknown })?.metrics).catch((err) => ctx.logger.warn(`Could not store metrics from ${e.source}: ${err.message}`));
      });
      ctx.config.onChange((_, keys) => {
        if (keys.includes('intervalSeconds') && stopSampling) {
          stopSampling();
          stopSampling = ctx.tasks.interval('sample', Number(ctx.config.get().intervalSeconds) * 1000, tick);
        }
      });
    },
    async start() {
      // CPU usage and network rates need two readings; take a priming one so the first stored sample has them.
      await sampler.sample();
      await new Promise((r) => setTimeout(r, 1000));
      await tick();
      stopSampling = ctx.tasks.interval('sample', Number(ctx.config.get().intervalSeconds) * 1000, tick);
      ctx.tasks.interval('retention', 3_600_000, async () => {
        const cutoff = Math.floor(Date.now() / 1000) - Number(ctx.config.get().retentionDays) * 86_400;
        await ctx.database.run('DELETE FROM samples WHERE ts < ?', [cutoff]);
      });
    },
  };
});
