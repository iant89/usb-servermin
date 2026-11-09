/**
 * Minimal semantic-versioning helpers. Supports `x.y.z[-pre]` versions and ranges made of
 * `*`, exact versions, `^`, `~`, `>=`, `>`, `<=`, `<`, `=` comparators joined by spaces (AND)
 * and `||` (OR). This covers what module manifests need without a dependency.
 */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(input: string): SemVer | null {
  const m = VERSION_RE.exec(input.trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], prerelease: m[4] ? m[4].split('.') : [] };
}

export function isValidVersion(input: string): boolean {
  return parseVersion(input) !== null;
}

export function compareVersions(a: string | SemVer, b: string | SemVer): number {
  const x = typeof a === 'string' ? parseVersion(a) : a;
  const y = typeof b === 'string' ? parseVersion(b) : b;
  if (!x || !y) throw new Error(`Invalid version: ${!x ? String(a) : String(b)}`);
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  if (!x.prerelease.length && !y.prerelease.length) return 0;
  if (!x.prerelease.length) return 1;
  if (!y.prerelease.length) return -1;
  const len = Math.max(x.prerelease.length, y.prerelease.length);
  for (let i = 0; i < len; i++) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return +p < +q ? -1 : 1;
    if (pn) return -1;
    if (qn) return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

type Comparator = (v: SemVer) => boolean;

function partial(input: string): { major: number; minor?: number; patch?: number; pre: string[] } | null {
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/.exec(input);
  if (!m) return null;
  const num = (s?: string) => (s === undefined || /[xX*]/.test(s) ? undefined : +s);
  const major = num(m[1]);
  if (major === undefined) return { major: -1, pre: [] };
  return { major, minor: num(m[2]), patch: num(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

function v(major: number, minor = 0, patch = 0, pre: string[] = []): SemVer {
  return { major, minor, patch, prerelease: pre };
}

function comparator(token: string): Comparator | null {
  if (token === '*' || token === 'x' || token === '') return () => true;
  const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token);
  if (!m) return null;
  const op = m[1] ?? '';
  const p = partial(m[2]);
  if (!p) return null;
  if (p.major === -1) return () => true;
  const base = v(p.major, p.minor ?? 0, p.patch ?? 0, p.pre);
  const cmp = (x: SemVer) => compareVersions(x, base);
  switch (op) {
    case '>=':
      return (x) => cmp(x) >= 0;
    case '>':
      return (x) => cmp(x) > 0;
    case '<=':
      return (x) => cmp(x) <= 0;
    case '<':
      return (x) => cmp(x) < 0;
    case '^': {
      const upper =
        p.major > 0 || p.minor === undefined
          ? v(p.major + 1)
          : p.minor > 0 || p.patch === undefined
            ? v(0, p.minor + 1)
            : v(0, 0, (p.patch ?? 0) + 1);
      return (x) => cmp(x) >= 0 && compareVersions(x, upper) < 0;
    }
    case '~': {
      const upper = p.minor === undefined ? v(p.major + 1) : v(p.major, p.minor + 1);
      return (x) => cmp(x) >= 0 && compareVersions(x, upper) < 0;
    }
    default: {
      // Exact or partial version ("1.2" means >=1.2.0 <1.3.0).
      if (p.minor === undefined) return (x) => x.major === p.major;
      if (p.patch === undefined) return (x) => x.major === p.major && x.minor === p.minor;
      return (x) => cmp(x) === 0;
    }
  }
}

export function isValidRange(range: string): boolean {
  return parseRange(range) !== null;
}

function parseRange(range: string): Comparator[][] | null {
  const alternatives = range.split('||').map((part) => part.trim());
  const out: Comparator[][] = [];
  for (const alt of alternatives) {
    const tokens = alt.split(/\s+/).filter(Boolean);
    const set: Comparator[] = [];
    for (const token of tokens.length ? tokens : ['*']) {
      const c = comparator(token);
      if (!c) return null;
      set.push(c);
    }
    out.push(set);
  }
  return out;
}

export function satisfies(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  const sets = parseRange(range);
  if (!parsed || !sets) return false;
  return sets.some((set) => set.every((c) => c(parsed)));
}
