/**
 * Agent/Manager protocol (ADR-002).
 *
 * An agent opens one WebSocket to the Manager and both sides exchange JSON text frames, one
 * message per frame:
 *
 *   { "v": 1, "id": "<unique>", "type": "HEARTBEAT", "ts": "<ISO time>", "correlationId": "<id of the message this answers>", "payload": { … } }
 *
 * Handshake:   Manager → HELLO            { versions, nonce, manager }
 *              Agent   → AUTHENTICATION   { agentId, serverId, version, signature }
 *              Manager → AUTHENTICATED    { serverId, heartbeatIntervalMs, heartbeatTimeoutMs }   (or ERROR, then close)
 * Afterwards:  Agent   → SERVER_STATE, CAPABILITIES, HEARTBEAT …      Manager → HEARTBEAT (acknowledgement)
 *
 * Both sides import this file, so the two ends cannot drift apart. It has no dependencies.
 */
import { randomUUID } from 'node:crypto';

/** Protocol versions this code speaks. A connection uses the highest version both sides list. */
export const PROTOCOL_VERSIONS = [1] as const;
export const AGENT_ENDPOINT = '/api/v1/agents/ws';
/** Largest frame either side accepts. */
export const MAX_FRAME_BYTES = 256 * 1024;

/**
 * Every message type of the protocol. The first group is implemented; the second is reserved for
 * the phases that add metrics, events, commands, logs and module state, and is answered with
 * ERROR `unsupported` until then.
 */
export const MESSAGE_TYPES = [
  'HELLO',
  'AUTHENTICATION',
  'AUTHENTICATED',
  'ERROR',
  'HEARTBEAT',
  'SERVER_STATE',
  'CAPABILITIES',
  'METRIC',
  'EVENT',
  'COMMAND',
  'COMMAND_RESULT',
  'LOG',
  'MODULE_STATE',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];
export const RESERVED_TYPES: readonly MessageType[] = ['METRIC', 'EVENT', 'COMMAND', 'COMMAND_RESULT', 'LOG', 'MODULE_STATE'];

