import { readFileSync } from 'node:fs';
import type { TLSSocket } from 'node:tls';
import { WebSocket } from 'ws';
import type { Logger } from '@servermin/sdk';
import { AGENT_ENDPOINT, CLOSE, MAX_FRAME_BYTES, ProtocolError, authSigningInput, createMessage, decode, encode, negotiateVersion, normalizeFingerprint, type Message, type MessageType, type Payloads } from '@servermin/protocol';
import { CORE_VERSION } from '../version';
import type { AgentKey } from './agent-key';
import type { AgentIdentity } from './identity';

export type LinkState = 'DISABLED' | 'CONNECTING' | 'AUTHENTICATING' | 'CONNECTED' | 'WAITING' | 'STOPPED';

export interface LinkStatus {
  /** Whether a Manager is configured at all. */
  configured: boolean;
  url: string | null;
  state: LinkState;
  /** Since when the current connection has been authenticated. */
  connectedSince: string | null;
  lastConnectedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** Failed attempts since the last stable connection. */
  attempts: number;
  nextAttemptAt: string | null;
  protocolVersion: number | null;
}

export interface ManagerLinkOptions {
  /** Base URL of the Manager (`wss://manager:8480` or `https://…`); null disables the link. */
  url: string | null;
  /** SHA-256 fingerprint of the Manager's certificate. When set, exactly that certificate is accepted (self-signed included). */
  fingerprint?: string | null;
  /** PEM file with the CA that signed the Manager's certificate, when it is not publicly trusted and not pinned. */
  caFile?: string | null;
  identity(): AgentIdentity;
  key: AgentKey;
  serverState(): Promise<Payloads['SERVER_STATE']>;
  capabilities(): string[];
  /** The Manager knows this server under another id (an agent reinstalled on a known server). */
  adoptServerId(serverId: string): void;
  logger: Logger;
  /** Reconnect pacing. Defaults: 1 s doubling to 60 s, reset after 30 s of stable connection. */
  backoff?: { minMs?: number; maxMs?: number; stableMs?: number; /** Scales the longer waits after a refusal. Tests use a small value. */ refusedScale?: number };
  handshakeTimeoutMs?: number;
  /** Source of jitter; tests pass a constant. */
  random?: () => number;
}

/** Why the Manager refused or dropped us decides how soon it makes sense to try again. */
const SLOW_RETRY_MS: Record<number, number> = {
  [CLOSE.unauthorized]: 30_000, // not enrolled (yet): a person has to act
  [CLOSE.revoked]: 60_000,
  [CLOSE.replaced]: 60_000, // another agent with our identity is connected
  [CLOSE.protocolVersion]: 300_000, // one side needs an update
};

/**
 * The agent's connection to a Manager (ADR-002). It dials out, proves the agent's identity,
 * reports state, and keeps itself alive: any failure, on either side, at any point, ends in a
 * scheduled reconnect with jittered exponential backoff. Nothing here can fail the agent itself;
 * a server without its Manager keeps working exactly as a standalone server.
 */
export class ManagerLink {
  private ws: WebSocket | null = null;
  private state: LinkState;
  private readonly endpoint: string | null;
  private readonly pinned: string | null;
  private attempts = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private changeTimer: NodeJS.Timeout | null = null;
  private seq = 0;
  private pendingHeartbeats = new Set<string>();
  private dropped = new WeakSet<WebSocket>();
  private lastAckAt = 0;
  private heartbeatTimeoutMs = 0;
  private version: number | null = null;
  private tlsFingerprint = '';
  private connectedSince: number | null = null;
  private lastConnectedAt: number | null = null;
  private lastError: string | null = null;
  private lastErrorAt: number | null = null;
  private nextAttemptAt: number | null = null;
  private lastSent: Partial<Record<MessageType, string>> = {};
  private readonly min: number;
  private readonly max: number;
  private readonly stable: number;

