import { matchesEventPattern, type PlatformEvent } from '@servermin/sdk';

type Handler = (event: PlatformEvent) => void;

interface Subscription {
  pattern: string;
  handler: Handler;
  owner: string;
}

/**
 * Typed, in-process event bus (§17, §56). Every subscription has an owner (`core` or a module
 * id) so that a module's handlers can be removed in one call when it unloads. A failing
 * handler is isolated: the error is reported and delivery continues.
 */
export class EventBus {
  private subs = new Set<Subscription>();
  private recent: PlatformEvent[] = [];

  constructor(
    private readonly onHandlerError: (error: unknown, event: PlatformEvent, owner: string) => void = () => {},
    private readonly historySize = 200,
  ) {}

  publish<T>(type: string, payload: T, source = 'core'): PlatformEvent<T> {
    const event: PlatformEvent<T> = { type, source, timestamp: new Date().toISOString(), payload };
    this.recent.push(event);
    if (this.recent.length > this.historySize) this.recent.shift();
    for (const sub of [...this.subs]) {
      if (!this.subs.has(sub) || !matchesEventPattern(sub.pattern, type)) continue;
      try {
        sub.handler(event);
      } catch (error) {
        this.onHandlerError(error, event, sub.owner);
      }
    }
    return event;
  }

  subscribe(pattern: string, handler: Handler, owner = 'core'): () => void {
    const sub = { pattern, handler, owner };
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }

  /** Remove every subscription owned by a module (unload cleanup). Returns the count removed. */
  removeOwner(owner: string): number {
    let n = 0;
    for (const sub of this.subs) if (sub.owner === owner) this.subs.delete(sub) && n++;
    return n;
  }

  countOwner(owner: string): number {
    return [...this.subs].filter((s) => s.owner === owner).length;
  }

  history(pattern = '*', limit = 100): PlatformEvent[] {
    return this.recent.filter((e) => matchesEventPattern(pattern, e.type)).slice(-limit);
  }
}
