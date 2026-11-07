import { readFile, readdir, readlink } from 'node:fs/promises';
import os from 'node:os';

/** Parsers for /proc and /sys. Everything is discovered at runtime (§38). */

export async function read(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}

export function parseKeyValue(text: string, sep = '='): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(sep);
    if (i < 1) continue;
    out[line.slice(0, i).trim()] = line.slice(i + sep.length).trim().replace(/^"|"$/g, '');
  }
  return out;
}

export function parseMeminfo(text: string) {
  const kv = parseKeyValue(text, ':');
  const kb = (k: string) => (kv[k] ? parseInt(kv[k], 10) * 1024 : 0);
  const total = kb('MemTotal');
  const available = kv.MemAvailable ? kb('MemAvailable') : kb('MemFree') + kb('Buffers') + kb('Cached');
  return { total, available, used: total - available, buffers: kb('Buffers'), cached: kb('Cached'), swapTotal: kb('SwapTotal'), swapUsed: kb('SwapTotal') - kb('SwapFree') };
}

export function parseCpuinfo(text: string) {
  const blocks = text.split(/\n\s*\n/).filter((b) => b.includes('processor'));
  const first = parseKeyValue(blocks[0] ?? '', ':');
  const physical = new Set(blocks.map((b) => {
    const kv = parseKeyValue(b, ':');
    return `${kv['physical id'] ?? 0}:${kv['core id'] ?? kv.processor}`;
  }));
  return {
    model: first['model name'] ?? first['Model'] ?? first['Hardware'] ?? 'Unknown',
    vendor: first['vendor_id'] ?? null,
    threads: blocks.length || os.cpus().length,
    cores: physical.size || blocks.length || os.cpus().length,
    mhz: first['cpu MHz'] ? Math.round(parseFloat(first['cpu MHz'])) : null,
    flags: (first.flags ?? first.Features ?? '').split(/\s+/).filter((f) => ['vmx', 'svm', 'aes', 'avx2', 'avx512f', 'hypervisor'].includes(f)),
  };
}

/** Aggregate CPU counters from the first line of /proc/stat. */
export function parseStat(text: string) {
  const v = text.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = v[3] + (v[4] ?? 0);
  return { idle, total: v.reduce((a, b) => a + b, 0) };
}

export class CpuSampler {
  private last: { idle: number; total: number } | null = null;
  async sample(): Promise<number | null> {
    const t = await read('/proc/stat');
    if (!t) return null;
    const cur = parseStat(t);
    const prev = this.last;
    this.last = cur;
    if (!prev || cur.total === prev.total) return null;
    return Math.max(0, Math.min(100, (1 - (cur.idle - prev.idle) / (cur.total - prev.total)) * 100));
  }
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  state: string;
  user: string;
  command: string;
  threads: number;
  rssBytes: number;
  cpuPercent: number;
  startedAt: string | null;
}

/** /proc/<pid>/stat: the command name is in parentheses and may contain spaces. */
export function parsePidStat(text: string) {
  const close = text.lastIndexOf(')');
  const name = text.slice(text.indexOf('(') + 1, close);
  const f = text.slice(close + 2).split(' ');
  return { name, state: f[0], ppid: Number(f[1]), utime: Number(f[11]), stime: Number(f[12]), threads: Number(f[17]), starttime: Number(f[19]), rssPages: Number(f[21]) };
}

const CLK_TCK = 100;
const PAGE = 4096;

export class ProcessSampler {
  private last = new Map<number, number>();
  private lastAt = 0;
  private users = new Map<number, string>();

  private async userName(uid: number) {
    if (!this.users.size) {
      const passwd = (await read('/etc/passwd')) ?? '';
      for (const l of passwd.split('\n')) {
        const p = l.split(':');
        if (p.length > 2) this.users.set(Number(p[2]), p[0]);
      }
    }
    return this.users.get(uid) ?? String(uid);
  }

  async list(): Promise<ProcessInfo[]> {
    const now = Date.now();
    const elapsed = this.lastAt ? (now - this.lastAt) / 1000 : 0;
    const bootTime = Date.now() / 1000 - os.uptime();
    const pids = (await readdir('/proc').catch(() => [])).filter((d) => /^\d+$/.test(d)).map(Number);
    const out: ProcessInfo[] = [];
    const next = new Map<number, number>();
    await Promise.all(
      pids.map(async (pid) => {
        const [stat, status, cmdline] = await Promise.all([read(`/proc/${pid}/stat`), read(`/proc/${pid}/status`), readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')]);
        if (!stat) return;
        const s = parsePidStat(stat);
        const ticks = s.utime + s.stime;
        next.set(pid, ticks);
        const prev = this.last.get(pid);
        const uid = Number(/Uid:\s+(\d+)/.exec(status ?? '')?.[1] ?? -1);
        out.push({
          pid,
          ppid: s.ppid,
          name: s.name,
          state: s.state,
          user: await this.userName(uid),
          command: cmdline.replace(/\0+$/, '').replace(/\0/g, ' ') || `[${s.name}]`,
          threads: s.threads,
          rssBytes: s.rssPages * PAGE,
          cpuPercent: elapsed && prev !== undefined ? Math.max(0, ((ticks - prev) / CLK_TCK / elapsed) * 100) : 0,
          startedAt: Number.isFinite(s.starttime) ? new Date((bootTime + s.starttime / CLK_TCK) * 1000).toISOString() : null,
        });
      }),
    );
    this.last = next;
    this.lastAt = now;
    return out;
  }
}

/** `apt list --upgradable` lines: `name/suite version arch [upgradable from: old]`. */
export function parseAptUpgradable(text: string) {
  const out: { name: string; suite: string; version: string; arch: string; from: string | null; security: boolean }[] = [];
  for (const line of text.split('\n')) {
    const m = /^([^/\s]+)\/(\S+)\s+(\S+)\s+(\S+)(?:\s+\[upgradable from: ([^\]]+)\])?/.exec(line.trim());
    if (!m) continue;
    out.push({ name: m[1], suite: m[2], version: m[3], arch: m[4], from: m[5] ?? null, security: /security/.test(m[2]) });
  }
  return out;
}

/** `lspci -mm` lines for display controllers. */
export function parseLspciGpus(text: string) {
  const out: { slot: string; vendor: string; device: string }[] = [];
  for (const line of text.split('\n')) {
    const parts = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    const slot = line.split(' ')[0];
    if (parts.length >= 3 && /VGA|3D|Display/i.test(parts[0])) out.push({ slot, vendor: parts[1], device: parts[2] });
  }
  return out;
}

export async function drmGpus() {
  const cards = (await readdir('/sys/class/drm').catch(() => [])).filter((c) => /^card\d+$/.test(c));
  const out: { slot: string; vendor: string; device: string }[] = [];
  for (const c of cards) {
    const vendor = await read(`/sys/class/drm/${c}/device/vendor`);
    const device = await read(`/sys/class/drm/${c}/device/device`);
    const driver = await readlink(`/sys/class/drm/${c}/device/driver`).catch(() => '');
    out.push({ slot: c, vendor: vendor ?? 'unknown', device: `${device ?? ''} ${driver.split('/').pop() ?? ''}`.trim() });
  }
  return out;
}
