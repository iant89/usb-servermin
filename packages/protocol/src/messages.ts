/**
 * The Servermin Agent/Manager protocol (ADR-002). Both sides import this file, so a message the
 * agent sends is checked by the same code that the Manager uses to read it.
 *
 * Every frame is one JSON text message, an envelope:
 *
 *   { "v": 1, "id": "<message id>", "type": "HEARTBEAT", "correlationId": "<id it answers>", "payload": { … } }
 *
 * Validation is strict about what it reads and lenient about what it ignores: unknown payload
 * fields are dropped (a newer peer may add fields within a protocol version), unknown message
 * types and malformed values are errors. The decoded payload is rebuilt from the known fields
 * only, so nothing unvalidated reaches the caller.
 */

/** Protocol versions this build speaks, oldest first. */
export const PROTOCOL_VERSIONS = [1] as const;
export type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number];

/** WebSocket path of the agent endpoint on a Manager. Not the browser endpoint (`/api/v1/ws`). */
export const LINK_PATH = '/api/v1/agent/link';

/** Largest frame either side accepts. A full server state report is a few kilobytes. */
export const MAX_FRAME_BYTES = 256 * 1024;

/** WebSocket close codes. 4xxx mirror HTTP statuses so they read naturally in logs. */
export const CLOSE = {
  /** The peer is shutting down. */
  GOING_AWAY: 1001,
  /** A frame was larger than `MAX_FRAME_BYTES` (set by the WebSocket library). */
  TOO_BIG: 1009,
  /** Malformed frame, unknown type, message out of order. */
  PROTOCOL_ERROR: 4400,
  /** Unknown agent, bad signature, revoked, identity mismatch. */
  AUTH_FAILED: 4401,
  /** No common protocol version. */
  UNSUPPORTED_VERSION: 4406,
  /** No authentication, or no heartbeat, in time. */
  TIMEOUT: 4408,
  /** Another live connection already speaks for this agent. */
  DUPLICATE: 4409,
  /** A newer connection of the same agent replaced this one. */
  REPLACED: 4410,
  /** Too many messages, or too many failed attempts from this address. */
  RATE_LIMITED: 4429,
} as const;

/** Direction of a message, which also decides which types are allowed. */
export type Direction = 'toManager' | 'toAgent';

export type AgentRunState = 'STARTING' | 'RUNNING' | 'STOPPING';
export type Health = 'HEALTHY' | 'DEGRADED' | 'ERROR' | 'OFFLINE' | 'UNKNOWN';
const AGENT_RUN_STATES: readonly AgentRunState[] = ['STARTING', 'RUNNING', 'STOPPING'];
const HEALTH: readonly Health[] = ['HEALTHY', 'DEGRADED', 'ERROR', 'OFFLINE', 'UNKNOWN'];

/** Manager → agent, first frame on every connection: a challenge to sign. */
export interface HelloPayload {
  managerVersion: string;
  protocolVersions: number[];
  /** 32 random bytes, base64url. */
  nonce: string;
}

/** Agent → Manager, answers HELLO. */
export interface AuthenticatePayload {
  protocolVersion: number;
  agentId: string;
  serverId: string;
  agentVersion: string;
  /**
   * SHA-256 of the Manager's public key (SPKI) as the agent saw it during the TLS handshake, or
   * null on an unencrypted connection. Part of the signed text, so a relay in the middle with its
   * own certificate cannot reuse the signature.
   */
  keyFingerprint: string | null;
  /** Ed25519 signature over `authenticationText(...)`, base64url. */
  signature: string;
}

/** Manager → agent, answers AUTHENTICATE when it succeeded. */
export interface AuthenticatedPayload {
  sessionId: string;
  protocolVersion: number;
  serverId: string;
  /** How often the agent sends HEARTBEAT. */
  heartbeatIntervalMs: number;
  /** Silence after which either side gives the connection up. */
  timeoutMs: number;
}

/** Agent → Manager, every `heartbeatIntervalMs`. */
export interface HeartbeatPayload {
  sequence: number;
  state: AgentRunState;
  health: Health;
  uptimeSeconds: number;
}

