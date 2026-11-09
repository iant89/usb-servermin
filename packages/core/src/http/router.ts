import { compilePath, matchPath, type CompiledPath } from '@servermin/sdk';
import type { RequestContext } from './util';

export type CoreHandler = (ctx: RequestContext) => unknown | Promise<unknown>;

export interface CoreRoute {
  method: string;
  path: CompiledPath;
  /** Permission, `authenticated` or `public`. */
  permission: string;
  handler: CoreHandler;
  /** Accept a raw body (uploads) instead of JSON. */
  rawBody?: boolean;
}

/** Router for the core's own endpoints. Module routes are dispatched separately. */
export class Router {
  readonly routes: CoreRoute[] = [];

  add(method: string, path: string, permission: string, handler: CoreHandler, opts: { rawBody?: boolean } = {}) {
    this.routes.push({ method, path: compilePath(path), permission, handler, ...opts });
    this.routes.sort((a, b) => b.path.score - a.path.score);
  }

  get(p: string, perm: string, h: CoreHandler) {
    this.add('GET', p, perm, h);
  }
  post(p: string, perm: string, h: CoreHandler, opts?: { rawBody?: boolean }) {
    this.add('POST', p, perm, h, opts);
  }
  put(p: string, perm: string, h: CoreHandler) {
    this.add('PUT', p, perm, h);
  }
  patch(p: string, perm: string, h: CoreHandler) {
    this.add('PATCH', p, perm, h);
  }
  delete(p: string, perm: string, h: CoreHandler) {
    this.add('DELETE', p, perm, h);
  }

  match(method: string, path: string): { route: CoreRoute; params: Record<string, string> } | { methodNotAllowed: true } | null {
    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchPath(route.path, path);
      if (!params) continue;
      pathMatched = true;
      if (route.method === method || (method === 'HEAD' && route.method === 'GET')) return { route, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}
