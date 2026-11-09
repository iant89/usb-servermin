import { Button, EmptyState, MessageStrip, Page, Skeleton, Stack } from '@enterprise-ui/react';
import { ModuleScopeProvider, PermissionDenied, api, navigate, usePermission, usePlatform, useLocation, type RegisteredFrontend } from '@servermin/client';
import { useState } from 'react';
import { ErrorBoundary } from './ErrorBoundary';
import { matchRoute } from './match';

/**
 * Renders `/m/<moduleId>/<path>`. The shell knows nothing about specific modules: it looks up
 * the routes the module registered and shows a precise state when the module is not usable.
 */
export function ModuleHost({ moduleId, subPath, frontends, loadError }: { moduleId: string; subPath: string; frontends: RegisteredFrontend[]; loadError?: string }) {
  const platform = usePlatform();
  const info = platform.modules.find((m) => m.id === moduleId);
  const registered = frontends.find((f) => f.moduleId === moduleId);
  const loc = useLocation();
  const canConfigure = usePermission('modules.configure');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = async (action: 'enable' | 'reload') => {
    setBusy(true);
    setActionError(null);
    try {
      await api.post(`/api/v1/platform/modules/${moduleId}/${action}`);
      await platform.refreshModules();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const unavailable = (title: string, description: string, actions?: React.ReactNode, icon = 'puzzle') => (
    <Page title={info?.name ?? moduleId}>
      <Stack gap={4}>
        {actionError ? <MessageStrip tone="error">{actionError}</MessageStrip> : null}
        <EmptyState icon={icon} title={title} description={description} actions={actions} />
      </Stack>
    </Page>
  );

  const manage = (
    <Button variant="secondary" onClick={() => navigate(`/modules/${moduleId}`)}>
      Open in Module Manager
    </Button>
  );

  if (!info)
    return unavailable('Module missing', `No module with the id "${moduleId}" is installed.`, (
      <Button variant="primary" onClick={() => navigate('/modules')}>
        Browse modules
      </Button>
    ));
  if (!info.enabled)
    return unavailable('Module unavailable', `The ${info.name} module is currently disabled.`, canConfigure ? (
      <>
        <Button variant="primary" loading={busy} onClick={() => void act('enable')}>
          Enable module
        </Button>
        {manage}
      </>
    ) : undefined);
  if (info.state === 'BLOCKED')
    return unavailable('Dependency unavailable', `${info.name} is waiting for: ${info.blockedBy.join('; ') || 'a required module'}.`, manage, 'chain-link');
  if (info.state === 'ERROR')
    return unavailable(`${info.name} has failed`, info.error ?? 'The module stopped with an error.', canConfigure ? (
      <>
        <Button variant="primary" loading={busy} onClick={() => void act('reload')}>
          Reload module
        </Button>
        <Button variant="secondary" onClick={() => navigate(`/modules/${moduleId}?tab=logs`)}>
          View logs
        </Button>
      </>
    ) : undefined, 'message-error');
  if (info.state !== 'ACTIVE') return unavailable(`${info.name} is ${info.state.toLowerCase()}`, 'The module is changing state. This page updates automatically.', undefined, 'process');
  if (loadError) return unavailable('Interface failed to load', loadError, manage, 'message-error');
  if (!registered)
    return (
      <Page title={info.name}>
        <Skeleton lines={8} aria-label={`Loading ${info.name}`} />
      </Page>
    );

  const routes = registered.contribution.routes ?? [];
  const hit = matchRoute(routes, subPath || '/');
  if (!hit) return unavailable('Page not found', `${info.name} has no page at ${subPath}.`, (
    <Button onClick={() => navigate(`/m/${moduleId}`)}>Go to {info.name}</Button>
  ), 'search');

  const Component = hit.route.component;
  return (
    <ModuleScopeProvider moduleId={moduleId}>
      <PermissionCheck permission={hit.route.permission} title={info.name}>
        <ErrorBoundary label={info.name} resetKey={`${registered.revision}|${subPath}`}>
          <Component key={registered.revision} params={hit.params} path={subPath} query={new URLSearchParams(loc.search)} />
        </ErrorBoundary>
      </PermissionCheck>
    </ModuleScopeProvider>
  );
}

function PermissionCheck({ permission, title, children }: { permission?: string; title: string; children: React.ReactNode }) {
  const ok = usePermission(permission);
  return ok ? (
    <>{children}</>
  ) : (
    <Page title={title}>
      <PermissionDenied permission={permission} />
    </Page>
  );
}
