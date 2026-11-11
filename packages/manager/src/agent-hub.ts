import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from '@servermin/sdk';
import { AttemptLimiter, CORE_VERSION, TokenBucket, verifyAgentSignature, type AuditLog, type EventBus } from '@servermin/core';
import { AGENT_ENDPOINT, CLOSE, MAX_FRAME_BYTES, PROTOCOL_VERSIONS, ProtocolError, authSigningInput, createMessage, decode, encode, type ErrorCode, type Message, type Payloads } from '@servermin/protocol';
import type { Inventory, ServerState } from './inventory';

/** Connections that have not authenticated yet. Each holds a socket and a timer, nothing else. */
const MAX_PENDING = 200;
/** Unauthenticated connections from one address, so one address cannot take all of MAX_PENDING. */
const MAX_PENDING_PER_ADDRESS = 16;
/** Failed handshakes from one address within the window that lock it out. */
const LOCKOUT_FAILURES = 10;
const LOCKOUT_WINDOW_MS = 10 * 60_000;
const LOCKOUT_MS = 15 * 60_000;
const MAX_MESSAGES_PER_10S = 300;

interface Connection {
  ws: WebSocket;
  ip: string;
  nonce: string;
  version: number | null;
  /** Set once authenticated. */
  agentId?: string;
  serverId?: string;
  health: Payloads['SERVER_STATE']['health'] | null;
  lastHeard: number;
  stale: boolean;
  handshake: NodeJS.Timeout | null;
  /** Signature verified; waiting to learn whether an existing connection for the agent is still alive. */
  authenticating: boolean;
  windowStart: number;
  messages: number;
}

export interface AgentHubOptions {
  inventory: Inventory;
  audit: AuditLog;
  bus: EventBus;
  logger: Logger;
  heartbeatMs: number;
  timeoutMs: number;
  handshakeMs: number;
  /** How long an existing connection has to answer a ping when a second one claims its agent id. */
  duplicateProbeMs: number;
  /** SHA-256 of the Manager's own certificate (lower-case hex), or '' without TLS. Agents sign it, which binds their proof to this Manager. */
  tlsFingerprint: string;
  clientIp(req: IncomingMessage): string;
}

/**
 * The Manager's end of the agent protocol (ADR-002). Agents connect to it; it never connects to
 * an agent. It authenticates each connection against the enrolled public key and derives every
 * server's state from its connection: ONLINE or DEGRADED while heartbeats arrive, STALE when
 * they stop, OFFLINE when the connection is gone.
 */
