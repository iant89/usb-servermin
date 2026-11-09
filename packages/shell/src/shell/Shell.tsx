import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  AppShell,
  ApplicationHeader,
  Button,
  CommandPalette,
  NavigationGroup,
  NavigationItem,
  SideNavigation,
  Stack,
  StatusIndicator,
  Text,
  useToast,
  type MenuEntry,
  type PaletteCommand,
  type ThemePreference,
} from '@enterprise-ui/react';
import { hasPermission } from '@servermin/sdk';
import {
  ErrorMessage,
  ModuleScopeProvider,
  PlatformContext,
  api,
  formatRelative,
  getFrontends,
  navigate,
  socket,
  subscribeFrontends,
  useChannel,
  useLocation,
  type FrontendModuleInfo,
  type PlatformContextValue,
} from '@servermin/client';
import type { Session } from '../App';
import { Dashboard } from '../pages/Dashboard';
import { ModuleManager } from '../pages/ModuleManager';
import { ModuleDetail } from '../pages/ModuleDetail';
import { SettingsPage } from '../pages/Settings';
import { NotFound } from '../pages/NotFound';
import { ErrorBoundary } from './ErrorBoundary';
import { ModuleHost } from './ModuleHost';
import { loadFailures, onLoadFailure, syncModuleFrontends } from './module-loader';

interface NotificationItem {
  id: number;
  timestamp: string;
  title: string;
  message?: string;
  tone: 'information' | 'success' | 'warning' | 'error';
  module?: string;
  unread?: boolean;
}

function useConnectionState() {
  return useSyncExternalStore(
    (l) => socket.onState(l),
    () => socket.state,
  );
}

