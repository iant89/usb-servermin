import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { hasPermission, matchesEventPattern, type RequestUser } from '@servermin/sdk';
import type { Platform } from '../platform';
import type { HttpServer } from '../http/server';
import type { ChannelClient } from './channel-hub';

const MAX_SUBSCRIPTIONS = 64;
const MAX_MESSAGES_PER_10S = 2000;

interface CoreChannel {
  permission: string;
  subscribe(client: ChannelClient, subId: string, params: Record<string, unknown>): () => void;
}

/**
 * WebSocket gateway (§28). One authenticated connection per browser tab carries many
 * subscriptions. The gateway owns authentication, authorisation, subscription bookkeeping and
 * cleanup; modules only see subscribe/message/unsubscribe calls for their own channels.
 */
export class WebSocketGateway {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private connections = new Set<{ ws: WebSocket; sessionHash?: string; client: ChannelClient }>();
  private coreChannels = new Map<string, CoreChannel>();
  private revalidate: NodeJS.Timeout;
  private log;

  constructor(
    private readonly p: Platform,
    private readonly http: HttpServer,
  ) {
    this.log = p.logs.logger('websocket');
    http.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    p.auth.onSessionRevoked((hash) => {
      for (const c of this.connections) if (c.sessionHash === hash) c.ws.close(4401, 'Session ended');
    });
    this.revalidate = setInterval(() => {
      for (const c of this.connections) if (c.sessionHash && !p.auth.isSessionValid(c.sessionHash)) c.ws.close(4401, 'Session expired');
    }, 60_000);
    this.revalidate.unref();
    this.registerCoreChannels();
  }

