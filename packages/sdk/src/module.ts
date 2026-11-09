import type { ModuleContext } from './context';

/**
 * The module contract (§10). Every lifecycle method is optional except `initialize`.
 * `initialize` registers routes, channels, handlers and migrations; `start` begins background
 * work; `stop` ends it; `destroy` releases anything left. Resources created through the
 * context are cleaned up by the core even if a module forgets to.
 */
export interface ServerModule {
  initialize(context: ModuleContext): void | Promise<void>;
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
  destroy?(): void | Promise<void>;
}

/** Identity helper that gives module authors type checking. */
export function defineModule(module: ServerModule | (() => ServerModule)): () => ServerModule {
  return typeof module === 'function' ? module : () => module;
}
