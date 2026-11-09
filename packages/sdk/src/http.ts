/** The signed-in user a request or channel subscription acts for. */
export interface RequestUser {
  id: number;
  username: string;
  displayName: string;
  permissions: string[];
}

export interface ModuleRequest<Body = unknown> {
  method: string;
  /** Path relative to the module's API root, e.g. `/containers/abc`. */
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: Body;
  /** Lower-cased request headers (cookies and authorization removed). */
  headers: Record<string, string>;
  user: RequestUser;
  requestId: string;
  /** Address of the client (the browser or CLI), e.g. to warn before cutting its connection. */
  remoteAddress: string;
  /** The Host header the client used to reach the server. */
  host: string;
}

/** A handler may return a plain JSON value or a full response. */
export interface ModuleResponse {
  status?: number;
  headers?: Record<string, string>;
  /** JSON-serialisable body, or a string when `raw` is true. */
  body?: unknown;
  /** Send `body` as-is (string) instead of JSON. */
  raw?: boolean;
}

export type RouteHandler = (req: ModuleRequest<any>) => unknown | Promise<unknown>;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteOptions {
  /** Permission required to call the route; must be declared in the manifest, or `authenticated`. */
  permission: string;
  /** Record successful calls in the audit log with this action name. */
  audit?: string;
  /** Handler timeout in ms. @default 30000 */
  timeoutMs?: number;
}

/** Throw from a handler to return a specific status and message. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Structural check: modules bundle their own copy of the SDK, so `instanceof HttpError` is not
 * reliable across bundles.
 */
export function isHttpError(e: unknown): e is HttpError {
  return !!e && typeof e === 'object' && (e as Error).name === 'HttpError' && typeof (e as HttpError).status === 'number' && (e as HttpError).status >= 400 && (e as HttpError).status < 600;
}

export function isModuleResponse(v: unknown): v is ModuleResponse {
  return !!v && typeof v === 'object' && ('status' in v || 'raw' in v || 'headers' in v) && 'body' in (v as object);
}