/** Manager → agent, answers HEARTBEAT. */
export interface HeartbeatAckPayload {
  sequence: number;
}

export interface ModuleStateInfo {
  id: string;
  version: string;
  state: string;
  health: Health;
  provides: string[];
  tags: string[];
}

/** Agent → Manager, after authenticating and whenever capabilities or health change. */
export interface ServerStatePayload {
  name: string;
  hostname: string;
  machineId: string | null;
  hardware: { vendor: string | null; product: string | null; board: string | null; fingerprint: string | null };
  os: { name: string; id: string | null; version: string | null; kernel: string; arch: string };
  version: string;
  state: AgentRunState;
  health: Health;
  startedAt: string;
  uptimeSeconds: number;
  capabilities: string[];
  modules: ModuleStateInfo[];
}

export type ErrorCode = 'protocol-error' | 'auth-failed' | 'unsupported-version' | 'timeout' | 'duplicate' | 'rate-limited' | 'internal';
const ERROR_CODES: readonly ErrorCode[] = ['protocol-error', 'auth-failed', 'unsupported-version', 'timeout', 'duplicate', 'rate-limited', 'internal'];

/** Either direction. Sent before closing, so the peer can log a reason. */
export interface ErrorPayload {
  code: ErrorCode;
  message: string;
}

export interface PayloadByType {
  HELLO: HelloPayload;
  AUTHENTICATE: AuthenticatePayload;
  AUTHENTICATED: AuthenticatedPayload;
  HEARTBEAT: HeartbeatPayload;
  HEARTBEAT_ACK: HeartbeatAckPayload;
  SERVER_STATE: ServerStatePayload;
  ERROR: ErrorPayload;
}
export type MessageType = keyof PayloadByType;

export interface Envelope<T extends MessageType = MessageType> {
  v: 1;
  id: string;
  type: T;
  correlationId?: string;
  payload: PayloadByType[T];
}
export type AnyMessage = { [T in MessageType]: Envelope<T> }[MessageType];

/** Which side may send which type. */
const ALLOWED: Record<Direction, readonly MessageType[]> = {
  toManager: ['AUTHENTICATE', 'HEARTBEAT', 'SERVER_STATE', 'ERROR'],
  toAgent: ['HELLO', 'AUTHENTICATED', 'HEARTBEAT_ACK', 'ERROR'],
};

/**
 * Types reserved for later phases (target state §4). Recognised so a peer gets a clear "not
 * supported by this version" instead of "unknown type".
 */
export const RESERVED_TYPES = ['CAPABILITIES', 'METRIC', 'EVENT', 'COMMAND', 'COMMAND_RESULT', 'LOG', 'MODULE_STATE'] as const;

export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode = 'protocol-error',
  ) {
    super(message);
  }
}

// ── Field validators ────────────────────────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function obj(v: unknown, field: string): Obj {
  if (!isObj(v)) throw new ProtocolError(`${field} must be an object`);
  return v;
}

/** Text without control characters, at most `max` characters. */
function text(v: unknown, field: string, max = 256): string {
  if (typeof v !== 'string' || v.length > max || /\p{Cc}/u.test(v)) throw new ProtocolError(`${field} must be text of at most ${max} characters`);
  return v;
}
const textOrNull = (v: unknown, field: string, max = 256) => (v === null || v === undefined ? null : text(v, field, max));

function int(v: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) throw new ProtocolError(`${field} must be an integer from ${min} to ${max}`);
  return v as number;
}

function uuid(v: unknown, field: string): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new ProtocolError(`${field} must be a UUID`);
  return v;
}

function b64url(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || v.length > max || !B64URL_RE.test(v)) throw new ProtocolError(`${field} must be base64url`);
  return v;
}

function oneOf<T extends string>(v: unknown, field: string, values: readonly T[]): T {
  if (!values.includes(v as T)) throw new ProtocolError(`${field} must be one of ${values.join(', ')}`);
  return v as T;
}

function textList(v: unknown, field: string, maxItems: number, maxLen = 128): string[] {
  if (!Array.isArray(v) || v.length > maxItems) throw new ProtocolError(`${field} must be a list of at most ${maxItems} entries`);
  return v.map((x, i) => text(x, `${field}[${i}]`, maxLen));
}