export const ERROR_CODES = ['malformed', 'unsupported', 'unauthorized', 'protocol-version', 'timeout', 'rate-limited', 'replaced', 'revoked', 'shutting-down', 'internal'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** WebSocket close codes (4000-4999 are for applications). */
export const CLOSE = {
  malformed: 4400,
  unauthorized: 4401,
  timeout: 4408,
  replaced: 4409,
  revoked: 4403,
  protocolVersion: 4426,
  rateLimited: 4429,
  shuttingDown: 1001,
} as const;

export interface Payloads {
  HELLO: { versions: number[]; nonce: string; manager: { version: string } };
  AUTHENTICATION: { agentId: string; serverId: string; version: number; signature: string };
  AUTHENTICATED: { serverId: string; heartbeatIntervalMs: number; heartbeatTimeoutMs: number };
  ERROR: { code: ErrorCode; message: string };
  HEARTBEAT: { seq: number };
  SERVER_STATE: { name: string; hostname: string; agentVersion: string; os: string; health: 'HEALTHY' | 'DEGRADED' | 'ERROR' | 'OFFLINE'; state: 'STARTING' | 'RUNNING' | 'STOPPING' };
  CAPABILITIES: { capabilities: string[] };
  METRIC: Record<string, unknown>;
  EVENT: Record<string, unknown>;
  COMMAND: Record<string, unknown>;
  COMMAND_RESULT: Record<string, unknown>;
  LOG: Record<string, unknown>;
  MODULE_STATE: Record<string, unknown>;
}

export interface Message<T extends MessageType = MessageType> {
  v: number;
  id: string;
  type: T;
  ts: string;
  correlationId?: string;
  payload: Payloads[T];
}

export class ProtocolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function createMessage<T extends MessageType>(type: T, payload: Payloads[T], correlationId?: string, version: number = PROTOCOL_VERSIONS[0]): Message<T> {
  return { v: version, id: randomUUID(), type, ts: new Date().toISOString(), ...(correlationId ? { correlationId } : {}), payload };
}

export function encode(message: Message): string {
  return JSON.stringify(message);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const CAPABILITY_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v);
const int = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** One check per implemented type. Each returns the name of the first bad field, or null. */
const VALIDATORS: { [T in MessageType]?: (p: Record<string, unknown>) => string | null } = {
  HELLO: (p) =>
    !Array.isArray(p.versions) || p.versions.length < 1 || p.versions.length > 16 || !p.versions.every((v) => int(v, 1, 1000))
      ? 'versions'
      : !text(p.nonce, 128) || !BASE64_RE.test(p.nonce) || p.nonce.length < 43
        ? 'nonce'
        : !isObject(p.manager) || !text(p.manager.version, 32)
          ? 'manager'
          : null,
  AUTHENTICATION: (p) =>
    !text(p.agentId, 36) || !UUID_RE.test(p.agentId)
      ? 'agentId'
      : !text(p.serverId, 36) || !UUID_RE.test(p.serverId)
        ? 'serverId'
        : !int(p.version, 1, 1000)
          ? 'version'
          : !text(p.signature, 128) || !BASE64_RE.test(p.signature)
            ? 'signature'
            : null,
  AUTHENTICATED: (p) => (!text(p.serverId, 36) || !UUID_RE.test(p.serverId) ? 'serverId' : !int(p.heartbeatIntervalMs, 100, 3_600_000) ? 'heartbeatIntervalMs' : !int(p.heartbeatTimeoutMs, 100, 86_400_000) ? 'heartbeatTimeoutMs' : null),
  ERROR: (p) => (!(ERROR_CODES as readonly unknown[]).includes(p.code) ? 'code' : !text(p.message, 500) ? 'message' : null),
  HEARTBEAT: (p) => (!int(p.seq, 0, Number.MAX_SAFE_INTEGER) ? 'seq' : null),
  SERVER_STATE: (p) =>
    !text(p.name, 64) || !p.name
      ? 'name'
      : !text(p.hostname, 253)
        ? 'hostname'
        : !text(p.agentVersion, 32)
          ? 'agentVersion'
          : !text(p.os, 200)
            ? 'os'
            : !['HEALTHY', 'DEGRADED', 'ERROR', 'OFFLINE'].includes(p.health as string)
              ? 'health'
              : !['STARTING', 'RUNNING', 'STOPPING'].includes(p.state as string)
                ? 'state'
                : null,
  CAPABILITIES: (p) => (!Array.isArray(p.capabilities) || p.capabilities.length > 500 || !p.capabilities.every((c) => text(c, 100) && CAPABILITY_RE.test(c)) ? 'capabilities' : null),
};

/**
 * Parses and validates one frame from the other side, which is not trusted: anything that is not
 * exactly a known message throws a ProtocolError and nothing of it is used.
 */
export function decode(raw: string | Buffer): Message {
  const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
  if (size > MAX_FRAME_BYTES) throw new ProtocolError('malformed', 'Frame too large');
  let m: unknown;
  try {
    m = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    throw new ProtocolError('malformed', 'Frame is not JSON');
  }
  if (!isObject(m)) throw new ProtocolError('malformed', 'Message must be an object');
  if (!int(m.v, 1, 1000)) throw new ProtocolError('malformed', 'Missing protocol version');
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) throw new ProtocolError('malformed', 'Missing message id');
  if (typeof m.type !== 'string' || !(MESSAGE_TYPES as readonly string[]).includes(m.type)) throw new ProtocolError('unsupported', 'Unknown message type');
  if (!text(m.ts, 40) || Number.isNaN(Date.parse(m.ts))) throw new ProtocolError('malformed', 'Missing timestamp');
  if (m.correlationId !== undefined && (typeof m.correlationId !== 'string' || !ID_RE.test(m.correlationId))) throw new ProtocolError('malformed', 'Invalid correlation id');
  if (!isObject(m.payload)) throw new ProtocolError('malformed', 'Missing payload');
  const type = m.type as MessageType;
  const validate = VALIDATORS[type];
  if (!validate) throw new ProtocolError('unsupported', `${type} is not supported by this version`);
  const bad = validate(m.payload);
  if (bad) throw new ProtocolError('malformed', `Invalid ${type}: ${bad}`);
  return { v: m.v, id: m.id, type, ts: m.ts, ...(m.correlationId ? { correlationId: m.correlationId as string } : {}), payload: m.payload as never };
}

/** The highest version both lists contain, or null. */
export function negotiateVersion(theirs: readonly number[], ours: readonly number[] = PROTOCOL_VERSIONS): number | null {
  const common = ours.filter((v) => theirs.includes(v));
  return common.length ? Math.max(...common) : null;
}

/**
 * The bytes an agent signs to authenticate. They bind the signature to this connection attempt
 * (the Manager's fresh nonce), to the identity claimed, to the protocol version chosen, and to
 * the TLS certificate the agent saw, so a signature cannot be replayed on another connection or
 * relayed through a machine in the middle that presents a different certificate.
 * `tlsFingerprint` is the SHA-256 of the Manager's certificate (hex, lower case, no colons), or
 * an empty string on a connection without TLS.
 */
export function authSigningInput(p: { nonce: string; agentId: string; serverId: string; version: number; tlsFingerprint: string }): Buffer {
  return Buffer.from(['servermin-agent-auth', `v${p.version}`, p.nonce, p.agentId, p.serverId, p.tlsFingerprint].join('\n'), 'utf8');
}

/** Normalises a certificate fingerprint as tools print it (`AB:CD:…`, `sha256:…`) to lower-case hex, or null. */
export function normalizeFingerprint(v: string): string | null {
  const hex = v.trim().replace(/^sha-?256[:=]/i, '').replace(/[:\s]/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}
