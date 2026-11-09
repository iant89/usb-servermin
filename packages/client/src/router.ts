/** Minimal history-based router shared by the shell and module UIs. */
import { useEffect, useState } from 'react';

type Listener = () => void;
const listeners = new Set<Listener>();

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (to === location.pathname + location.search) return;
  if (opts.replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  for (const l of listeners) l();
  document.getElementById('main-content')?.scrollTo?.({ top: 0 });
}

if (typeof window !== 'undefined') window.addEventListener('popstate', () => listeners.forEach((l) => l()));

export function useLocation() {
  const [loc, setLoc] = useState(() => ({ pathname: location.pathname, search: location.search }));
  useEffect(() => {
    const l = () => setLoc({ pathname: location.pathname, search: location.search });
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return loc;
}

/** Path of a module page, e.g. modulePath('docker', '/containers/abc'). */
export function modulePath(moduleId: string, path = '/') {
  return `/m/${moduleId}${path === '/' ? '' : path.startsWith('/') ? path : '/' + path}`;
}

/** Click handler for anchors that keeps navigation client-side. */
export function linkHandler(to: string) {
  return (e: { preventDefault(): void; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; button?: number }) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || (e.button !== undefined && e.button !== 0)) return;
    e.preventDefault();
    navigate(to);
  };
}
