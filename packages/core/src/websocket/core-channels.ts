import { matchesEventPattern } from '@servermin/sdk';
import type { Platform } from '../platform';
import type { CoreChannel } from './gateway';

/** The real-time channels of the agent's local interface. */
export function coreChannels(p: Platform): Record<string, CoreChannel> {
  const { bus, notifications, logs } = p;
  const channels: Record<string, CoreChannel> = {};
  const set = (name: string, channel: CoreChannel) => void (channels[name] = channel);
  // Module lifecycle changes, so the shell can load, reload or remove module UI (§57).
  // "Saving…" indicator: pushed when writes start or stop lagging behind on the storage thread.
  set('platform.storage', {
    permission: 'authenticated',
    subscribe: (client, subId) => {
      client.send({ type: 'data', id: subId, data: p.storage.activity.status() });
      return p.storage.activity.subscribe((s) => client.send({ type: 'data', id: subId, data: s }));
    },
  });
  set('platform.updates', {
    permission: 'platform.update',
    subscribe: (client, subId) => {
      client.send({ type: 'data', id: subId, data: p.updates.state() });
      return p.updates.subscribe((s) => client.send({ type: 'data', id: subId, data: s }));
    },
  });
  set('module.status', {
    permission: 'authenticated',
    subscribe: (client, subId) =>
      bus.subscribe('module.**', (e) => client.send({ type: 'data', id: subId, data: e }), 'core'),
  });
  set('notifications', {
    permission: 'authenticated',
    subscribe: (client, subId) =>
      notifications.subscribe((n) => notifications.visibleTo(client.user.permissions, n) && client.send({ type: 'data', id: subId, data: n })),
  });
  set('events', {
    permission: 'platform.logs.read',
    subscribe: (client, subId, params) => {
      const pattern = typeof params.pattern === 'string' ? params.pattern : '*';
      return bus.subscribe('*', (e) => matchesEventPattern(pattern, e.type) && client.send({ type: 'data', id: subId, data: e }), 'core');
    },
  });
  set('platform.logs', {
    permission: 'platform.logs.read',
    subscribe: (client, subId, params) =>
      logs.subscribe((entry) => {
        if (params.module && entry.module !== params.module) return;
        client.send({ type: 'data', id: subId, data: entry });
      }),
  });
  return channels;
}
