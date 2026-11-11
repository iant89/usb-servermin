import { randomBytes } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { WebSocket } from 'ws';
import type { Logger } from '@servermin/sdk';
import {
  CLOSE,
  MAX_FRAME_BYTES,
  ProtocolError,
  authenticationText,
  decode,
  encode,
  envelope,
  negotiateVersion,
  type AnyMessage,
  type ErrorCode,
  type HeartbeatPayload,
  type MessageType,
  type PayloadByType,
  type ServerStatePayload,
} from '@servermin/protocol';
import { publicKeyFingerprint } from '../tls/certificate';
import type { AgentKey } from './agent-key';
import type { AgentIdentity } from './identity';

/**
 * - `DISABLED`: no Manager configured; the agent works on its own, as it always has.
 * - `CONNECTING`: opening the connection (TCP, TLS, WebSocket upgrade).
 * - `AUTHENTICATING`: connected, proving who it is.
 * - `CONNECTED`: authenticated; heartbeats flow.
 * - `WAITING`: the last attempt failed or the connection dropped; the next attempt is scheduled.
 * - `STOPPED`: the agent is shutting down.
 */
export type LinkState = 'DISABLED' | 'CONNECTING' | 'AUTHENTICATING' | 'CONNECTED' | 'WAITING' | 'STOPPED';

export interface ManagerLinkStatus {
  url: string | null;
  state: LinkState;
  /** When the current connection authenticated. */
  connectedSince: string | null;
  /** When the agent was last connected (current or previous connection). */
  lastConnectedAt: string | null;
  lastError: string | null;
  /** Failed attempts since the last stable connection. */
  failedAttempts: number;
  nextAttemptAt: string | null;
  sessionId: string | null;
  protocolVersion: number | null;
  /** SHA-256 of the Manager's public key as seen on the last connection. */
  managerKeyFingerprint: string | null;
}

export interface ManagerLinkOptions {
  /** `wss://manager:8480` (the path is added) or a full URL. */
  url: string;
  /** Pinned SHA-256 of the Manager's public key; when set, it replaces certificate-authority checks. */
  fingerprint: string | null;
  /** PEM of the certificate authorities to trust instead of the system's, for a Manager with its own certificate. */
  ca: string | null;
  key: AgentKey;
  identity(): AgentIdentity;
  version: string;
  heartbeat(): Omit<HeartbeatPayload, 'sequence'>;
  /** Changes in this list or in health trigger a new SERVER_STATE. */
  capabilities(): string[];
  report(): Promise<ServerStatePayload>;
  logger: Logger;
  onChange?(status: ManagerLinkStatus): void;
  backoff?: { initialMs: number; maxMs: number };
  /** Everything up to AUTHENTICATED must finish within this time. */
  connectTimeoutMs?: number;
  /** A connection that lasted this long resets the backoff. */
  stableAfterMs?: number;
  random?: () => number;
}

/**
 * Exponential backoff with "equal jitter": half the delay is fixed, half random. The fixed half
 * keeps a crowd of agents from reconnecting in a burst; the random half spreads them out.
 */
export function backoffDelay(attempt: number, initialMs: number, maxMs: number, random: () => number = Math.random): number {
  const base = Math.min(maxMs, initialMs * 2 ** Math.min(attempt, 30));
  return Math.round(base / 2 + random() * (base / 2));
}

/** Resolves the link URL: a bare `wss://host:port` gets the protocol path. */
export function linkUrl(url: string, path: string): string {
  const u = new URL(url);
  if (u.pathname === '/' || u.pathname === '') u.pathname = path;
  return u.toString();
}

const newId = () => randomBytes(12).toString('base64url');

/** Problems that a retry soon will not fix: retried, but at the longest interval. */
const FATAL_CLOSE: Record<number, string> = {
  [CLOSE.AUTH_FAILED]: 'The Manager refused this agent (unknown agent, revoked, or wrong key)',
  [CLOSE.DUPLICATE]: 'The Manager already has a live connection for this agent id (a cloned installation?)',
  [CLOSE.UNSUPPORTED_VERSION]: 'The Manager and this agent share no protocol version',
};

