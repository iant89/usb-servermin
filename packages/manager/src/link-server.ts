import { randomBytes, randomUUID, verify } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from '@servermin/sdk';
import { AttemptLimiter, CORE_VERSION, type AuditLog, type EventBus } from '@servermin/core';
import {
  CLOSE,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSIONS,
  ProtocolError,
  authenticationText,
  decode,
  encode,
  envelope,
  type AnyMessage,
  type AuthenticatePayload,
  type ErrorCode,
  type MessageType,
  type PayloadByType,
} from '@servermin/protocol';
import type { AgentRegistry } from './agents';
import type { ManagerConfig } from './config';
import type { Inventory, ServerRecord } from './inventory';

const MAX_MESSAGES_PER_10S = 200;
const MAX_PENDING = 256;
const MAX_PENDING_PER_ADDRESS = 16;
/** last_seen_at is written at most this often while heartbeats flow; liveness itself is kept in memory. */
const LAST_SEEN_WRITE_MS = 60_000;

export interface LinkServerDeps {
  logger: Logger;
  audit: AuditLog;
  bus: EventBus;
  inventory: Inventory;
  agents: AgentRegistry;
  config: ManagerConfig['agents'];
  /** SHA-256 of the Manager's TLS public key; null without TLS. */
  keyFingerprint: string | null;
}

interface LiveConnection {
  ws: WebSocket;
  agentId: string;
  serverId: string;
  sessionId: string;
  address: string | null;
  protocolVersion: number;
  connectedAt: number;
  lastHeard: number;
  lastSeenWritten: number;
  stale: boolean;
}

export interface ConnectionInfo {
  sessionId: string;
  address: string | null;
  protocolVersion: number;
  connectedAt: string;
  lastHeardAt: string;
  stale: boolean;
}

/** Authentication failures that are reported to the agent only as "Authentication failed". */
class AuthFailure extends Error {
  constructor(
    readonly reason: string,
    readonly close: number = CLOSE.AUTH_FAILED,
    readonly code: ErrorCode = 'auth-failed',
  ) {
    super(reason);
  }
}

/**
 * The Manager's endpoint for agents (ADR-002), at `LINK_PATH` on the Manager's port, separate
 * from the browser WebSocket. It owns the connection side of a server's state: ONLINE while
 * heartbeats arrive, STALE when they stop, OFFLINE when the connection is gone.
 */
export class AgentLinkServer {
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
  private pending = new Map<WebSocket, string>();
  private live = new Map<string, LiveConnection>();
  /** Agents whose existing connection is being probed for a duplicate. */
  private probing = new Set<string>();
  /** Failed handshakes per address; a locked-out address is refused before the WebSocket upgrade. */
  private failures = new AttemptLimiter(10, 10 * 60_000, 15 * 60_000);
  private sweep: NodeJS.Timeout;
  private unsubscribe: () => void;
  private closed = false;

  constructor(private readonly d: LinkServerDeps) {
    const c = d.config;
    this.sweep = setInterval(() => this.checkLiveness(), Math.max(25, Math.floor(c.heartbeatIntervalMs / 2)));
    this.sweep.unref();
    // A removed server's agent loses its access at once.
    this.unsubscribe = d.bus.subscribe(
      'inventory.server.removed',
      (e) => {
        const server = (e.payload as { server: ServerRecord }).server;
        if (!server.agentId) return;
        d.agents.forget(server.agentId);
        const conn = this.live.get(server.agentId);
        if (conn) this.drop(conn, CLOSE.AUTH_FAILED, 'auth-failed', 'The server was removed from the Manager');
      },
      'manager',
    );
  }