  constructor(private readonly o: ManagerLinkOptions) {
    this.endpoint = o.url ? ManagerLink.endpointFor(o.url) : null;
    this.pinned = o.fingerprint ? normalizeFingerprint(o.fingerprint) : null;
    this.state = this.endpoint ? 'STOPPED' : 'DISABLED';
    this.min = o.backoff?.minMs ?? 1000;
    this.max = o.backoff?.maxMs ?? 60_000;
    this.stable = o.backoff?.stableMs ?? 30_000;
  }

  /** `https://m:8480/` → `wss://m:8480/api/v1/agents/ws`. */
  static endpointFor(url: string): string {
    const u = new URL(url);
    u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
    u.pathname = AGENT_ENDPOINT;
    u.search = '';
    u.hash = '';
    return u.toString();
  }

  start() {
    if (!this.endpoint || this.state !== 'STOPPED') return;
    this.o.logger.info(`Connecting to the Manager at ${this.endpoint}`, { pinned: !!this.pinned });
    this.connect();
  }

  stop() {
    if (this.state === 'DISABLED') return;
    this.state = 'STOPPED';
    this.clearTimers();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextAttemptAt = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => undefined);
      try {
        ws.close(CLOSE.shuttingDown, 'agent stopping');
      } catch {
        ws.terminate();
      }
    }
  }

  status(): LinkStatus {
    const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);
    return {
      configured: !!this.endpoint,
      url: this.endpoint,
      state: this.state,
      connectedSince: iso(this.connectedSince),
      lastConnectedAt: iso(this.lastConnectedAt),
      lastError: this.lastError,
      lastErrorAt: iso(this.lastErrorAt),
      attempts: this.attempts,
      nextAttemptAt: iso(this.nextAttemptAt),
      protocolVersion: this.version,
    };
  }

  /** Call when the server's state or capabilities may have changed; sends only what actually differs. */
  notifyChanged() {
    if (this.state !== 'CONNECTED' || this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      void this.sendReports();
    }, 300);
    this.changeTimer.unref();
  }

  // ── Connection ─────────────────────────────────────────────────────────────────

  private connect() {
    this.state = 'CONNECTING';
    this.nextAttemptAt = null;
    this.version = null;
    this.tlsFingerprint = '';
    this.lastSent = {};
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.endpoint!, {
        handshakeTimeout: this.o.handshakeTimeoutMs ?? 10_000,
        maxPayload: MAX_FRAME_BYTES,
        perMessageDeflate: false,
        headers: { 'user-agent': `servermin-agent/${CORE_VERSION}` },
        // A pinned certificate is checked by its fingerprint below, so chain and name checks are
        // replaced, not removed. Without a pin, normal verification applies.
        rejectUnauthorized: !this.pinned,
        ...(this.o.caFile ? { ca: readFileSync(this.o.caFile) } : {}),
      });
    } catch (e) {
      return this.failed(`Cannot connect: ${(e as Error).message}`);
    }
    this.ws = ws;
    const mine = () => this.ws === ws;

    ws.on('upgrade', (res) => {
      if (!mine()) return;
      const socket = res.socket as TLSSocket;
      if (typeof socket.getPeerCertificate !== 'function') return; // plain ws://
      const fp = normalizeFingerprint(socket.getPeerCertificate()?.fingerprint256 ?? '');
      if (!fp) return this.drop(ws, 'The Manager presented no certificate');
      if (this.pinned && fp !== this.pinned) return this.drop(ws, `The Manager's certificate (${fp}) is not the pinned one; refusing to authenticate`);
      this.tlsFingerprint = fp;
    });
    ws.on('open', () => {
      if (!mine()) return;
      this.state = 'AUTHENTICATING';
      // The Manager speaks first (HELLO). If nothing arrives, this is not a Manager.
      this.handshakeTimer = setTimeout(() => this.drop(ws, 'The Manager did not complete the handshake in time'), this.o.handshakeTimeoutMs ?? 10_000);
    });
    ws.on('message', (raw, isBinary) => {
      if (!mine()) return;
      if (isBinary) return this.drop(ws, 'The Manager sent a binary frame');
      let message: Message;
      try {
        message = decode(raw as Buffer);
      } catch (e) {
        // A type this version does not know is skipped (a newer Manager); anything else ends the connection.
        if (e instanceof ProtocolError && e.code === 'unsupported') return;
        return this.drop(ws, `The Manager sent an invalid message: ${(e as Error).message}`);
      }
      try {
        this.receive(ws, message);
      } catch (e) {
        this.drop(ws, `Failed to handle ${message.type}: ${(e as Error).message}`);
      }
    });
    ws.on('error', (e) => {
      // After we dropped a connection ourselves, the reason we gave is the one to keep.
      if (mine() && !this.dropped.has(ws)) this.noteError(describeSocketError(e));
    });
    ws.on('close', (code, reason) => {
      if (!mine()) return;
      this.ws = null;
      const wasConnected = this.state === 'CONNECTED';
      this.clearTimers();
      if (this.state === 'STOPPED') return;
      const why = reason?.toString() || (wasConnected ? 'connection lost' : 'connection closed');
      if (wasConnected) this.o.logger.warn(`Disconnected from the Manager (${code} ${why})`);
      if (!this.dropped.has(ws) && (!this.lastErrorAt || wasConnected || Date.now() - this.lastErrorAt > 1000)) this.noteError(`${why} (code ${code})`);
      this.connectedSince = null;
      this.scheduleReconnect(SLOW_RETRY_MS[code] ?? 0);
    });
  }

  private receive(ws: WebSocket, m: Message) {
    switch (m.type) {
      case 'HELLO': {
        if (this.state !== 'AUTHENTICATING' || this.version !== null) throw new Error('unexpected HELLO');
        const hello = m.payload as Payloads['HELLO'];
        const version = negotiateVersion(hello.versions);
        if (version === null) {
          this.noteError(`The Manager speaks protocol versions ${hello.versions.join(', ')}, which this agent (${CORE_VERSION}) does not; update one of them`);
          return ws.close(CLOSE.protocolVersion, 'no common protocol version');
        }
        this.version = version;
        const { agentId, serverId } = this.o.identity();
        const signature = this.o.key.sign(authSigningInput({ nonce: hello.nonce, agentId, serverId, version, tlsFingerprint: this.tlsFingerprint }));
        return this.send(ws, createMessage('AUTHENTICATION', { agentId, serverId, version, signature }, m.id, version));
      }
      case 'AUTHENTICATED': {
        if (this.state !== 'AUTHENTICATING' || this.version === null) throw new Error('unexpected AUTHENTICATED');
        const p = m.payload as Payloads['AUTHENTICATED'];
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
        if (p.serverId !== this.o.identity().serverId) {
          this.o.logger.info('The Manager knows this server under another server id; adopting it', { serverId: p.serverId });
          this.o.adoptServerId(p.serverId);
        }
        this.state = 'CONNECTED';
        this.connectedSince = this.lastConnectedAt = Date.now();
        this.lastError = null;
        this.lastErrorAt = null;
        this.o.logger.info('Connected to the Manager', { protocol: this.version, serverId: p.serverId });
        // Only a connection that lasts counts as success; one that is dropped at once keeps backing off.
        this.stableTimer = setTimeout(() => (this.attempts = 0), this.stable);
        this.stableTimer.unref();
        this.heartbeatTimeoutMs = p.heartbeatTimeoutMs;
        this.lastAckAt = Date.now();
        this.heartbeatTimer = setInterval(() => this.heartbeat(ws), p.heartbeatIntervalMs);
        void this.sendReports();
        return;
      }
      case 'HEARTBEAT':
        if (m.correlationId && this.pendingHeartbeats.delete(m.correlationId)) this.lastAckAt = Date.now();
        return;
      case 'ERROR': {
        const p = m.payload as Payloads['ERROR'];
        this.noteError(`The Manager refused: ${p.message} (${p.code})`);
        return;
      }
      default:
        // Valid, but nothing an agent acts on in this version.
        return;
    }
  }

  private heartbeat(ws: WebSocket) {
    if (Date.now() - this.lastAckAt > this.heartbeatTimeoutMs) return this.drop(ws, 'The Manager stopped answering heartbeats');
    const m = createMessage('HEARTBEAT', { seq: ++this.seq }, undefined, this.version!);
    // An answer to any recent heartbeat proves the Manager is alive; a late one must not be lost.
    this.pendingHeartbeats.add(m.id);
    if (this.pendingHeartbeats.size > 8) this.pendingHeartbeats.delete(this.pendingHeartbeats.values().next().value!);
    this.send(ws, m);
  }

  private async sendReports() {
    const ws = this.ws;
    if (!ws || this.state !== 'CONNECTED') return;
    try {
      const state = await this.o.serverState();
      if (this.ws !== ws || this.state !== 'CONNECTED') return;
      this.sendIfChanged(ws, 'SERVER_STATE', state);
      this.sendIfChanged(ws, 'CAPABILITIES', { capabilities: this.o.capabilities() });
    } catch (e) {
      this.o.logger.warn(`Could not report state to the Manager: ${(e as Error).message}`);
    }
  }

  private sendIfChanged<T extends 'SERVER_STATE' | 'CAPABILITIES'>(ws: WebSocket, type: T, payload: Payloads[T]) {
    const json = JSON.stringify(payload);
    if (this.lastSent[type] === json) return;
    this.lastSent[type] = json;
    this.send(ws, createMessage(type, payload, undefined, this.version!));
  }

  private send(ws: WebSocket, m: Message) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(encode(m), (err) => {
      if (err && this.ws === ws) this.noteError(`send failed: ${err.message}`);
    });
  }

  /** Ends a connection we no longer trust or that stopped responding; `close` then schedules the retry. */
  private drop(ws: WebSocket, reason: string) {
    if (this.ws !== ws) return;
    this.noteError(reason);
    this.dropped.add(ws);
    ws.terminate();
  }

  private failed(reason: string) {
    this.noteError(reason);
    this.ws = null;
    this.scheduleReconnect(0);
  }

  private noteError(message: string) {
    if (this.lastError !== message) this.o.logger.warn(`Manager link: ${message}`);
    this.lastError = message;
    this.lastErrorAt = Date.now();
  }

  private scheduleReconnect(atLeastMs: number) {
    if (this.state === 'STOPPED' || this.state === 'DISABLED') return;
    const base = Math.min(this.max, this.min * 2 ** Math.min(this.attempts, 20));
    // Full jitter in the upper half: many agents that lost the same Manager do not return in step.
    const delay = Math.max(Math.round(atLeastMs * (this.o.backoff?.refusedScale ?? 1)), Math.round(base * (0.5 + (this.o.random ?? Math.random)() * 0.5)));
    this.attempts++;
    this.state = 'WAITING';
    this.nextAttemptAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.state === 'WAITING') this.connect();
    }, delay);
    this.retryTimer.unref();
  }

  private clearTimers() {
    for (const t of [this.handshakeTimer, this.stableTimer, this.changeTimer]) if (t) clearTimeout(t);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.handshakeTimer = this.stableTimer = this.changeTimer = this.heartbeatTimer = null;
    this.pendingHeartbeats.clear();
  }
}

function describeSocketError(e: Error & { code?: string }): string {
  switch (e.code) {
    case 'ECONNREFUSED':
      return 'connection refused (is the Manager running?)';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'the Manager host name cannot be resolved';
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'the Manager cannot be reached over the network';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return "the Manager's certificate is not trusted; set agent.manager.fingerprint to pin it, or agent.manager.ca";
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return "the Manager's certificate is for a different host name";
    case 'CERT_HAS_EXPIRED':
      return "the Manager's certificate has expired";
    default:
      return e.message;
  }
}
