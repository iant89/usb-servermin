import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from '@servermin/sdk';
import { CORE_VERSION, TokenBucket, verifyAgentSignature, type AuditLog, type EventBus } from '@servermin/core';
import { AGENT_ENDPOINT, CLOSE, MAX_FRAME_BYTES, PROTOCOL_VERSIONS, ProtocolError, authSigningInput, createMessage, decode, encode, type ErrorCode, type Message, type Payloads } from '@servermin/protocol';
import type { Inventory, ServerState } from './inventory';

/** Connections that have not authenticated yet. Each holds a socket and a timer, nothing else. */
const MAX_PENDING = 200;
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
  private upgrades = new TokenBucket(30, 2);
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
    if (!this.upgrades.take(ip)) return refuse(429, 'Too Many Requests');
    if (this.pending.size >= MAX_PENDING) return refuse(503, 'Service Unavailable');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, ip));
    return true;
  }

  private accept(ws: WebSocket, ip: string) {
    const c: Connection = { ws, ip, nonce: randomBytes(32).toString('base64'), version: null, health: null, lastHeard: Date.now(), stale: false, handshake: null, windowStart: Date.now(), messages: 0 };
    this.pending.add(c);
    c.handshake = setTimeout(() => this.end(c, CLOSE.timeout, 'timeout', 'Authentication timed out'), this.o.handshakeMs);
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
    if (isBinary) return this.end(c, CLOSE.malformed, 'malformed', 'Binary frames are not part of the protocol');
    let m: Message;
    try {
      m = decode(raw);
    } catch (e) {
      const code = e instanceof ProtocolError ? e.code : 'malformed';
      // Before authentication nothing is tolerated. Afterwards an unknown type is answered and
      // skipped (an agent newer than this Manager); a malformed frame ends the connection.
      if (code === 'unsupported' && c.agentId) return this.send(c, createMessage('ERROR', { code: 'unsupported', message: (e as Error).message }, undefined, c.version ?? undefined));
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
    const deny = (reason: string, agentId?: string) => {
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
    if (!credential) return deny('agent is not enrolled', p.agentId);
    if (!verifyAgentSignature(credential.publicKey, signed, p.signature)) return deny('signature does not match the enrolled key', p.agentId);

    if (c.handshake) clearTimeout(c.handshake);
    c.handshake = null;
    this.pending.delete(c);
    c.version = p.version;
    c.agentId = p.agentId;
    c.serverId = credential.serverId;
    c.lastHeard = Date.now();

    const previous = this.agents.get(p.agentId);
    if (previous) {
      // Usually our side of a connection the agent already lost. If the old one was heard from a
      // moment ago, two machines are probably running with one identity (a cloned disk).
      const alive = !previous.stale && Date.now() - previous.lastHeard < this.o.heartbeatMs * 1.5 && previous.ip !== c.ip;
      if (alive) {
        this.o.audit.record({ action: 'agent.duplicate', target: p.agentId, result: 'failure', ip: c.ip, metadata: { serverId: credential.serverId, previousIp: previous.ip, reason: 'two live connections with one agent identity' } });
        this.o.logger.warn('A second agent connected with an identity that is already connected; a cloned installation?', { agentId: p.agentId, ip: c.ip, previousIp: previous.ip });
      }
      this.agents.delete(p.agentId); // so that closing it does not mark the server offline
      this.end(previous, CLOSE.replaced, 'replaced', 'Another connection authenticated as this agent');
    }
    this.agents.set(p.agentId, c);
    this.send(c, createMessage('AUTHENTICATED', { serverId: credential.serverId, heartbeatIntervalMs: this.o.heartbeatMs, heartbeatTimeoutMs: this.o.timeoutMs }, m.id, c.version));
    this.o.inventory.setConnection(credential.serverId, { state: 'ONLINE', seen: true });
    this.o.logger.info('Agent connected', { agentId: p.agentId, serverId: credential.serverId, ip: c.ip });
    this.o.bus.publish('agent.connected', { agentId: p.agentId, serverId: credential.serverId, ip: c.ip }, 'manager');
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
    for (const c of [...this.pending, ...this.agents.values()]) {
      if (c.handshake) clearTimeout(c.handshake);
      if (c.ws.readyState === c.ws.OPEN) {
        this.send(c, createMessage('ERROR', { code: 'shutting-down', message: 'The Manager is stopping' }, undefined, c.version ?? undefined));
        c.ws.close(CLOSE.shuttingDown, 'Manager stopping');
      } else c.ws.terminate();
    }
    // Servers keep their last state in the database; the next start resets it (resetConnectionStates).
    this.pending.clear();
    this.agents.clear();
    this.wss.close();
  }
}