interface Failure {
  message: string;
  fatal: boolean;
}

/**
 * The agent's connection to its Manager (ADR-002). Reconnects on its own, forever, with backoff;
 * nothing is queued while disconnected because the full state is sent again on every connection.
 */
export class ManagerLink {
  private ws: WebSocket | null = null;
  private stateValue: LinkState = 'WAITING';
  private stopping = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private failedAttempts = 0;
  private connectedSince: number | null = null;
  private lastConnectedAt: number | null = null;
  private lastError: string | null = null;
  private nextAttemptAt: number | null = null;
  private sessionId: string | null = null;
  private protocolVersion: number | null = null;
  private seenFingerprint: string | null = null;
  private readonly url: string;
  private readonly initialMs: number;
  private readonly maxMs: number;
  private readonly random: () => number;

  constructor(private readonly o: ManagerLinkOptions) {
    this.url = o.url;
    this.initialMs = o.backoff?.initialMs ?? 1000;
    this.maxMs = o.backoff?.maxMs ?? 60_000;
    this.random = o.random ?? Math.random;
  }

  get state(): LinkState {
    return this.stateValue;
  }

  status(): ManagerLinkStatus {
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    return {
      url: this.url,
      state: this.stateValue,
      connectedSince: iso(this.connectedSince),
      lastConnectedAt: iso(this.lastConnectedAt),
      lastError: this.lastError,
      failedAttempts: this.failedAttempts,
      nextAttemptAt: iso(this.nextAttemptAt),
      sessionId: this.sessionId,
      protocolVersion: this.protocolVersion,
      managerKeyFingerprint: this.seenFingerprint,
    };
  }

  start() {
    this.stopping = false;
    this.connect();
  }

