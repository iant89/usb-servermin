/**
 * Single multiplexed WebSocket connection to the gateway (§28) with automatic reconnection.
 * Subscriptions survive reconnects: they are re-sent when the socket opens again.
 */
type Listener = { onData: (data: any) => void; onClosed?: (reason: string) => void; onError?: (message: string, reason?: string) => void };

interface Sub {
  id: string;
  channel: string;
  params: Record<string, unknown>;
  listener: Listener;
  active: boolean;
}

export type ConnectionState = 'connecting' | 'open' | 'closed';

class SocketClient {
  private ws: WebSocket | null = null;
  private subs = new Map<string, Sub>();
  private seq = 0;
  private retry = 0;
  private timer: number | null = null;
  private stateListeners = new Set<(s: ConnectionState) => void>();
  state: ConnectionState = 'closed';
  private enabled = false;

  private setState(s: ConnectionState) {
    this.state = s;
    for (const l of this.stateListeners) l(s);
  }

  onState(l: (s: ConnectionState) => void) {
    this.stateListeners.add(l);
    return () => this.stateListeners.delete(l);
  }

  start() {
    this.enabled = true;
    if (!this.ws) this.connect();
  }

  stop() {
    this.enabled = false;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    this.setState('closed');
  }

  private connect() {
    if (!this.enabled) return;
    this.setState('connecting');
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setState('open');
      for (const s of this.subs.values()) this.sendSubscribe(s);
    };
    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const sub = msg.id ? this.subs.get(msg.id) : undefined;
      if (msg.type === 'data') sub?.listener.onData(msg.data);
      else if (msg.type === 'subscribed' && sub) sub.active = true;
      else if (msg.type === 'closed' && sub) {
        sub.active = false;
        sub.listener.onClosed?.(msg.reason);
      } else if (msg.type === 'error' && sub) {
        sub.active = false;
        sub.listener.onError?.(msg.message, msg.reason);
      }
    };
    ws.onclose = (ev) => {
      this.ws = null;
      for (const s of this.subs.values()) s.active = false;
      this.setState('closed');
      if (ev.code === 4401) return; // session ended; the app shows the sign-in page
      if (!this.enabled) return;
      const delay = Math.min(30_000, 500 * 2 ** this.retry++);
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
  }

  private sendSubscribe(s: Sub) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'subscribe', id: s.id, channel: s.channel, params: s.params }));
  }

  subscribe(channel: string, params: Record<string, unknown>, listener: Listener) {
    const id = `c${++this.seq}`;
    const sub: Sub = { id, channel, params, listener, active: false };
    this.subs.set(id, sub);
    this.start();
    this.sendSubscribe(sub);
    return {
      id,
      send: (data: unknown) => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'message', id, data }));
      },
      /** Re-subscribe after a server-side close (e.g. module reloaded). */
      resubscribe: () => this.sendSubscribe(sub),
      close: () => {
        this.subs.delete(id);
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'unsubscribe', id }));
      },
    };
  }
}

export const socket = new SocketClient();
export type ChannelHandle = ReturnType<SocketClient['subscribe']>;