  /** Handles an HTTP upgrade to `LINK_PATH`. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const address = req.socket.remoteAddress ?? null;
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (this.closed) return reject(503, 'Service Unavailable');
    if (address && this.failures.isLocked(address)) return reject(429, 'Too Many Requests');
    let fromAddress = 0;
    for (const a of this.pending.values()) if (a === address) fromAddress++;
    if (this.pending.size >= MAX_PENDING || fromAddress >= MAX_PENDING_PER_ADDRESS) return reject(503, 'Service Unavailable');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, address));
  }

  private onConnection(ws: WebSocket, address: string | null) {
    const c = this.d.config;
    const log = this.d.logger;
    this.pending.set(ws, address ?? '');
    const send = <T extends MessageType>(type: T, payload: PayloadByType[T], correlationId?: string) => {
      const id = randomBytes(12).toString('base64url');
      if (ws.readyState === ws.OPEN) ws.send(encode(envelope(type, id, payload, correlationId), 'toAgent'));
      return id;
    };
    const fail = (close: number, code: ErrorCode, message: string) => {
      send('ERROR', { code, message });
      ws.close(close, message.slice(0, 120));
    };

    const nonce = randomBytes(32).toString('base64url');
    const helloId = send('HELLO', { managerVersion: CORE_VERSION, protocolVersions: [...PROTOCOL_VERSIONS], nonce });
    const authTimer = setTimeout(() => {
      if (address) this.failures.fail(address);
      log.debug('Agent connection closed: no authentication in time', { address });
      fail(CLOSE.TIMEOUT, 'timeout', 'No authentication in time');
    }, c.authTimeoutMs);

    let conn: LiveConnection | null = null;
    let authenticating = false;
    let window = Date.now();
    let count = 0;

    ws.on('message', (data, isBinary) => {
      if (Date.now() - window > 10_000) (window = Date.now()), (count = 0);
      if (++count > MAX_MESSAGES_PER_10S) return fail(CLOSE.RATE_LIMITED, 'rate-limited', 'Too many messages');
      let msg: AnyMessage;
      try {
        if (isBinary) throw new ProtocolError('Binary frames are not part of the protocol');
        msg = decode(data as Buffer, 'toManager');
      } catch (e) {
        if (!conn && address) this.failures.fail(address);
        log.warn('Invalid message from an agent connection', { address, agentId: conn?.agentId, error: (e as Error).message });
        const pe = e as ProtocolError;
        return fail(pe.code === 'unsupported-version' ? CLOSE.UNSUPPORTED_VERSION : CLOSE.PROTOCOL_ERROR, pe.code ?? 'protocol-error', pe.message);
      }

      if (!conn) {
        if (authenticating) return fail(CLOSE.PROTOCOL_ERROR, 'protocol-error', 'Message before authentication finished');
        if (msg.type !== 'AUTHENTICATE' || msg.correlationId !== helloId) {
          if (address) this.failures.fail(address);
          return fail(CLOSE.PROTOCOL_ERROR, 'protocol-error', 'The first message must be AUTHENTICATE answering HELLO');
        }
        authenticating = true;
        void this.authenticate(ws, msg.payload, nonce, address)
          .then((accepted) => {
            clearTimeout(authTimer);
            conn = accepted;
            if (ws.readyState !== ws.OPEN) return;
            send('AUTHENTICATED', { sessionId: conn.sessionId, protocolVersion: conn.protocolVersion, serverId: conn.serverId, heartbeatIntervalMs: c.heartbeatIntervalMs, timeoutMs: c.timeoutMs }, msg.id);
            authenticating = false;
          })
          .catch((e: unknown) => {
            clearTimeout(authTimer);
            const f = e instanceof AuthFailure ? e : new AuthFailure(`internal error: ${(e as Error).message}`, CLOSE.AUTH_FAILED, 'internal');
            if (f.code !== 'duplicate' && address) this.failures.fail(address);
            if (f.code !== 'duplicate') {
              this.d.audit.record({ action: 'agent.authenticate', target: msg.payload.agentId, result: 'failure', ip: address ?? undefined, metadata: { reason: f.reason, serverId: msg.payload.serverId } });
              log.warn(`Agent authentication failed: ${f.reason}`, { address, agentId: msg.payload.agentId });
            }
            // The agent learns that it failed, not why: the reason is for the administrator.
            fail(f.close, f.code === 'internal' ? 'auth-failed' : f.code, f.code === 'duplicate' || f.code === 'unsupported-version' ? f.reason : 'Authentication failed');
          });
        return;
      }

      conn.lastHeard = Date.now();
      switch (msg.type) {
        case 'HEARTBEAT': {
          send('HEARTBEAT_ACK', { sequence: msg.payload.sequence }, msg.id);
          const now = Date.now();
          if (conn.stale) {
            conn.stale = false;
            conn.lastSeenWritten = now;
            this.d.inventory.setLiveState(conn.serverId, 'ONLINE', { lastSeenAt: new Date(now).toISOString() });
            log.info('Agent heartbeats resumed', { agentId: conn.agentId, serverId: conn.serverId });
          } else if (now - conn.lastSeenWritten >= LAST_SEEN_WRITE_MS) {
            conn.lastSeenWritten = now;
            this.d.inventory.setLiveState(conn.serverId, 'ONLINE', { lastSeenAt: new Date(now).toISOString() });
          }
          return;
        }
        case 'SERVER_STATE':
          this.d.agents.recordReport(conn.agentId, msg.payload);
          this.d.inventory.setLiveState(conn.serverId, conn.stale ? 'STALE' : 'ONLINE', { agentVersion: msg.payload.version });
          this.d.bus.publish('agent.state', { serverId: conn.serverId, agentId: conn.agentId, health: msg.payload.health, capabilities: msg.payload.capabilities }, 'manager');
          return;
        case 'ERROR':
          log.warn(`Agent reported: ${msg.payload.message}`, { agentId: conn.agentId, code: msg.payload.code });
          return;
        case 'AUTHENTICATE':
          return fail(CLOSE.PROTOCOL_ERROR, 'protocol-error', 'Already authenticated');
      }
    });

    ws.on('error', (e) => log.debug('Agent connection error', { address, error: e.message }));

    ws.on('close', (code) => {
      clearTimeout(authTimer);
      this.pending.delete(ws);
      if (!conn || this.live.get(conn.agentId) !== conn) return;
      this.live.delete(conn.agentId);
      if (this.closed) return;
      this.d.inventory.setLiveState(conn.serverId, 'OFFLINE', { lastSeenAt: new Date(conn.lastHeard).toISOString() });
      this.d.bus.publish('agent.disconnected', { serverId: conn.serverId, agentId: conn.agentId, code }, 'manager');
      log.info('Agent disconnected', { agentId: conn.agentId, serverId: conn.serverId, code, connectedSeconds: Math.round((Date.now() - conn.connectedAt) / 1000) });
    });
  }

  /** Verifies AUTHENTICATE and, if a live connection exists for the agent, decides which one stays. */
  private async authenticate(ws: WebSocket, p: AuthenticatePayload, nonce: string, address: string | null): Promise<LiveConnection> {
    if (!(PROTOCOL_VERSIONS as readonly number[]).includes(p.protocolVersion)) throw new AuthFailure(`protocol version ${p.protocolVersion} is not supported`, CLOSE.UNSUPPORTED_VERSION, 'unsupported-version');
    const agent = this.d.agents.get(p.agentId);
    if (!agent) throw new AuthFailure('unknown agent');
    if (agent.serverId !== p.serverId) throw new AuthFailure(`the agent reports server ${p.serverId}, enrolled for ${agent.serverId}`);
    const key = this.d.agents.publicKey(p.agentId)!;
    const text = authenticationText({ nonce, agentId: p.agentId, serverId: p.serverId, keyFingerprint: p.keyFingerprint, protocolVersion: p.protocolVersion });
    let valid = false;
    try {
      valid = verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(p.signature, 'base64url'));
    } catch {
      valid = false;
    }
    if (!valid) throw new AuthFailure('bad signature (wrong key)');
    // Checked after the signature, so the warning below is only ever raised for a real agent.
    if (this.d.keyFingerprint && this.d.config.requireKeyBinding && p.keyFingerprint !== this.d.keyFingerprint)
      throw new AuthFailure(`the agent saw Manager key ${p.keyFingerprint ?? 'none'}, not this Manager's ${this.d.keyFingerprint}: something between them terminates TLS`);

