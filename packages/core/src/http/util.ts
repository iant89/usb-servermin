import type { IncomingMessage, ServerResponse } from 'node:http';
import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { RequestUser } from '@servermin/sdk';
import type { UserRecord } from '../auth/auth-service';

/** Session cookie of the agent's local interface. */
export const SESSION_COOKIE = 'sm_session';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  ip: string;
  requestId: string;
  user?: UserRecord;
  requestUser?: RequestUser;
  sessionToken?: string;
  authKind?: 'session' | 'token';
  body?: unknown;
}

export function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function newRequestId() {
  return randomUUID().slice(0, 8);
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(payload);
}

export function sendRaw(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end(body);
}

export async function readJson(req: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new ApiError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!size) return undefined;
  if (!type.includes('application/json')) throw new ApiError(415, 'Send JSON (content-type: application/json)');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'Malformed JSON');
  }
}

/** Streams a binary upload to a file, enforcing a size limit. */
export async function readToFile(req: IncomingMessage, file: string, limit: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const out = createWriteStream(file, { mode: 0o600 });
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        out.destroy();
        reject(new ApiError(413, 'Upload too large'));
      }
    });
    req.pipe(out);
    out.on('finish', () => resolve(size));
    out.on('error', reject);
    req.on('error', reject);
  });
}

export function requireFields<T extends Record<string, unknown>>(body: unknown, fields: (keyof T)[]): T {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Expected a JSON object');
  for (const f of fields) {
    const v = (body as Record<string, unknown>)[f as string];
    if (v === undefined || v === null || v === '') throw new ApiError(400, `Missing field "${String(f)}"`);
  }
  return body as T;
}

export function asString(v: unknown, name: string, max = 500): string {
  if (typeof v !== 'string') throw new ApiError(400, `"${name}" must be text`);
  if (v.length > max) throw new ApiError(400, `"${name}" is too long`);
  return v;
}