export function Shell({ session, onSessionChange, theme, onThemeChange }: { session: Required<Session>; onSessionChange: () => void; theme: ThemePreference; onThemeChange: (t: ThemePreference) => void }) {
  const toast = useToast();
  const [modules, setModules] = useState<FrontendModuleInfo[]>([]);
  const [health, setHealth] = useState<string>('HEALTHY');
  const [notifications, setNotifications] = useState<{ items: NotificationItem[]; unread: number }>({ items: [], unread: 0 });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [, bumpFailures] = useState(0);
  const frontends = useSyncExternalStore(subscribeFrontends, getFrontends);
  const connection = useConnectionState();
  const loc = useLocation();
  const user = session.user;
  const can = useCallback((p?: string) => !p || hasPermission(user.permissions, p), [user.permissions]);

  const refreshModules = useCallback(async () => {
    try {
      const list = await api.get<FrontendModuleInfo[]>('/api/v1/platform/frontend');
      setModules(list);
      syncModuleFrontends(list);
    } catch {
      /* connection problems are shown by the status indicator */
    }
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      setHealth((await api.get<{ status: string }>('/api/v1/health')).status);
    } catch {
      setHealth('OFFLINE');
    }
  }, []);

  const refreshNotifications = useCallback(async () => {
    try {
      setNotifications(await api.get('/api/v1/notifications'));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refreshModules();
    void refreshHealth();
    void refreshNotifications();
    const t = setInterval(() => void refreshHealth(), 30_000);
    const off = onLoadFailure(() => bumpFailures((n) => n + 1));
    return () => {
      clearInterval(t);
      off();
    };
  }, [refreshModules, refreshHealth, refreshNotifications]);

  // Module lifecycle events drive the dynamic UI: navigation and routes appear and disappear (§57).
  useChannel<{ type: string; payload: any }>('module.status', {}, (event) => {
    if (['module.state.changed', 'module.installed', 'module.removed', 'module.loaded', 'module.unloaded'].includes(event.type)) {
      void refreshModules();
      void refreshHealth();
    }
  });
  useChannel<NotificationItem>('notifications', {}, (n) => {
    setNotifications((prev) => ({ items: [{ ...n, unread: true }, ...prev.items].slice(0, 50), unread: prev.unread + 1 }));
    toast.show({ title: n.title, description: n.message, tone: n.tone === 'information' ? 'neutral' : n.tone });
  });
  useEffect(() => {
    if (connection === 'open') {
      void refreshModules();
      void refreshHealth();
    }
  }, [connection, refreshModules, refreshHealth]);

  const platform: PlatformContextValue = useMemo(
    () => ({
      user,
      serverName: session.serverName,
      coreVersion: session.coreVersion,
      simulated: session.simulated,
      modules,
      refreshModules,
      signOut: async () => {
        await api.post('/api/v1/auth/logout').catch(() => undefined);
        onSessionChange();
      },
    }),
    [user, session.serverName, session.coreVersion, session.simulated, modules, refreshModules, onSessionChange],
  );

  // ── Navigation, generated from installed modules (§29) ─────────────────────────
  const navItems = useMemo(
    () =>
      frontends
        .flatMap((f) => (f.contribution.navigation ?? []).map((n) => ({ ...n, moduleId: f.moduleId })))
        .filter((n) => can(n.permission))
        .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label)),
    [frontends, can],
  );

  const path = loc.pathname;
  const activeId = useMemo(() => {
    if (path === '/') return 'core:dashboard';
    if (path.startsWith('/modules')) return 'core:modules';
    if (path.startsWith('/settings')) return 'core:settings';
    const m = /^\/m\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) return undefined;
    const sub = m[2] || '/';
    let best: string | undefined;
    let bestLen = -1;
    for (const n of navItems) {
      if (n.moduleId !== m[1]) continue;
      for (const c of [n, ...(n.children ?? [])]) {
        const p = c.path ?? '/';
        if ((sub === p || sub.startsWith(p.endsWith('/') ? p : p + '/') || p === '/') && p.length >= bestLen) {
          best = `${n.moduleId}:${c.id}`;
          bestLen = p.length;
        }
      }
    }
    return best;
  }, [path, navItems]);

  const href = (moduleId: string, p?: string) => `/m/${moduleId}${!p || p === '/' ? '' : p}`;
  const onNavigate = (_id: string, e: React.MouseEvent) => {
    const a = (e.currentTarget as HTMLElement).closest('a');
    const target = a?.getAttribute('href');
    if (target && target.startsWith('/')) {
      e.preventDefault();
      navigate(target);
    }
  };

  // ── Command palette (module commands + core destinations) ──────────────────────
  const commands = useMemo(() => {
    const list: (PaletteCommand & { run(): void })[] = [
      { id: 'core:dashboard', label: 'Dashboard', group: 'Platform', run: () => navigate('/') },
      { id: 'core:modules', label: 'Module Manager', group: 'Platform', permitted: can('modules.read'), run: () => navigate('/modules') },
      { id: 'core:settings', label: 'Settings', group: 'Platform', run: () => navigate('/settings') },
    ];
    for (const n of navItems) list.push({ id: `nav:${n.moduleId}:${n.id}`, label: n.label, group: 'Go to', run: () => navigate(href(n.moduleId, n.path)) });
    for (const f of frontends)
      for (const c of f.contribution.commands ?? [])
        list.push({
          id: `cmd:${f.moduleId}:${c.id}`,
          label: c.label,
          description: c.description,
          keywords: c.keywords,
          group: modules.find((m) => m.id === f.moduleId)?.name ?? f.moduleId,
          permitted: can(c.permission),
          run: () => (c.run ? c.run() : navigate(href(f.moduleId, c.path))),
        });
    return list;
  }, [navItems, frontends, modules, can]);

  // ── Header ─────────────────────────────────────────────────────────────────────
  const statusLabel = connection !== 'open' ? (connection === 'connecting' ? 'Connecting' : 'Offline') : health === 'HEALTHY' ? 'Online' : health === 'DEGRADED' ? 'Degraded' : health === 'OFFLINE' ? 'Offline' : 'Error';
  const statusTone = statusLabel === 'Online' ? 'success' : statusLabel === 'Degraded' || statusLabel === 'Connecting' ? 'warning' : 'error';
  const indicators = frontends.flatMap((f) => (f.contribution.statusIndicators ?? []).filter((s) => can(s.permission)).map((s) => ({ ...s, moduleId: f.moduleId })));

  const userMenu: MenuEntry[] = [
    { type: 'label', label: 'Theme' },
    { id: 'theme:system', label: 'Match system', checked: theme === 'system' },
    { id: 'theme:light', label: 'Light', checked: theme === 'light' },
    { id: 'theme:dark', label: 'Dark', checked: theme === 'dark' },
    { id: 'theme:high-contrast', label: 'High contrast', checked: theme === 'high-contrast' },
    { type: 'separator' },
    { id: 'account', label: 'Account and API tokens', icon: 'person-placeholder' },
    { id: 'signout', label: 'Sign out', icon: 'log' },
  ];

  const notificationPanel = (
    <Stack gap={3} style={{ width: 'min(360px, 85vw)', maxHeight: 420, overflow: 'auto', padding: 4 }}>
      <Stack direction="horizontal" justify="space-between" align="center">
        <Text as="strong">Notifications</Text>
        {notifications.unread ? (
          <Button
            size="sm"
            variant="tertiary"
            onClick={async () => {
              await api.post('/api/v1/notifications/read');
              void refreshNotifications();
            }}
          >
            Mark all read
          </Button>
        ) : null}
      </Stack>
      {notifications.items.length === 0 ? <Text tone="secondary">No notifications.</Text> : null}
      {notifications.items.map((n) => (
        <Stack key={n.id} gap={1}>
          <StatusIndicator tone={n.tone === 'information' ? 'information' : n.tone} size="sm">
            {n.unread ? <strong>{n.title}</strong> : n.title}
          </StatusIndicator>
          {n.message ? <Text size="sm">{n.message}</Text> : null}
          <Text size="xs" tone="secondary">
            {formatRelative(n.timestamp)}
            {n.module ? ` · ${n.module}` : ''}
          </Text>
        </Stack>
      ))}
    </Stack>
  );

  const header = (
    <ApplicationHeader
      productName="Server Control"
      secondaryTitle={session.serverName}
      homeHref="/"
      context={[
        { id: 'status', priority: 10, align: 'end', content: <StatusIndicator tone={statusTone} indicator="dot" size="sm" role="status">{statusLabel}</StatusIndicator> },
        ...(session.simulated ? [{ id: 'simulated', priority: 1, content: <StatusIndicator tone="warning" size="sm" indicator="dot">Simulated host actions</StatusIndicator> }] : []),
        ...indicators.map((s) => ({
          id: `${s.moduleId}:${s.id}`,
          priority: 0,
          align: 'end' as const,
          content: (
            <ModuleScopeProvider moduleId={s.moduleId}>
              <ErrorBoundary label={s.id}>
                <s.component />
              </ErrorBoundary>
            </ModuleScopeProvider>
          ),
        })),
      ]}
      additionalActions={[{ id: 'search', label: 'Search commands (Ctrl+K)', icon: 'search', onClick: () => setPaletteOpen(true) }]}
      notificationCount={notifications.unread}
      notifications={notificationPanel}
      helpItems={[
        { id: 'about', label: `About Server Control ${session.coreVersion}` },
        { id: 'health', label: 'Platform health' },
      ]}
      onHelpAction={(id) => navigate(id === 'health' ? '/modules?tab=health' : '/settings?tab=about')}
      user={{ name: user.displayName, email: user.username, role: user.permissions.includes('*') ? 'Administrator' : 'User' }}
      userMenuItems={userMenu}
      onUserAction={(id) => {
        if (id.startsWith('theme:')) onThemeChange(id.slice(6) as ThemePreference);
        else if (id === 'account') navigate('/settings?tab=account');
        else if (id === 'signout') void platform.signOut();
      }}
      onSettingsClick={() => navigate('/settings')}
    />
  );

  const navigation = (
    <SideNavigation
      activeId={activeId}
      onNavigate={onNavigate}
      footer={
        <>
          {can('modules.read') ? <NavigationItem id="core:modules" label="Modules" icon="puzzle" href="/modules" /> : null}
          <NavigationItem id="core:settings" label="Settings" icon="action-settings" href="/settings" />
        </>
      }
    >
      <NavigationItem id="core:dashboard" label="Dashboard" icon="home" href="/" />
      {navItems.length ? (
        <NavigationGroup label="Server">
          {navItems.map((n) =>
            n.children?.length ? (
              <NavigationItem key={`${n.moduleId}:${n.id}`} id={`${n.moduleId}:${n.id}`} label={n.label} icon={n.icon}>
                {n.children.filter((c) => can(c.permission)).map((c) => (
                  <NavigationItem key={c.id} id={`${n.moduleId}:${c.id}`} label={c.label} href={href(n.moduleId, c.path)} />
                ))}
              </NavigationItem>
            ) : (
              <NavigationItem key={`${n.moduleId}:${n.id}`} id={`${n.moduleId}:${n.id}`} label={n.label} icon={n.icon} href={href(n.moduleId, n.path)} />
            ),
          )}
        </NavigationGroup>
      ) : null}
    </SideNavigation>
  );

  // ── Routing ────────────────────────────────────────────────────────────────────
  let page: React.ReactNode;
  const moduleMatch = /^\/m\/([a-z][a-z0-9-]*)(\/.*)?$/.exec(path);
  if (path === '/') page = <Dashboard frontends={frontends} />;
  else if (path === '/modules') page = <ModuleManager />;
  else if (path.startsWith('/modules/')) page = <ModuleDetail id={decodeURIComponent(path.slice(9))} />;
  else if (path === '/settings') page = <SettingsPage />;
  else if (moduleMatch) page = <ModuleHost moduleId={moduleMatch[1]} subPath={moduleMatch[2] || '/'} frontends={frontends} loadError={loadFailures().get(moduleMatch[1])} />;
  else page = <NotFound />;

  return (
    <PlatformContext.Provider value={platform}>
      <AppShell header={header} navigation={navigation}>
        <ErrorBoundary label="This page" resetKey={path}>
          {connection === 'closed' && modules.length === 0 ? <ErrorMessage error={new Error('The connection to the server was lost. Reconnecting…')} /> : null}
          {page}
        </ErrorBoundary>
      </AppShell>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        commands={commands}
        globalShortcut
        title="Go to or run"
        onSelect={(c) => {
          setPaletteOpen(false);
          commands.find((x) => x.id === c.id)?.run();
        }}
      />
    </PlatformContext.Provider>
  );
}
