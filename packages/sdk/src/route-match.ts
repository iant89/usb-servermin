/** Path patterns used by module routes: `/containers/:id`, `/files/*` (rest parameter `*`). */
export interface CompiledPath {
  pattern: string;
  regex: RegExp;
  keys: string[];
  /** Static segments rank before parameters when routes overlap. */
  score: number;
}

export function compilePath(pattern: string): CompiledPath {
  if (!pattern.startsWith('/')) throw new Error(`Route path must start with "/": ${pattern}`);
  const keys: string[] = [];
  let score = 0;
  const parts = pattern
    .split('/')
    .filter(Boolean)
    .map((seg, i, all) => {
      if (seg === '*' && i === all.length - 1) {
        keys.push('*');
        return '(?:/(.*))?';
      }
      if (seg.startsWith(':')) {
        const key = seg.slice(1);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid route parameter in ${pattern}`);
        keys.push(key);
        score += 1;
        return '/([^/]+)';
      }
      score += 3;
      return '/' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    });
  return { pattern, regex: new RegExp(`^${parts.join('') || '/'}/?$`), keys, score };
}

export function matchPath(compiled: CompiledPath, path: string): Record<string, string> | null {
  const m = compiled.regex.exec(path || '/');
  if (!m) return null;
  const params: Record<string, string> = {};
  compiled.keys.forEach((k, i) => {
    const raw = m[i + 1];
    if (raw !== undefined) {
      try {
        params[k] = decodeURIComponent(raw);
      } catch {
        params[k] = raw;
      }
    }
  });
  return params;
}