  private registerCoreChannels() {
    const { bus, notifications, logs } = this.p;
    // Module lifecycle changes, so the shell can load, reload or remove module UI (§57).
    // "Saving…" indicator: pushed when writes start or stop lagging behind on the storage thread.
    this.coreChannels.set('platform.storage', {
      permission: 'authenticated',
      subscribe: (client, subId) => {
        client.send({ type: 'data', id: subId, data: this.p.storage.activity.status() });
        return this.p.storage.activity.subscribe((s) => client.send({ type: 'data', id: subId, data: s }));
      },
    });
    this.coreChannels.set('platform.updates', {
      permission: 'platform.update',
      subscribe: (client, subId) => {
        client.send({ type: 'data', id: subId, data: this.p.updates.state() });
        return this.p.updates.subscribe((s) => client.send({ type: 'data', id: subId, data: s }));
      },
    });
    this.coreChannels.set('module.status', {
      permission: 'authenticated',
      subscribe: (client, subId) =>
        bus.subscribe('module.**', (e) => client.send({ type: 'data', id: subId, data: e }), 'core'),
    });
    this.coreChannels.set('notifications', {
      permission: 'authenticated',
      subscribe: (client, subId) =>
        notifications.subscribe((n) => notifications.visibleTo(client.user.permissions, n) && client.send({ type: 'data', id: subId, data: n })),
    });
    this.coreChannels.set('events', {
      permission: 'platform.logs.read',
      subscribe: (client, subId, params) => {
        const pattern = typeof params.pattern === 'string' ? params.pattern : '*';
        return bus.subscribe('*', (e) => matchesEventPattern(pattern, e.type) && client.send({ type: 'data', id: subId, data: e }), 'core');
      },
    });
    this.coreChannels.set('platform.logs', {
      permission: 'platform.logs.read',
      subscribe: (client, subId, params) =>
        logs.subscribe((entry) => {
          if (params.module && entry.module !== params.module) return;
          client.send({ type: 'data', id: subId, data: entry });
        }),
    });
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? '/', 'http://local');
    const reject = (code: number, msg: string) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== '/api/v1/ws') return reject(404, 'Not Found');
    const ctx: any = {};
    try {
      this.http.authenticate(req, ctx);
    } catch {
      return reject(401, 'Unauthorized');
    }
    if (!ctx.user) return reject(401, 'Unauthorized');
    if (ctx.authKind === 'session' && !this.http.sameOrigin(req)) return reject(403, 'Forbidden');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws, this.p.auth.toRequestUser(ctx.user), ctx.sessionToken ? this.sessionHash(ctx.sessionToken) : undefined));
  }

  private sessionHash(token: string) {
    return this.p.auth.authenticateSession(token)?.sessionHash;
  }

  private connect(ws: WebSocket, user: RequestUser, sessionHash?: string) {
    const client: ChannelClient = {
      user,
      send: (message) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
      },
    };
    const conn = { ws, sessionHash, client };
    this.connections.add(conn);
    /** client subscription id → hub subscription id */
    const subs = new Map<string, { hubId: string; cleanup?: () => void; moduleId?: string }>();
    let window = Date.now();
    let count = 0;
    let alive = true;
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30_000);
    ws.on('pong', () => (alive = true));

    ws.on('message', async (raw) => {
      if (Date.now() - window > 10_000) (window = Date.now()), (count = 0);
      if (++count > MAX_MESSAGES_PER_10S) return ws.close(4429, 'Too many messages');
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return client.send({ type: 'error', message: 'Malformed message' });
      }
      const id = typeof msg?.id === 'string' ? msg.id.slice(0, 64) : undefined;
      try {
        switch (msg?.type) {
          case 'ping':
            return client.send({ type: 'pong' });
          case 'subscribe':
            if (!id || typeof msg.channel !== 'string') throw new Error('subscribe needs id and channel');
            if (subs.has(id)) throw new Error('Subscription id already in use');
            if (subs.size >= MAX_SUBSCRIPTIONS) throw new Error('Too many subscriptions');
            await this.subscribe(client, subs, id, msg.channel, msg.params && typeof msg.params === 'object' ? msg.params : {});
            return client.send({ type: 'subscribed', id });
          case 'unsubscribe': {
            const s = id && subs.get(id);
            if (!s) return;
            subs.delete(id!);
            this.release(s);
            return;
          }
          case 'message': {
            const s = id && subs.get(id);
            if (!s?.moduleId) throw new Error('Unknown subscription');
            const m = this.p.modules.get(s.moduleId);
            await m?.instance?.call('channel.message', { id: s.hubId, data: msg.data }, 10_000);
            return;
          }
          default:
            throw new Error('Unknown message type');
        }
      } catch (e) {
        client.send({ type: 'error', id, message: (e as Error).message, reason: (e as any).reason });
      }
    });

    ws.on('close', () => {
      clearInterval(ping);
      this.connections.delete(conn);
      for (const s of subs.values()) this.release(s);
      subs.clear();
      this.p.hub.closeClient(client);
    });
  }

  private release(s: { hubId: string; cleanup?: () => void; moduleId?: string }) {
    s.cleanup?.();
    const hub = this.p.hub.remove(s.hubId);
    if (hub && s.moduleId) {
      const m = this.p.modules.get(s.moduleId);
      void m?.instance?.call('channel.unsubscribe', { id: s.hubId }, 5000).catch(() => undefined);
    }
  }

  private async subscribe(client: ChannelClient, subs: Map<string, any>, id: string, channel: string, params: Record<string, unknown>) {
    const core = this.coreChannels.get(channel);
    if (core) {
      if (core.permission !== 'authenticated' && !hasPermission(client.user.permissions, core.permission)) throw Object.assign(new Error(`Permission "${core.permission}" required`), { reason: 'forbidden' });
      const cleanup = core.subscribe(client, id, params);
      const hubId = randomUUID();
      this.p.hub.add({ id: hubId, channel, owner: 'core', client, clientSubId: id });
      subs.set(id, { hubId, cleanup });
      return;
    }
    const dot = channel.indexOf('.');
    if (dot < 1) throw Object.assign(new Error('Unknown channel'), { reason: 'unknown-channel' });
    const moduleId = channel.slice(0, dot);
    const local = channel.slice(dot + 1);
    const check = this.p.modules.canSubscribe(moduleId, local, client.user.permissions);
    if (!check.ok) throw Object.assign(new Error(check.reason === 'forbidden' ? 'Permission denied' : check.reason === 'unknown-channel' ? 'Unknown channel' : `Module ${moduleId} is unavailable`), { reason: check.reason });
    const hubId = randomUUID();
    this.p.hub.add({ id: hubId, channel, owner: moduleId, client, clientSubId: id, onClose: () => subs.delete(id) });
    subs.set(id, { hubId, moduleId });
    try {
      await check.instance.call('channel.subscribe', { id: hubId, channel: local, params, user: client.user }, 15_000);
    } catch (e) {
      this.p.hub.remove(hubId);
      subs.delete(id);
      throw e;
    }
  }

  connectionCount() {
    return this.connections.size;
  }

  close() {
    clearInterval(this.revalidate);
    for (const c of this.connections) c.ws.close(1001, 'Server shutting down');
    this.wss.close();
  }
}
