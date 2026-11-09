import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type DependencyList, type ReactNode } from 'react';
import { hasPermission } from '@servermin/sdk';
import { moduleApi, type ModuleApi } from './api';
import { socket, type ChannelHandle } from './socket';

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  permissions: string[];
}

export interface FrontendModuleInfo {
  id: string;
  name: string;
  version: string;
  state: string;
  enabled: boolean;
  revision: number;
  error?: string;
  blockedBy: string[];
  script: string | null;
  style: string | null;
}

export interface PlatformContextValue {
  user: SessionUser;
  serverName: string;
  coreVersion: string;
  simulated: boolean;
  modules: FrontendModuleInfo[];
  refreshModules(): Promise<void>;
  signOut(): Promise<void>;
}

export const PlatformContext = createContext<PlatformContextValue | null>(null);

export function usePlatform(): PlatformContextValue {
  const v = useContext(PlatformContext);
  if (!v) throw new Error('usePlatform must be used inside the Server Control shell');
  return v;
}

export function usePermission(permission?: string): boolean {
  const { user } = usePlatform();
  return !permission || hasPermission(user.permissions, permission);
}

/** Information about another module (state only — modules never import each other, §5.6). */
export function useModuleInfo(id: string): FrontendModuleInfo | undefined {
  return usePlatform().modules.find((m) => m.id === id);
}

const ModuleScope = createContext<string | null>(null);

/** The shell wraps each module's UI in this, so hooks know which module they belong to. */
export function ModuleScopeProvider({ moduleId, children }: { moduleId: string; children: ReactNode }) {
  return <ModuleScope.Provider value={moduleId}>{children}</ModuleScope.Provider>;
}

export function useModuleId(): string {
  const id = useContext(ModuleScope);
  if (!id) throw new Error('useModuleId must be used inside a module view');
  return id;
}

/** API client for the current module's routes. */
export function useModuleApi(): ModuleApi {
  const id = useModuleId();
  return useMemo(() => moduleApi(id), [id]);
}

export interface QueryState<T> {
  data: T | undefined;
  error: Error | null;
  loading: boolean;
  refresh(): Promise<void>;
  setData(update: T | ((prev: T | undefined) => T)): void;
}

/**
 * Loads data and tracks loading/error state. Re-runs when `deps` change; with `intervalMs`
 * it refreshes in the background (errors keep the last good data).
 */
export function useQuery<T>(fn: (signal: AbortSignal) => Promise<T>, deps: DependencyList, opts: { intervalMs?: number; enabled?: boolean } = {}): QueryState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(opts.enabled !== false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const ctrl = useRef<AbortController | null>(null);

  const run = useCallback(async (background = false) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    if (!background) setLoading(true);
    try {
      const result = await fnRef.current(c.signal);
      if (!c.signal.aborted) {
        setData(result);
        setError(null);
      }
    } catch (e) {
      if (!c.signal.aborted && (e as Error).name !== 'AbortError') setError(e as Error);
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (opts.enabled === false) return;
    void run();
    if (!opts.intervalMs) return () => ctrl.current?.abort();
    const t = setInterval(() => void run(true), opts.intervalMs);
    return () => {
      clearInterval(t);
      ctrl.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, opts.intervalMs, opts.enabled]);

  return { data, error, loading, refresh: () => run(true), setData: setData as QueryState<T>['setData'] };
}

export interface ChannelState {
  status: 'connecting' | 'open' | 'closed' | 'error';
  error?: string;
  reason?: string;
  send(data: unknown): void;
}

/**
 * Subscribe to a real-time channel (`docker.logs`, `system.metrics`, …). The subscription is
 * removed on unmount; if the server closes it because the module reloaded, it resubscribes.
 */
export function useChannel<T = unknown>(channel: string | null, params: Record<string, unknown>, onData: (data: T) => void): ChannelState {
  const [state, setState] = useState<Omit<ChannelState, 'send'>>({ status: 'connecting' });
  const handle = useRef<ChannelHandle | null>(null);
  const cb = useRef(onData);
  cb.current = onData;
  const key = JSON.stringify(params);
  useEffect(() => {
    if (!channel) return;
    setState({ status: 'connecting' });
    let retry: number | undefined;
    const h = socket.subscribe(channel, JSON.parse(key), {
      onData: (d) => {
        setState((s) => (s.status === 'open' ? s : { status: 'open' }));
        cb.current(d as T);
      },
      onClosed: (reason) => {
        setState({ status: 'closed', reason });
        if (reason === 'module-unloaded') retry = window.setTimeout(() => h.resubscribe(), 1500);
      },
      onError: (error, reason) => setState({ status: 'error', error, reason }),
    });
    handle.current = h;
    const off = socket.onState((s) => s === 'open' && setState({ status: 'open' }));
    const t = window.setTimeout(() => setState((s) => (s.status === 'connecting' && socket.state === 'open' ? { status: 'open' } : s)), 400);
    return () => {
      clearTimeout(t);
      clearTimeout(retry);
      off();
      h.close();
      handle.current = null;
    };
  }, [channel, key]);
  return { ...state, send: (data) => handle.current?.send(data) };
}

/** Subscribe to platform module events (`module.status` channel), e.g. to refresh on reload. */
export function useModuleEvents(onEvent: (event: { type: string; payload: any }) => void) {
  useChannel<{ type: string; payload: any }>('module.status', {}, onEvent);
}
