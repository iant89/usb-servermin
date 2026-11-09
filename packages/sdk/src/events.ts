/** A platform event (§17). `type` is dotted, e.g. `docker.container.started`. */
export interface PlatformEvent<T = unknown> {
  type: string;
  /** Module that published it, or `core`. */
  source: string;
  timestamp: string;
  payload: T;
}

/** Events emitted by the core itself. */
export interface CoreEventPayloads {
  'module.installed': { moduleId: string; version: string };
  'module.removed': { moduleId: string };
  'module.loaded': { moduleId: string; version: string };
  'module.unloaded': { moduleId: string };
  'module.state.changed': { moduleId: string; state: string; previous: string; error?: string };
  'module.error': { moduleId: string; error: string };
  'module.config.changed': { moduleId: string; keys: string[] };
  'config.changed': { keys: string[] };
  'auth.login': { username: string };
  'notification.created': { id: number; title: string; tone: string };
}

/**
 * Matches an event type against a subscription pattern. `*` matches one segment,
 * a trailing `**` matches any remaining segments; `*` alone matches everything.
 */
export function matchesEventPattern(pattern: string, type: string): boolean {
  if (pattern === '*' || pattern === '**' || pattern === type) return true;
  const p = pattern.split('.');
  const t = type.split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '**') return true;
    if (i >= t.length) return false;
    if (p[i] !== '*' && p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}