function versionList(v: unknown): number[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 16) throw new ProtocolError('protocolVersions must be a list of 1-16 versions');
  return v.map((x, i) => int(x, `protocolVersions[${i}]`, 1, 65535));
}

function timestamp(v: unknown, field: string): string {
  const s = text(v, field, 40);
  if (Number.isNaN(Date.parse(s))) throw new ProtocolError(`${field} must be an ISO timestamp`);
  return s;
}

/** Normalises a SHA-256 fingerprint as written by people (`AB:CD:…`, upper case) to 64 lower-case hex digits. */
export function normalizeFingerprint(v: string): string | null {
  const hex = v.replace(/^sha256:/i, '').replace(/[:\s]/g, '').toLowerCase();
  return HEX64_RE.test(hex) ? hex : null;
}

// ── Payload decoders ────────────────────────────────────────────────────────────

const decoders: { [T in MessageType]: (p: Obj) => PayloadByType[T] } = {
  HELLO: (p) => ({
    managerVersion: text(p.managerVersion, 'managerVersion', 64),
    protocolVersions: versionList(p.protocolVersions),
    nonce: b64url(p.nonce, 'nonce', 128),
  }),
  AUTHENTICATE: (p) => {
    const fp = p.keyFingerprint;
    if (fp !== null && (typeof fp !== 'string' || !HEX64_RE.test(fp))) throw new ProtocolError('keyFingerprint must be 64 hex digits or null');
    return {
      protocolVersion: int(p.protocolVersion, 'protocolVersion', 1, 65535),
      agentId: uuid(p.agentId, 'agentId'),
      serverId: uuid(p.serverId, 'serverId'),
      agentVersion: text(p.agentVersion, 'agentVersion', 64),
      keyFingerprint: fp as string | null,
      signature: b64url(p.signature, 'signature', 128),
    };
  },
  AUTHENTICATED: (p) => ({
    sessionId: text(p.sessionId, 'sessionId', 64),
    protocolVersion: int(p.protocolVersion, 'protocolVersion', 1, 65535),
    serverId: uuid(p.serverId, 'serverId'),
    heartbeatIntervalMs: int(p.heartbeatIntervalMs, 'heartbeatIntervalMs', 50, 3_600_000),
    timeoutMs: int(p.timeoutMs, 'timeoutMs', 100, 3_600_000),
  }),
  HEARTBEAT: (p) => ({
    sequence: int(p.sequence, 'sequence', 0, Number.MAX_SAFE_INTEGER),
    state: oneOf(p.state, 'state', AGENT_RUN_STATES),
    health: oneOf(p.health, 'health', HEALTH),
    uptimeSeconds: int(p.uptimeSeconds, 'uptimeSeconds', 0, Number.MAX_SAFE_INTEGER),
  }),
  HEARTBEAT_ACK: (p) => ({ sequence: int(p.sequence, 'sequence', 0, Number.MAX_SAFE_INTEGER) }),
  SERVER_STATE: (p) => {
    const hw = obj(p.hardware, 'hardware');
    const os = obj(p.os, 'os');
    if (!Array.isArray(p.modules) || p.modules.length > 256) throw new ProtocolError('modules must be a list of at most 256 entries');
    return {
      name: text(p.name, 'name', 128),
      hostname: text(p.hostname, 'hostname', 253),
      machineId: textOrNull(p.machineId, 'machineId', 64),
      hardware: { vendor: textOrNull(hw.vendor, 'hardware.vendor'), product: textOrNull(hw.product, 'hardware.product'), board: textOrNull(hw.board, 'hardware.board'), fingerprint: textOrNull(hw.fingerprint, 'hardware.fingerprint', 64) },
      os: { name: text(os.name, 'os.name'), id: textOrNull(os.id, 'os.id', 64), version: textOrNull(os.version, 'os.version', 64), kernel: text(os.kernel, 'os.kernel', 128), arch: text(os.arch, 'os.arch', 32) },
      version: text(p.version, 'version', 64),
      state: oneOf(p.state, 'state', AGENT_RUN_STATES),
      health: oneOf(p.health, 'health', HEALTH),
      startedAt: timestamp(p.startedAt, 'startedAt'),
      uptimeSeconds: int(p.uptimeSeconds, 'uptimeSeconds', 0, Number.MAX_SAFE_INTEGER),
      capabilities: textList(p.capabilities, 'capabilities', 1024),
      modules: p.modules.map((m: unknown, i: number) => {
        const o = obj(m, `modules[${i}]`);
        return {
          id: text(o.id, `modules[${i}].id`, 128),
          version: text(o.version, `modules[${i}].version`, 64),
          state: text(o.state, `modules[${i}].state`, 32),
          health: oneOf(o.health, `modules[${i}].health`, HEALTH),
          provides: textList(o.provides, `modules[${i}].provides`, 64),
          tags: textList(o.tags, `modules[${i}].tags`, 64),
        };
      }),
    };
  },
  ERROR: (p) => ({ code: oneOf(p.code, 'code', ERROR_CODES), message: text(p.message, 'message', 1024) }),
};