    const duplicate = (liveAddress: string | null) => {
      this.d.audit.record({ action: 'agent.duplicate', target: p.agentId, result: 'failure', ip: address ?? undefined, metadata: { serverId: p.serverId, liveAddress } });
      this.d.bus.publish('agent.duplicate', { agentId: p.agentId, serverId: p.serverId, address, liveAddress }, 'manager');
      this.d.logger.warn('Refused a second connection for an agent that is already connected: two installations share one identity (a cloned disk?)', { agentId: p.agentId, address, liveAddress });
      return new AuthFailure('another connection for this agent is live', CLOSE.DUPLICATE, 'duplicate');
    };
    if (this.probing.has(p.agentId)) throw duplicate(this.live.get(p.agentId)?.address ?? null);
    const existing = this.live.get(p.agentId);
    if (existing) {
      // Is the old connection still there, or dead and not yet timed out (the agent restarted, its network changed)?
      this.probing.add(p.agentId);
      let alive: boolean;
      try {
        alive = await this.answers(existing.ws);
      } finally {
        this.probing.delete(p.agentId);
      }
      if (alive) throw duplicate(existing.address);
      if (this.live.get(p.agentId) === existing) {
        this.live.delete(p.agentId);
        this.d.logger.info('Replacing an agent connection that no longer answers', { agentId: p.agentId, oldAddress: existing.address, address });
        existing.ws.close(CLOSE.REPLACED, 'Replaced by a newer connection');
        existing.ws.terminate();
      }
    }
    if (ws.readyState !== ws.OPEN) throw new AuthFailure('closed during authentication');
    if (this.live.has(p.agentId)) throw new AuthFailure('another connection for this agent is live', CLOSE.DUPLICATE, 'duplicate');

