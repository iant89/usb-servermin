import { readFile, statfs } from 'node:fs/promises';

/** Collects host metrics from /proc and statfs. Rates are computed between samples. */
export class HostSampler {
  private cpu: { idle: number; total: number } | null = null;
  private net: { at: number; rx: number; tx: number } | null = null;

  async sample(now = Date.now()): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const [stat, mem, load, dev] = await Promise.all(['/proc/stat', '/proc/meminfo', '/proc/loadavg', '/proc/net/dev'].map((f) => readFile(f, 'utf8').catch(() => '')));

    if (stat) {
      const v = stat.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
      const cur = { idle: v[3] + (v[4] ?? 0), total: v.reduce((a, b) => a + b, 0) };
      if (this.cpu && cur.total > this.cpu.total) out['cpu.usage'] = round((1 - (cur.idle - this.cpu.idle) / (cur.total - this.cpu.total)) * 100);
      this.cpu = cur;
      const procs = /procs_running (\d+)/.exec(stat);
      if (procs) out['processes.running'] = Number(procs[1]);
    }
    if (mem) {
      const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(mem)?.[1] ?? 0) * 1024;
      const total = kb('MemTotal');
      const available = kb('MemAvailable') || kb('MemFree') + kb('Cached');
      if (total) {
        out['memory.usage'] = round(((total - available) / total) * 100);
        out['memory.used'] = total - available;
      }
      const swap = kb('SwapTotal');
      if (swap) out['swap.usage'] = round(((swap - kb('SwapFree')) / swap) * 100);
    }
    if (load) {
      const f = load.split(/\s+/);
      out['load.1'] = Number(f[0]);
      out['load.5'] = Number(f[1]);
      out['load.15'] = Number(f[2]);
      out['processes.total'] = Number(f[3]?.split('/')[1] ?? 0);
    }
    if (dev) {
      let rx = 0;
      let tx = 0;
      for (const line of dev.split('\n').slice(2)) {
        const [name, rest] = line.split(':');
        if (!rest || name.trim() === 'lo') continue;
        const f = rest.trim().split(/\s+/).map(Number);
        rx += f[0];
        tx += f[8];
      }
      if (this.net && now > this.net.at) {
        const dt = (now - this.net.at) / 1000;
        out['network.rx'] = Math.max(0, round((rx - this.net.rx) / dt));
        out['network.tx'] = Math.max(0, round((tx - this.net.tx) / dt));
      }
      this.net = { at: now, rx, tx };
    }
    try {
      const s = await statfs('/');
      out['disk.root.usage'] = round(((s.blocks - s.bfree) / (s.blocks - s.bfree + s.bavail)) * 100);
    } catch {
      /* not available */
    }
    return out;
  }
}

export function round(n: number, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export const RANGES: Record<string, number> = { '15m': 900, '1h': 3600, '6h': 21_600, '24h': 86_400, '7d': 604_800, '30d': 2_592_000 };

export const UNITS: Record<string, string> = {
  'cpu.usage': '%',
  'memory.usage': '%',
  'memory.used': 'bytes',
  'swap.usage': '%',
  'load.1': '',
  'load.5': '',
  'load.15': '',
  'processes.total': 'count',
  'processes.running': 'count',
  'network.rx': 'bytes/s',
  'network.tx': 'bytes/s',
  'disk.root.usage': '%',
};
