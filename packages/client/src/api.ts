/** Fetch wrapper for the platform REST API (§27). */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: any,
    readonly problems?: string[],
  ) {
    super(message);
  }
  /** Machine-readable reason, e.g. `module-disabled`, `permission-denied`. */
  get reason(): string | undefined {
    return this.details?.reason;
  }
}

let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** Raw body (e.g. a File) sent as application/octet-stream. */
  raw?: Blob;
}

export async function request<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { 'x-servermin-request': '1', accept: 'application/json' };
  let body: BodyInit | undefined;
  if (opts.raw) {
    headers['content-type'] = 'application/octet-stream';
    body = opts.raw;
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, credentials: 'same-origin', signal: opts.signal });
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    if (res.status === 401 && onUnauthorized && !path.includes('/auth/')) onUnauthorized();
    const err = typeof data === 'object' && data ? data : { error: String(data || res.statusText) };
    throw new ApiRequestError(res.status, err.error ?? `Request failed (${res.status})`, err.details, err.problems);
  }
  return data as T;
}

export const api = {
  get: <T = any>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) => request<T>(path, { query, signal }),
  post: <T = any>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body ?? {} }),
  put: <T = any>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body: body ?? {} }),
  patch: <T = any>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: body ?? {} }),
  delete: <T = any>(path: string, query?: RequestOptions['query']) => request<T>(path, { method: 'DELETE', query }),
};

/** API client bound to one module's routes: `/api/v1/modules/<id>/…`. */
export function moduleApi(moduleId: string) {
  const base = `/api/v1/modules/${moduleId}`;
  const p = (path: string) => base + (path.startsWith('/') ? path : '/' + path);
  return {
    get: <T = any>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) => request<T>(p(path), { query, signal }),
    post: <T = any>(path: string, body?: unknown) => request<T>(p(path), { method: 'POST', body: body ?? {} }),
    put: <T = any>(path: string, body?: unknown) => request<T>(p(path), { method: 'PUT', body: body ?? {} }),
    patch: <T = any>(path: string, body?: unknown) => request<T>(p(path), { method: 'PATCH', body: body ?? {} }),
    delete: <T = any>(path: string, query?: RequestOptions['query']) => request<T>(p(path), { method: 'DELETE', query }),
    /** URL for downloads (export links). */
    url: (path: string, query?: Record<string, string>) => p(path) + (query ? '?' + new URLSearchParams(query).toString() : ''),
  };
}

export type ModuleApi = ReturnType<typeof moduleApi>;
