import { hasPermission } from '@servermin/sdk';
import type { Database } from '../database/database';
import type { EventBus } from '../events/event-bus';

export interface Notification {
  id: number;
  timestamp: string;
  title: string;
  message?: string | null;
  tone: 'information' | 'success' | 'warning' | 'error';
  module?: string | null;
  permission?: string | null;
}

/** Persistent user notifications, pushed live over the `notifications` channel. */
export class NotificationService {
  private listeners = new Set<(n: Notification) => void>();

  constructor(
    private readonly db: Database,
    private readonly events: EventBus,
  ) {}

  notify(n: Omit<Notification, 'id' | 'timestamp'>): Notification {
    const timestamp = new Date().toISOString();
    const r = this.db.run('INSERT INTO notifications (timestamp, title, message, tone, module, permission) VALUES (?, ?, ?, ?, ?, ?)', [
      timestamp,
      n.title.slice(0, 200),
      n.message?.slice(0, 2000) ?? null,
      n.tone,
      n.module ?? null,
      n.permission ?? null,
    ]);
    const full = { ...n, id: r.lastInsertRowid, timestamp };
    this.db.run('DELETE FROM notifications WHERE id <= ?', [full.id - 500]);
    this.events.publish('notification.created', { id: full.id, title: full.title, tone: full.tone });
    for (const l of this.listeners) l(full);
    return full;
  }

  visibleTo(permissions: string[], n: Notification) {
    return !n.permission || hasPermission(permissions, n.permission);
  }

  list(userId: number, permissions: string[], limit = 50) {
    const cursor = this.db.get<{ c: number }>('SELECT notification_cursor AS c FROM users WHERE id = ?', [userId])?.c ?? 0;
    const items = this.db
      .all<Notification>('SELECT * FROM notifications ORDER BY id DESC LIMIT ?', [limit * 3])
      .filter((n) => this.visibleTo(permissions, n))
      .slice(0, limit);
    return { items: items.map((n) => ({ ...n, unread: n.id > cursor })), unread: items.filter((n) => n.id > cursor).length };
  }

  markAllRead(userId: number) {
    const max = this.db.get<{ m: number | null }>('SELECT MAX(id) AS m FROM notifications')?.m ?? 0;
    this.db.run('UPDATE users SET notification_cursor = ? WHERE id = ?', [max, userId]);
  }

  subscribe(l: (n: Notification) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