export class AgentHub {
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
  private pending = new Set<Connection>();
  /** Authenticated connections by agent id. At most one per agent. */
  private agents = new Map<string, Connection>();
  /** Connections waiting for the duplicate probe, by agent id. */
  private probing = new Map<string, Connection>();
  private upgrades = new TokenBucket(30, 2);
  /** Failed handshakes per address. A locked-out address is refused before the WebSocket upgrade. */
  private failures = new AttemptLimiter(LOCKOUT_FAILURES, LOCKOUT_WINDOW_MS, LOCKOUT_MS);
  private sweeper: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly o: AgentHubOptions) {
    this.sweeper = setInterval(() => this.sweep(), Math.max(50, Math.round(o.heartbeatMs / 2)));
    this.sweeper.unref();
    // An agent that was revoked, replaced, or whose server was removed loses its connection at once.
    o.bus.subscribe('inventory.agent.removed', (e) => {
      const { agentId } = e.payload as { agentId: string };
      const c = this.agents.get(agentId);
      if (c) this.end(c, CLOSE.revoked, 'revoked', 'This agent is no longer enrolled');
    }, 'manager');
  }

  /** Takes over an HTTP upgrade for the agent endpoint. Returns false for any other path. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (new URL(req.url ?? '/', 'http://local').pathname !== AGENT_ENDPOINT) return false;
    const refuse = (code: number, text: string) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
      return true;
    };
    const ip = this.o.clientIp(req);
    if (this.closed) return refuse(503, 'Service Unavailable');
    // Browsers always send Origin; agents never do. A page must not be able to open this endpoint.
    if (req.headers.origin) return refuse(403, 'Forbidden');
    if (this.failures.isLocked(ip)) return refuse(429, 'Too Many Requests');
    if (!this.upgrades.take(ip)) return refuse(429, 'Too Many Requests');
    let fromIp = 0;
    for (const p of this.pending) if (p.ip === ip) fromIp++;
    if (this.pending.size >= MAX_PENDING || fromIp >= MAX_PENDING_PER_ADDRESS) return refuse(503, 'Service Unavailable');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, ip));
    return true;
  }

  private accept(ws: WebSocket, ip: string) {
    const c: Connection = { ws, ip, nonce: randomBytes(32).toString('base64'), version: null, health: null, lastHeard: Date.now(), stale: false, handshake: null, authenticating: false, windowStart: Date.now(), messages: 0 };
    this.pending.add(c);
    c.handshake = setTimeout(() => {
      this.failures.fail(ip);
      this.end(c, CLOSE.timeout, 'timeout', 'Authentication timed out');
    }, this.o.handshakeMs);
    ws.on('message', (raw, isBinary) => this.onFrame(c, raw as Buffer, isBinary));
    ws.on('close', () => this.onClose(c));
    ws.on('error', () => undefined); // 'close' follows
    this.send(c, createMessage('HELLO', { versions: [...PROTOCOL_VERSIONS], nonce: c.nonce, manager: { version: CORE_VERSION } }));
  }

  private onFrame(c: Connection, raw: Buffer, isBinary: boolean) {
    // Frames still in flight after we started closing are not processed (and must not cut the close short).
    if (c.ws.readyState !== c.ws.OPEN) return;
    const now = Date.now();
    if (now - c.windowStart > 10_000) (c.windowStart = now), (c.messages = 0);
    if (++c.messages > MAX_MESSAGES_PER_10S) return this.end(c, CLOSE.rateLimited, 'rate-limited', 'Too many messages');
    // The agent waits for AUTHENTICATED; anything sent meanwhile is out of order.
    if (c.authenticating) return this.end(c, CLOSE.unauthorized, 'unauthorized', 'Message before authentication finished');
    if (isBinary) {
      if (!c.agentId) this.failures.fail(c.ip);
      return this.end(c, CLOSE.malformed, 'malformed', 'Binary frames are not part of the protocol');
    }
    let m: Message;
    try {
      m = decode(raw);
    } catch (e) {
      const code = e instanceof ProtocolError ? e.code : 'malformed';
      // Before authentication nothing is tolerated. Afterwards an unknown type is answered and
      // skipped (an agent newer than this Manager); a malformed frame ends the connection.
      if (code === 'unsupported' && c.agentId) return this.send(c, createMessage('ERROR', { code: 'unsupported', message: (e as Error).message }, undefined, c.version ?? undefined));
      if (!c.agentId) this.failures.fail(c.ip);
      return this.end(c, c.agentId ? CLOSE.malformed : CLOSE.unauthorized, c.agentId ? 'malformed' : 'unauthorized', c.agentId ? (e as Error).message : 'Authentication required');
    }
    try {
      if (!c.agentId) return this.authenticate(c, m);
      this.receive(c, m);
    } catch (e) {
      this.o.logger.error(`Agent message ${m.type} failed: ${(e as Error).message}`, { agentId: c.agentId });
      this.end(c, 1011, 'internal', 'Internal error');
    }
  }

  // ── Authentication ─────────────────────────────────────────────────────────────

  private authenticate(c: Connection, m: Message) {
    // One generic answer for every failure: a caller learns nothing about which agents exist.
    // Every failure counts towards the address lockout except an agent that is not enrolled yet:
    // that is the normal state of a new server until someone enrols it, and it retries every 30 s,
    // which would otherwise lock out every agent behind the same NAT address.
    const deny = (reason: string, agentId?: string, counts = true) => {
      if (counts) this.failures.fail(c.ip);
      this.o.audit.record({ action: 'agent.authenticate', target: agentId, result: 'failure', ip: c.ip, metadata: { reason } });
      this.o.logger.warn(`Agent authentication failed: ${reason}`, { ip: c.ip, agentId });
      this.end(c, CLOSE.unauthorized, 'unauthorized', 'Not authorized');
    };
    if (m.type !== 'AUTHENTICATION') return deny(`expected AUTHENTICATION, got ${m.type}`);
    const p = m.payload as Payloads['AUTHENTICATION'];
    if (!(PROTOCOL_VERSIONS as readonly number[]).includes(p.version)) {
      this.o.logger.warn(`Agent asked for protocol version ${p.version}`, { ip: c.ip, agentId: p.agentId });
      return this.end(c, CLOSE.protocolVersion, 'protocol-version', `This Manager speaks protocol versions ${PROTOCOL_VERSIONS.join(', ')}`);
    }
    const credential = this.o.inventory.agentCredential(p.agentId);
    // Verify against the claimed server id: the signature covers what the agent believes it is.
    const signed = authSigningInput({ nonce: c.nonce, agentId: p.agentId, serverId: p.serverId, version: p.version, tlsFingerprint: this.o.tlsFingerprint });
    if (!credential) return deny('agent is not enrolled', p.agentId, false);
    if (!verifyAgentSignature(credential.publicKey, signed, p.signature)) return deny('signature does not match the enrolled key', p.agentId);

    if (c.handshake) clearTimeout(c.handshake);
    c.handshake = null;
    this.pending.delete(c);
    c.version = p.version;
    this.failures.succeed(c.ip);

    const previous = this.agents.get(p.agentId);
    if (this.probing.has(p.agentId)) return this.refuseDuplicate(c, p.agentId, credential.serverId, previous ?? this.probing.get(p.agentId)!);
    if (!previous) return this.admit(c, m, p.agentId, credential.serverId);
    // Usually our side of a connection the agent already lost (it restarted, its network changed).
    // If the old connection still answers, two machines are running with one identity (a cloned
    // disk, a restored backup): the newcomer is refused, so the two do not knock each other off forever.
    c.authenticating = true;
    this.probing.set(p.agentId, c);
    void this.answers(previous).then((alive) => {
      this.probing.delete(p.agentId);
      c.authenticating = false;
      if (c.ws.readyState !== c.ws.OPEN) return;
      if (alive && this.agents.get(p.agentId) === previous) return this.refuseDuplicate(c, p.agentId, credential.serverId, previous);
      const current = this.agents.get(p.agentId);
      if (current) {
        this.o.logger.info('Replacing an agent connection that no longer answers', { agentId: p.agentId, ip: c.ip, previousIp: current.ip });
        this.agents.delete(p.agentId); // so that closing it does not mark the server offline
        this.end(current, CLOSE.replaced, 'replaced', 'Another connection authenticated as this agent');
      }
      this.admit(c, m, p.agentId, credential.serverId);
    });
  }

  private admit(c: Connection, m: Message, agentId: string, serverId: string) {
    c.agentId = agentId;
    c.serverId = serverId;
    c.lastHeard = Date.now();
    this.agents.set(agentId, c);
    this.send(c, createMessage('AUTHENTICATED', { serverId, heartbeatIntervalMs: this.o.heartbeatMs, heartbeatTimeoutMs: this.o.timeoutMs }, m.id, c.version!));
    this.o.inventory.setConnection(serverId, { state: 'ONLINE', seen: true });
    this.o.logger.info('Agent connected', { agentId, serverId, ip: c.ip });
    this.o.bus.publish('agent.connected', { agentId, serverId, ip: c.ip }, 'manager');
  }

  private refuseDuplicate(c: Connection, agentId: string, serverId: string, live: Connection) {
    this.o.audit.record({ action: 'agent.duplicate', target: agentId, result: 'failure', ip: c.ip, metadata: { serverId, liveIp: live.ip, reason: 'two live connections with one agent identity' } });
    this.o.logger.warn('Refused a second connection for an agent that is connected and answering: two installations share one identity (a cloned disk?)', { agentId, ip: c.ip, liveIp: live.ip });
    this.o.bus.publish('agent.duplicate', { agentId, serverId, ip: c.ip, liveIp: live.ip }, 'manager');
    this.end(c, CLOSE.duplicate, 'duplicate', 'Another connection for this agent is live');
  }

  /** Whether a connection answers a WebSocket ping within the probe time. */
  private answers(c: Connection): Promise<boolean> {
    const ws = c.ws;
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
      const timer = setTimeout(() => done(false), this.o.duplicateProbeMs);
      ws.on('pong', onPong);
      ws.on('close', onClose);
      try {
        ws.ping();
      } catch {
        done(false);
      }
    });
  }

  // ── Messages from an authenticated agent ───────────────────────────────────────

  private receive(c: Connection, m: Message) {
    c.lastHeard = Date.now();
    const serverId = c.serverId!;
    switch (m.type) {
      case 'HEARTBEAT':
        this.send(c, createMessage('HEARTBEAT', { seq: (m.payload as Payloads['HEARTBEAT']).seq }, m.id, c.version!));
        c.stale = false;
        this.o.inventory.setConnection(serverId, { state: this.liveState(c), seen: true });
        return;
      case 'SERVER_STATE': {
        const p = m.payload as Payloads['SERVER_STATE'];
        c.health = p.health;
        c.stale = false;
        this.o.inventory.setConnection(serverId, { state: this.liveState(c), agentVersion: p.agentVersion, seen: true });
        return;
      }
      case 'CAPABILITIES':
        this.o.inventory.setConnection(serverId, { capabilities: (m.payload as Payloads['CAPABILITIES']).capabilities, seen: true });
        return;
      default:
        // HELLO, AUTHENTICATION, AUTHENTICATED and ERROR have no meaning here.
        this.send(c, createMessage('ERROR', { code: 'unsupported', message: `${m.type} is not expected from an agent` }, m.id, c.version!));
    }
  }

  private liveState(c: Connection): ServerState {
    return c.health && c.health !== 'HEALTHY' ? 'DEGRADED' : 'ONLINE';
  }

  /** Marks silent agents STALE and drops those that stayed silent. */
  private sweep() {
    const now = Date.now();
    for (const c of [...this.agents.values()]) {
      const silent = now - c.lastHeard;
      if (silent > this.o.timeoutMs) {
        this.o.logger.warn('Agent stopped sending heartbeats; closing its connection', { agentId: c.agentId, serverId: c.serverId, silentMs: silent });
        this.end(c, CLOSE.timeout, 'timeout', 'No heartbeat');
      } else if (!c.stale && silent > this.o.heartbeatMs * 2.5) {
        c.stale = true;
        this.o.inventory.setConnection(c.serverId!, { state: 'STALE' });
      }
    }
  }

  // ── Endings ────────────────────────────────────────────────────────────────────

  private send(c: Connection, m: Message) {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(encode(m));
  }

  /** Tells the agent why, then closes. A peer that does not complete the close is cut off. */
  private end(c: Connection, closeCode: number, code: ErrorCode, message: string) {
    if (c.ws.readyState === c.ws.OPEN) {
      this.send(c, createMessage('ERROR', { code, message }, undefined, c.version ?? undefined));
      c.ws.close(closeCode, message.slice(0, 100));
      setTimeout(() => c.ws.terminate(), 2000).unref();
    } else if (c.ws.readyState !== c.ws.CLOSING) c.ws.terminate();
    // Do not wait for the close handshake of a peer we no longer trust or that went silent.
    this.onClose(c);
  }

  private onClose(c: Connection) {
    if (c.handshake) clearTimeout(c.handshake);
    c.handshake = null;
    this.pending.delete(c);
    if (!c.agentId || this.agents.get(c.agentId) !== c) return; // never authenticated, or already replaced
    this.agents.delete(c.agentId);
    this.o.inventory.setConnection(c.serverId!, { state: 'OFFLINE' });
    this.o.logger.info('Agent disconnected', { agentId: c.agentId, serverId: c.serverId });
    this.o.bus.publish('agent.disconnected', { agentId: c.agentId, serverId: c.serverId }, 'manager');
  }

  connections() {
    return { authenticated: this.agents.size, pending: this.pending.size };
  }

  close() {
    this.closed = true;
    clearInterval(this.sweeper);
    for (const c of [...this.pending, ...this.probing.values(), ...this.agents.values()]) {
      if (c.handshake) clearTimeout(c.handshake);
      if (c.ws.readyState === c.ws.OPEN) {
        this.send(c, createMessage('ERROR', { code: 'shutting-down', message: 'The Manager is stopping' }, undefined, c.version ?? undefined));
        c.ws.close(CLOSE.shuttingDown, 'Manager stopping');
      } else c.ws.terminate();
    }
    // Servers keep their last state in the database; the next start resets it (resetConnectionStates).
    this.pending.clear();
    this.probing.clear();
    this.agents.clear();
    this.wss.close();
  }
}
