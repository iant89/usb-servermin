import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';

/**
 * Hardware-independent host summary for the core dashboard (§31, §38). Everything is discovered
 * at runtime from /proc, /sys and statfs; no interface, disk or CPU model is assumed.
 */
let lastCpu: { idle: number; total: number } | null = null;

async function cpuUsage(): Promise<number | null> {
  try {
    const line = (await readFile('/proc/stat', 'utf8')).split('\n')[0];
    const values = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = values[3] + (values[4] ?? 0);
    const total = values.reduce((a, b) => a + b, 0);
    const prev = lastCpu;
    lastCpu = { idle, total };
    if (!prev || total === prev.total) {
      // First sample: fall back to load average per core.
      return Math.min(100, (os.loadavg()[0] / Math.max(os.cpus().length, 1)) * 100);
    }
    return Math.max(0, Math.min(100, (1 - (idle - prev.idle) / (total - prev.total)) * 100));
  } catch {
    return null;
  }
}

async function memory() {
  try {
    const info = Object.fromEntries(
      (await readFile('/proc/meminfo', 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [k, v] = l.split(':');
          return [k.trim(), parseInt(v, 10) * 1024];
        }),
    );
    return { total: info.MemTotal, available: info.MemAvailable ?? info.MemFree, used: info.MemTotal - (info.MemAvailable ?? info.MemFree), swapTotal: info.SwapTotal ?? 0, swapUsed: (info.SwapTotal ?? 0) - (info.SwapFree ?? 0) };
  } catch {
    return { total: os.totalmem(), available: os.freemem(), used: os.totalmem() - os.freemem(), swapTotal: 0, swapUsed: 0 };
  }
}

export async function disk(path: string) {
  try {
    const s = await statfs(path);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { path, total, free, used: total - s.bfree * s.bsize };
  } catch {
    return null;
  }
}

async function network() {
  try {
    const lines = (await readFile('/proc/net/dev', 'utf8')).split('\n').slice(2).filter(Boolean);
    let rx = 0;
    let tx = 0;
    const interfaces: string[] = [];
    for (const l of lines) {
      const [name, rest] = l.split(':');
      const iface = name.trim();
      if (iface === 'lo') continue;
      const f = rest.trim().split(/\s+/).map(Number);
      rx += f[0];
      tx += f[8];
      interfaces.push(iface);
    }
    return { rxBytes: rx, txBytes: tx, interfaces };
  } catch {
    return { rxBytes: 0, txBytes: 0, interfaces: Object.keys(os.networkInterfaces()).filter((n) => n !== 'lo') };
  }
}

export async function osRelease(): Promise<Record<string, string>> {
  try {
    return Object.fromEntries(
      (await readFile('/etc/os-release', 'utf8'))
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')];
        }),
    );
  } catch {
    return {};
  }
}

export async function hostSummary(dataDir: string) {
  const [cpu, mem, root, data, net, rel] = await Promise.all([cpuUsage(), memory(), disk('/'), disk(dataDir), network(), osRelease()]);
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    os: rel.PRETTY_NAME ?? `${os.type()} ${os.release()}`,
    kernel: os.release(),
    arch: os.arch(),
    uptimeSeconds: Math.round(os.uptime()),
    load: os.loadavg(),
    cpu: { cores: cpus.length, model: cpus[0]?.model?.trim() ?? 'Unknown', usagePercent: cpu },
    memory: mem,
    disks: [root, data && data.path !== '/' ? data : null].filter(Boolean),
    network: net,
    time: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