const KNOWN = Object.keys(decoders) as MessageType[];

/**
 * Decodes and validates one frame. Throws `ProtocolError` with a message that is safe to send
 * back to the peer: it never echoes the frame's content.
 */
export function decode(raw: string | Buffer | ArrayBuffer | Buffer[], direction: Direction): AnyMessage {
  const buf = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw);
  if (buf.length > MAX_FRAME_BYTES) throw new ProtocolError(`Frame larger than ${MAX_FRAME_BYTES} bytes`);
  let msg: unknown;
  try {
    msg = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new ProtocolError('Frame is not JSON');
  }
  if (!isObj(msg)) throw new ProtocolError('Frame must be a JSON object');
  if (msg.v !== 1) throw new ProtocolError('Unsupported envelope version', 'unsupported-version');
  if (typeof msg.id !== 'string' || !ID_RE.test(msg.id)) throw new ProtocolError('id must be 1-64 characters of A-Z, a-z, 0-9, _ or -');
  if (msg.correlationId !== undefined && (typeof msg.correlationId !== 'string' || !ID_RE.test(msg.correlationId))) throw new ProtocolError('correlationId is invalid');
  const type = msg.type;
  if (typeof type !== 'string') throw new ProtocolError('type is required');
  if ((RESERVED_TYPES as readonly string[]).includes(type)) throw new ProtocolError(`${type} is not supported by protocol version 1`);
  if (!KNOWN.includes(type as MessageType)) throw new ProtocolError('Unknown message type');
  if (!ALLOWED[direction].includes(type as MessageType)) throw new ProtocolError(`${type} is not allowed in this direction`);
  const payload = decoders[type as MessageType](obj(msg.payload, 'payload'));
  const out: Obj = { v: 1, id: msg.id, type, payload };
  if (msg.correlationId !== undefined) out.correlationId = msg.correlationId;
  return out as unknown as AnyMessage;
}

/** Builds an envelope. `id` is generated by the caller's `newId`, so this file has no runtime dependency. */
export function envelope<T extends MessageType>(type: T, id: string, payload: PayloadByType[T], correlationId?: string): Envelope<T> {
  return correlationId ? { v: 1, id, type, correlationId, payload } : { v: 1, id, type, payload };
}

/** Serialises an envelope; refuses one this side's own decoder would refuse, so a bug shows up at the sender. */
export function encode(message: Envelope, direction: Direction): string {
  const s = JSON.stringify(message);
  decode(s, direction);
  return s;
}

/** The highest version both sides speak, or null. */
export function negotiateVersion(offered: readonly number[], supported: readonly number[] = PROTOCOL_VERSIONS): number | null {
  const common = offered.filter((v) => supported.includes(v));
  return common.length ? Math.max(...common) : null;
}

/** The exact text an agent signs to authenticate. Changing it is a protocol version change. */
export function authenticationText(a: { nonce: string; agentId: string; serverId: string; keyFingerprint: string | null; protocolVersion: number }): string {
  return ['servermin-link-auth', `v${a.protocolVersion}`, a.nonce, a.agentId, a.serverId, a.keyFingerprint ?? 'none'].join('\n');
}
