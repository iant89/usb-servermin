import { compilePath, matchPath } from '@servermin/sdk';
import type { FrontendRoute } from '@servermin/sdk';

const cache = new Map<string, ReturnType<typeof compilePath>>();

/** Picks the most specific module route for a path below `/m/<id>`. */
export function matchRoute(routes: FrontendRoute[], path: string) {
  let best: { route: FrontendRoute; params: Record<string, string>; score: number } | null = null;
  for (const route of routes) {
    let compiled = cache.get(route.path);
    if (!compiled) cache.set(route.path, (compiled = compilePath(route.path)));
    const params = matchPath(compiled, path);
    if (params && (!best || compiled.score > best.score)) best = { route, params, score: compiled.score };
  }
  return best;
}
