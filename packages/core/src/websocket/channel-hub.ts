import type { RequestUser } from '@servermin/sdk';

export interface ChannelClient {
  /** Deliver a message to the browser connection. */
  send(message: unknown): void;
  user: RequestUser;
}

export interface HubSubscription {
  id: string;
  /** Full channel name, e.g. `docker.logs` or `notifications`. */
  channel: string;
  /** Owning module id, or `core`. */
  owner: string;
  client: ChannelClient;
  clientSubId: string;
  onClose?: () => void;
}

/**
 * Transport-independent registry of real-time subscriptions (§28). The WebSocket gateway adds
 * subscriptions; modules and core services send to them by id or by channel. Unloading a module
 * closes all of its subscriptions with a reason the browser can show.
 */
export class ChannelHub {
  private subs = new Map<string, HubSubscription>();

  add(sub: HubSubscription) {
    this.subs.set(sub.id, sub);
  }

  get(id: string) {
    return this.subs.get(id);
  }

  remove(id: string) {
    const s = this.subs.get(id);
    this.subs.delete(id);
    return s;
  }

  send(id: string, data: unknown) {
    const s = this.subs.get(id);
    if (s) s.client.send({ type: 'data', id: s.clientSubId, data });
  }

  broadcast(channel: string, data: unknown, filter?: (s: HubSubscription) => boolean) {
    for (const s of this.subs.values()) if (s.channel === channel && (!filter || filter(s))) s.client.send({ type: 'data', id: s.clientSubId, data });
  }

  /** Server-initiated close of one subscription. */
  close(id: string, reason: string) {
    const s = this.remove(id);
    if (!s) return;
    s.client.send({ type: 'closed', id: s.clientSubId, reason });
    s.onClose?.();
  }

  closeOwner(owner: string, reason: string) {
    let n = 0;
    for (const s of [...this.subs.values()]) if (s.owner === owner) (this.close(s.id, reason), n++);
    return n;
  }

  closeClient(client: ChannelClient) {
    for (const s of [...this.subs.values()]) if (s.client === client) (this.subs.delete(s.id), s.onClose?.());
  }

  count(channel?: string) {
    return [...this.subs.values()].filter((s) => !channel || s.channel === channel).length;
  }
}
