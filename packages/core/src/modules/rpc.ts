/**
 * Minimal bidirectional RPC over a worker MessagePort. Used between the core and each module
 * worker. Values must be structured-cloneable; errors are serialised with their status.
 */
export interface Port {
  postMessage(value: unknown): void;
  on(event: 'message', listener: (value: any) => void): unknown;
}

type Handler = (args: any) => unknown;

interface Pending {
  resolve(v: unknown): void;
  reject(e: unknown): void;
  timer?: NodeJS.Timeout;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: unknown,
    readonly remoteName?: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export function serializeError(e: unknown) {
  const err = e as { message?: string; status?: number; details?: unknown; name?: string; stack?: string };
  return { message: err?.message ?? String(e), status: typeof err?.status === 'number' ? err.status : undefined, details: err?.details, name: err?.name };
}

export class RpcPeer {
  private seq = 0;
  private pending = new Map<number, Pending>();
  private disposed: string | null = null;

  constructor(
    private readonly port: Port,
    private readonly handlers: Record<string, Handler>,
    private readonly notifications: Record<string, Handler> = {},
    private readonly onUnhandled?: (error: unknown, method: string) => void,
  ) {
    port.on('message', (msg) => this.receive(msg));
  }

  private receive(msg: any) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'r') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.v);
      else p.reject(new RpcError(msg.e?.message ?? 'Remote error', msg.e?.status, msg.e?.details, msg.e?.name));
      return;
    }
    if (msg.t === 'c') {
      const handler = this.handlers[msg.m];
      const reply = (ok: boolean, payload: unknown) => {
        if (this.disposed) return;
        try {
          this.port.postMessage(ok ? { t: 'r', id: msg.id, ok: true, v: payload } : { t: 'r', id: msg.id, ok: false, e: payload });
        } catch (e) {
          this.port.postMessage({ t: 'r', id: msg.id, ok: false, e: serializeError(new Error(`Result could not be transferred: ${(e as Error).message}`)) });
        }
      };
      if (!handler) return reply(false, { message: `Unknown method ${msg.m}` });
      Promise.resolve()
        .then(() => handler(msg.a))
        .then((v) => reply(true, v), (e) => reply(false, serializeError(e)));
      return;
    }
    if (msg.t === 'n') {
      const handler = this.notifications[msg.m];
      if (!handler) return;
      try {
        const r = handler(msg.a) as Promise<unknown> | undefined;
        if (r && typeof r.catch === 'function') r.catch((e) => this.onUnhandled?.(e, msg.m));
      } catch (e) {
        this.onUnhandled?.(e, msg.m);
      }
    }
  }

  call<T = unknown>(method: string, args?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.disposed) return Promise.reject(new RpcError(this.disposed, 503));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs > 0)
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcError(`${method} timed out after ${timeoutMs} ms`, 504));
        }, timeoutMs);
      this.pending.set(id, p);
      this.port.postMessage({ t: 'c', id, m: method, a: args });
    });
  }

  notify(method: string, args?: unknown) {
    if (this.disposed) return;
    this.port.postMessage({ t: 'n', m: method, a: args });
  }

  dispose(reason = 'Connection closed') {
    this.disposed = reason;
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new RpcError(reason, 503));
    }
    this.pending.clear();
  }
}