    const now = Date.now();
    const conn: LiveConnection = { ws, agentId: p.agentId, serverId: p.serverId, sessionId: randomUUID(), address, protocolVersion: p.protocolVersion, connectedAt: now, lastHeard: now, lastSeenWritten: now, stale: false };
    this.pending.delete(ws);
    this.live.set(p.agentId, conn);
    if (address) this.failures.succeed(address);
    this.d.agents.recordConnection(p.agentId, address);
    this.d.inventory.setLiveState(p.serverId, 'ONLINE', { agentVersion: p.agentVersion, lastSeenAt: new Date(now).toISOString() });
    this.d.audit.record({ action: 'agent.connect', target: p.agentId, result: 'success', ip: address ?? undefined, metadata: { serverId: p.serverId, sessionId: conn.sessionId, agentVersion: p.agentVersion, protocolVersion: p.protocolVersion } });
    this.d.bus.publish('agent.connected', { serverId: p.serverId, agentId: p.agentId, sessionId: conn.sessionId, address }, 'manager');
    this.d.logger.info('Agent connected', { agentId: p.agentId, serverId: p.serverId, address, sessionId: conn.sessionId, agentVersion: p.agentVersion });
    return conn;
  }

  /** Whether a connection answers a WebSocket ping within the probe time. */
  private answers(ws: WebSocket): Promise<boolean> {
    if (ws.readyState !== ws.OPEN) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (v: boolean) => {
        clearTimeout(timer);
        ws.off('pong', onPong);
        ws.off('close', onClose);
        resolve(v);
      };
      const onPong = () => done(true);
      const onClose = () => done(false);
      const timer = setTimeout(() => done(false), this.d.config.duplicateProbeMs);
      ws.on('pong', onPong);
      ws.on('close', onClose);
      try {
        ws.ping();
      } catch {
        done(false);
      }
    });
  }

  private checkLiveness() {
    const { staleAfterMs, timeoutMs } = this.d.config;
    const now = Date.now();
    for (const conn of this.live.values()) {
      const silent = now - conn.lastHeard;
      if (silent > timeoutMs) {
        this.d.logger.warn('Agent stopped answering; closing its connection', { agentId: conn.agentId, serverId: conn.serverId, silentMs: silent });
        this.drop(conn, CLOSE.TIMEOUT, 'timeout', `No heartbeat for ${silent} ms`);
      } else if (silent > staleAfterMs && !conn.stale) {
        conn.stale = true;
        this.d.inventory.setLiveState(conn.serverId, 'STALE');
        this.d.logger.warn('Agent heartbeats are late', { agentId: conn.agentId, serverId: conn.serverId, silentMs: silent });
      }
    }
  }

  /** Closes a live connection now. Its close handler marks the server OFFLINE. */
  private drop(conn: LiveConnection, close: number, code: ErrorCode, message: string) {
    try {
      conn.ws.send(encode(envelope('ERROR', randomBytes(12).toString('base64url'), { code, message }), 'toAgent'));
    } catch {
      /* already gone */
    }
    conn.ws.close(close, message.slice(0, 120));
    // A peer that does not complete the closing handshake must not keep the connection open.
    setTimeout(() => conn.ws.terminate(), 1000).unref();
  }

  connectedCount(): number {
    return this.live.size;
  }

  connection(agentId: string): ConnectionInfo | null {
    const c = this.live.get(agentId);
    if (!c) return null;
    return { sessionId: c.sessionId, address: c.address, protocolVersion: c.protocolVersion, connectedAt: new Date(c.connectedAt).toISOString(), lastHeardAt: new Date(c.lastHeard).toISOString(), stale: c.stale };
  }

  /** Closes every connection. Servers are marked OFFLINE here, while the database is still open. */
  close() {
    this.closed = true;
    clearInterval(this.sweep);
    this.unsubscribe();
    for (const conn of this.live.values()) this.d.inventory.setLiveState(conn.serverId, 'OFFLINE', { lastSeenAt: new Date(conn.lastHeard).toISOString() });
    const all = [...this.live.values()].map((c) => c.ws).concat([...this.pending.keys()]);
    this.live.clear();
    this.pending.clear();
    for (const ws of all) ws.close(CLOSE.GOING_AWAY, 'Manager shutting down');
    this.wss.close();
  }
}