  /** Closes the connection and stops reconnecting. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.nextAttemptAt = null;
    const ws = this.ws;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          ws.terminate();
          resolve();
        }, 2000);
        ws.once('close', () => {
          clearTimeout(force);
          resolve();
        });
        if (ws.readyState === WebSocket.OPEN) ws.close(CLOSE.GOING_AWAY, 'Agent stopping');
        else ws.terminate();
      });
    }
    this.clearTimers();
    this.setState('STOPPED');
  }

  private setState(state: LinkState) {
    if (state === this.stateValue) return;
    this.stateValue = state;
    this.o.onChange?.(this.status());
  }

  private clearTimers() {
    for (const t of [this.heartbeatTimer, this.watchdogTimer, this.connectTimer]) if (t) clearTimeout(t);
    this.heartbeatTimer = this.watchdogTimer = this.connectTimer = null;
  }

  private connect() {
    if (this.stopping) return;
    this.reconnectTimer = null;
    this.nextAttemptAt = null;
    this.seenFingerprint = null;
    this.setState('CONNECTING');
    const pinned = this.o.fingerprint;
    let failure: Failure | null = null;
    const fail = (f: Failure) => (failure ??= f);

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url, {
        maxPayload: MAX_FRAME_BYTES,
        perMessageDeflate: false,
        handshakeTimeout: this.o.connectTimeoutMs ?? 10_000,
        // A pinned key replaces the certificate-authority check; it is verified below before anything is sent.
        rejectUnauthorized: !pinned,
        ...(this.o.ca ? { ca: this.o.ca } : {}),
        headers: { 'user-agent': `servermin-agent/${this.o.version}` },
      });
    } catch (e) {
      this.scheduleReconnect({ message: `Invalid Manager URL: ${(e as Error).message}`, fatal: true });
      return;
    }
    this.ws = ws;
    this.connectTimer = setTimeout(() => {
      fail({ message: 'Timed out connecting to the Manager', fatal: false });
      ws.terminate();
    }, this.o.connectTimeoutMs ?? 10_000);

    // Phase of the handshake: HELLO → AUTHENTICATE → AUTHENTICATED.
    let phase: 'hello' | 'auth' | 'ready' = 'hello';
    let authId = '';
    let lastHeard = Date.now();
    let sequence = 0;
    let sentStateKey = '';

    const send = <T extends MessageType>(type: T, payload: PayloadByType[T], correlationId?: string) => {
      const id = newId();
      if (ws.readyState === WebSocket.OPEN) ws.send(encode(envelope(type, id, payload, correlationId), 'toManager'));
      return id;
    };
    const abort = (code: number, err: { code: ErrorCode; message: string }, f: Failure) => {
      fail(f);
      try {
        send('ERROR', err);
      } catch {
        /* the connection may already be gone */
      }
      ws.close(code, err.message.slice(0, 120));
    };
    const stateKey = () => JSON.stringify([this.o.capabilities(), this.o.heartbeat().health]);
    const sendState = async () => {
      const key = stateKey();
      try {
        const report = await this.o.report();
        if (ws.readyState !== WebSocket.OPEN) return;
        send('SERVER_STATE', report);
        sentStateKey = key;
      } catch (e) {
        this.o.logger.warn('Could not send the server state to the Manager', { error: (e as Error).message });
      }
    };

    ws.on('upgrade', (res) => {
      const socket = res.socket as TLSSocket;
      if (typeof socket.getPeerCertificate === 'function') {
        const raw = socket.getPeerCertificate(false)?.raw;
        this.seenFingerprint = raw ? publicKeyFingerprint(raw) : null;
        if (pinned && this.seenFingerprint !== pinned) {
          fail({ message: `The Manager's key (${this.seenFingerprint ?? 'none'}) is not the pinned key ${pinned}; not connecting`, fatal: true });
          ws.terminate();
          socket.destroy();
        }
      } else if (pinned) {
        fail({ message: 'A Manager key is pinned but the connection is not encrypted (use wss://)', fatal: true });
        ws.terminate();
        res.socket.destroy();
      }
    });

    ws.on('message', (data, isBinary) => {
      lastHeard = Date.now();
      let msg: AnyMessage;
      try {
        if (isBinary) throw new ProtocolError('Binary frames are not part of the protocol');
        msg = decode(data as Buffer, 'toAgent');
      } catch (e) {
        return abort(CLOSE.PROTOCOL_ERROR, { code: 'protocol-error', message: (e as Error).message }, { message: `The Manager sent an invalid message: ${(e as Error).message}`, fatal: false });
      }
      switch (msg.type) {
        case 'HELLO': {
          if (phase !== 'hello') return abort(CLOSE.PROTOCOL_ERROR, { code: 'protocol-error', message: 'Unexpected HELLO' }, { message: 'The Manager sent HELLO twice', fatal: false });
          const version = negotiateVersion(msg.payload.protocolVersions);
          if (version === null)
            return abort(CLOSE.UNSUPPORTED_VERSION, { code: 'unsupported-version', message: 'No common protocol version' }, { message: `${FATAL_CLOSE[CLOSE.UNSUPPORTED_VERSION]} (Manager ${msg.payload.managerVersion} offers ${msg.payload.protocolVersions.join(', ')})`, fatal: true });
          const id = this.o.identity();
          const signature = this.o.key.sign(authenticationText({ nonce: msg.payload.nonce, agentId: id.agentId, serverId: id.serverId, keyFingerprint: this.seenFingerprint, protocolVersion: version }));
          authId = send('AUTHENTICATE', { protocolVersion: version, agentId: id.agentId, serverId: id.serverId, agentVersion: this.o.version, keyFingerprint: this.seenFingerprint, signature }, msg.id);
          this.protocolVersion = version;
          phase = 'auth';
          this.setState('AUTHENTICATING');
          return;
        }
        case 'AUTHENTICATED': {
          if (phase !== 'auth' || msg.correlationId !== authId) return abort(CLOSE.PROTOCOL_ERROR, { code: 'protocol-error', message: 'Unexpected AUTHENTICATED' }, { message: 'The Manager answered out of order', fatal: false });
          phase = 'ready';
          if (this.connectTimer) clearTimeout(this.connectTimer);
          this.connectTimer = null;
          const { heartbeatIntervalMs, timeoutMs, sessionId } = msg.payload;
          this.sessionId = sessionId;
          this.connectedSince = this.lastConnectedAt = Date.now();
          if (this.failedAttempts > 0) this.o.logger.info(`Connected to the Manager after ${this.failedAttempts} failed attempt(s)`, { url: this.url, sessionId });
          else this.o.logger.info('Connected to the Manager', { url: this.url, sessionId });
          this.lastError = null;
          this.setState('CONNECTED');
          void sendState();
          this.heartbeatTimer = setInterval(() => {
            send('HEARTBEAT', { sequence: ++sequence, ...this.o.heartbeat() });
            if (stateKey() !== sentStateKey) void sendState();
          }, heartbeatIntervalMs);
          // The Manager acknowledges every heartbeat; silence for timeoutMs means the connection is dead even if TCP has not noticed.
          this.watchdogTimer = setInterval(
            () => {
              if (Date.now() - lastHeard > timeoutMs) {
                fail({ message: `No answer from the Manager for ${timeoutMs} ms`, fatal: false });
                ws.terminate();
              }
            },
            Math.max(25, Math.min(heartbeatIntervalMs, Math.floor(timeoutMs / 4))),
          );
          return;
        }
        case 'HEARTBEAT_ACK':
          return;
        case 'ERROR':
        {
          const close = ({ 'auth-failed': CLOSE.AUTH_FAILED, duplicate: CLOSE.DUPLICATE, 'unsupported-version': CLOSE.UNSUPPORTED_VERSION } as Record<string, number>)[msg.payload.code];
          fail(close ? { message: `${FATAL_CLOSE[close]} (Manager: ${msg.payload.message})`, fatal: true } : { message: `The Manager reported: ${msg.payload.message}`, fatal: false });
        }
          return;
      }
    });

    ws.on('error', (e) => fail({ message: e.message, fatal: false }));

    ws.on('close', (code, reason) => {
      this.clearTimers();
      if (this.ws === ws) this.ws = null;
      const wasConnected = this.connectedSince;
      this.connectedSince = null;
      this.sessionId = null;
      if (this.stopping) return;
      const described: Failure =
        failure ??
        (FATAL_CLOSE[code]
          ? { message: FATAL_CLOSE[code], fatal: true }
          : { message: code === CLOSE.GOING_AWAY ? 'The Manager is shutting down' : code === CLOSE.REPLACED ? 'Replaced by a newer connection' : `Connection closed (${code}${reason.length ? `: ${reason.toString()}` : ''})`, fatal: false });
      // A connection that lasted resets the backoff; one that drops right after connecting does not, so a flapping Manager is not hammered.
      if (wasConnected !== null && Date.now() - wasConnected >= (this.o.stableAfterMs ?? 30_000)) this.failedAttempts = 0;
      this.scheduleReconnect(described);
    });
  }

  private scheduleReconnect(f: Failure) {
    if (this.stopping) return;
    const changed = f.message !== this.lastError;
    this.lastError = f.message;
    const delay = f.fatal ? backoffDelay(30, this.initialMs, this.maxMs, this.random) : backoffDelay(this.failedAttempts, this.initialMs, this.maxMs, this.random);
    this.failedAttempts++;
    this.nextAttemptAt = Date.now() + delay;
    // The same failure every minute for a day would flood the journal: log it when it changes.
    if (changed) this.o.logger.warn(`Manager connection: ${f.message}`, { url: this.url, retryInMs: delay });
    else this.o.logger.debug(`Manager connection: ${f.message}`, { url: this.url, retryInMs: delay, attempt: this.failedAttempts });
    this.setState('WAITING');
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
