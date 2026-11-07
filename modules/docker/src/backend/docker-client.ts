import { request, type IncomingMessage } from 'node:http';

export class DockerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Splits Docker's multiplexed stdout/stderr stream (8-byte frame headers). */
export class Demuxer {
  private buf = Buffer.alloc(0);
  constructor(private readonly onFrame: (stream: 'stdout' | 'stderr', text: string) => void) {}
  push(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 8) {
      const type = this.buf[0];
      const size = this.buf.readUInt32BE(4);
      if (type > 2 || this.buf[1] !== 0) {
        // Not multiplexed (TTY container): pass through.
        this.onFrame('stdout', this.buf.toString('utf8'));
        this.buf = Buffer.alloc(0);
        return;
      }
      if (this.buf.length < 8 + size) return;
      this.onFrame(type === 2 ? 'stderr' : 'stdout', this.buf.subarray(8, 8 + size).toString('utf8'));
      this.buf = this.buf.subarray(8 + size);
    }
  }
}

export function demux(data: Buffer): { stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  new Demuxer((s, t) => (s === 'stdout' ? (stdout += t) : (stderr += t))).push(data);
  return { stdout, stderr };
}

/** Minimal Docker Engine API client over the Unix socket (§32.2: prefer the API to the CLI). */
export class DockerClient {
  constructor(public socketPath: string) {}

  private open(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request(
        { socketPath: this.socketPath, method, path, headers: { host: 'docker', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) }, timeout: timeoutMs },
        resolve,
      );
      req.on('timeout', () => req.destroy(new DockerError(504, `Docker did not answer ${method} ${path.split('?')[0]} in time`)));
      req.on('error', (e: NodeJS.ErrnoException) =>
        reject(e instanceof DockerError ? e : new DockerError(503, e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'Unable to communicate with Docker Engine.' : e.code === 'EACCES' ? 'Permission denied on the Docker socket (add the service user to the docker group).' : e.message)),
      );
      if (payload) req.write(payload);
      req.end();
    });
  }

  async raw(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<{ status: number; data: Buffer }> {
    const res = await this.open(method, path, body, timeoutMs);
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    return { status: res.statusCode ?? 500, data: Buffer.concat(chunks) };
  }

  async json<T = any>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const { status, data } = await this.raw(method, path, body, timeoutMs);
    const text = data.toString('utf8');
    if (status === 304) throw new DockerError(304, 'The container is already in that state');
    if (status >= 400) {
      let message = text;
      try {
        message = JSON.parse(text).message ?? text;
      } catch {
        /* plain text */
      }
      throw new DockerError(status, message || `Docker returned ${status}`);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text);
    } catch {
      return text as T;
    }
  }

  /** Open a streaming endpoint (logs?follow, events). Returns a function that ends the stream. */
  async stream(path: string, onChunk: (chunk: Buffer) => void, onEnd: (error?: Error) => void): Promise<() => void> {
    const res = await this.open('GET', path, undefined, 0);
    if ((res.statusCode ?? 500) >= 400) {
      const chunks: Buffer[] = [];
      for await (const c of res) chunks.push(c as Buffer);
      throw new DockerError(res.statusCode ?? 500, Buffer.concat(chunks).toString() || 'Stream failed');
    }
    res.on('data', onChunk);
    res.on('end', () => onEnd());
    res.on('error', (e) => onEnd(e));
    return () => res.destroy();
  }

  ping() {
    return this.json<string>('GET', '/_ping', undefined, 5000);
  }
}

export const q = (params: Record<string, string | number | boolean | undefined>) =>
  '?' +
  Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

/** Docker ids and names accepted in URLs. */
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,254}$/;

export function cpuPercent(stats: any): number | null {
  const cpu = stats?.cpu_stats;
  const pre = stats?.precpu_stats;
  if (!cpu || !pre) return null;
  const delta = cpu.cpu_usage.total_usage - pre.cpu_usage.total_usage;
  const sys = cpu.system_cpu_usage - pre.system_cpu_usage;
  const cpus = cpu.online_cpus || cpu.cpu_usage.percpu_usage?.length || 1;
  return sys > 0 && delta >= 0 ? (delta / sys) * cpus * 100 : 0;
}

export function memoryUsage(stats: any) {
  const m = stats?.memory_stats;
  if (!m?.usage) return { used: 0, limit: 0 };
  const cache = m.stats?.inactive_file ?? m.stats?.cache ?? 0;
  return { used: m.usage - cache, limit: m.limit ?? 0 };
}

export function summarizeContainer(c: any) {
  return {
    id: c.Id,
    shortId: String(c.Id).slice(0, 12),
    name: (c.Names?.[0] ?? '').replace(/^\//, ''),
    image: c.Image,
    state: c.State,
    status: c.Status,
    created: new Date((c.Created ?? 0) * 1000).toISOString(),
    ports: (c.Ports ?? []).map((p: any) => (p.PublicPort ? `${p.IP && p.IP !== '0.0.0.0' ? p.IP + ':' : ''}${p.PublicPort}→${p.PrivatePort}/${p.Type}` : `${p.PrivatePort}/${p.Type}`)),
    project: c.Labels?.['com.docker.compose.project'] ?? null,
    service: c.Labels?.['com.docker.compose.service'] ?? null,
    labels: c.Labels ?? {},
  };
}
