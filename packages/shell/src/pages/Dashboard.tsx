import { useRef, useState } from 'react';
import { Card, Dashboard as DashboardLayout, DashboardWidget, EmptyState, MetricCard, Page, Button } from '@enterprise-ui/react';
import { hasPermission } from '@servermin/sdk';
import { ErrorMessage, ModuleScopeProvider, api, formatBytes, formatDuration, navigate, usePlatform, useQuery, type RegisteredFrontend } from '@servermin/client';
import { ErrorBoundary } from '../shell/ErrorBoundary';

interface Summary {
  hostname: string;
  os: string;
  uptimeSeconds: number;
  load: number[];
  cpu: { cores: number; model: string; usagePercent: number | null };
  memory: { total: number; used: number; available: number };
  disks: { path: string; total: number; used: number; free: number }[];
  network: { rxBytes: number; txBytes: number; interfaces: string[] };
  health: { status: string; modules: Record<string, { state: string; health: string }> };
}

const toneFor = (pct: number) => (pct >= 90 ? 'error' : pct >= 75 ? 'warning' : 'success');

/** Core host information plus widgets that modules register (§31). */
export function Dashboard({ frontends }: { frontends: RegisteredFrontend[] }) {
  const { user, serverName } = usePlatform();
  const history = useRef<{ cpu: number[]; mem: number[] }>({ cpu: [], mem: [] });
  const last = useRef<{ at: number; rx: number; tx: number } | null>(null);
  const [rate, setRate] = useState<{ rx: number; tx: number } | null>(null);
  const q = useQuery(
    async (signal) => {
      const s = await api.get<Summary>('/api/v1/system', undefined, signal);
      const h = history.current;
      if (s.cpu.usagePercent !== null) h.cpu = [...h.cpu, s.cpu.usagePercent].slice(-30);
      h.mem = [...h.mem, (s.memory.used / s.memory.total) * 100].slice(-30);
      const now = Date.now();
      if (last.current) {
        const dt = (now - last.current.at) / 1000;
        setRate({ rx: Math.max(0, (s.network.rxBytes - last.current.rx) / dt), tx: Math.max(0, (s.network.txBytes - last.current.tx) / dt) });
      }
      last.current = { at: now, rx: s.network.rxBytes, tx: s.network.txBytes };
      return s;
    },
    [],
    { intervalMs: 5000 },
  );
  const s = q.data;
  const memPct = s ? (s.memory.used / s.memory.total) * 100 : 0;
  const root = s?.disks[0];
  const diskPct = root ? (root.used / root.total) * 100 : 0;
  const moduleStates = s ? Object.values(s.health.modules) : [];
  const failing = moduleStates.filter((m) => m.state === 'ERROR' || m.state === 'BLOCKED' || m.health === 'ERROR' || m.health === 'DEGRADED').length;

  const widgets = frontends
    .flatMap((f) => (f.contribution.widgets ?? []).map((w) => ({ ...w, moduleId: f.moduleId, revision: f.revision })))
    .filter((w) => !w.permission || hasPermission(user.permissions, w.permission))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));

  return (
    <Page title="Dashboard" subtitle={s ? `${s.hostname} · ${s.os}` : serverName}>
      {q.error && !s ? <ErrorMessage error={q.error} onRetry={() => void q.refresh()} /> : null}
      <DashboardLayout columns={{ base: 1, sm: 2, md: 4 }} aria-label="Server overview">
        <DashboardWidget>
          <MetricCard title="CPU" icon="it-host" loading={!s} value={s?.cpu.usagePercent?.toFixed(0) ?? '–'} unit="%" subtitle={s ? `${s.cpu.cores} cores` : undefined} tone={toneFor(s?.cpu.usagePercent ?? 0)} sparkline={history.current.cpu.length > 1 ? history.current.cpu : undefined} />
        </DashboardWidget>
        <DashboardWidget>
          <MetricCard title="Memory" icon="it-system" loading={!s} value={memPct.toFixed(0)} unit="%" subtitle={s ? `${formatBytes(s.memory.used)} of ${formatBytes(s.memory.total)}` : undefined} tone={toneFor(memPct)} sparkline={history.current.mem.length > 1 ? history.current.mem : undefined} />
        </DashboardWidget>
        <DashboardWidget>
          <MetricCard title="Disk (/)" icon="database" loading={!s} value={root ? diskPct.toFixed(0) : '–'} unit="%" subtitle={root ? `${formatBytes(root.free)} free of ${formatBytes(root.total)}` : undefined} tone={toneFor(diskPct)} />
        </DashboardWidget>
        <DashboardWidget>
          <MetricCard
            title="System health"
            icon="sys-monitor"
            loading={!s}
            value={s ? (s.health.status === 'HEALTHY' ? 'Healthy' : s.health.status === 'DEGRADED' ? 'Degraded' : s.health.status) : '–'}
            tone={s?.health.status === 'HEALTHY' ? 'success' : 'warning'}
            subtitle={s ? (failing ? `${failing} module${failing === 1 ? '' : 's'} need attention` : `${moduleStates.length} modules`) : undefined}
            onClick={() => navigate('/modules')}
          />
        </DashboardWidget>
        <DashboardWidget>
          <MetricCard title="Uptime" icon="clock" loading={!s} value={s ? formatDuration(s.uptimeSeconds) : '–'} />
        </DashboardWidget>
        <DashboardWidget>
          <MetricCard title="Load average" icon="performance" loading={!s} value={s ? s.load[0].toFixed(2) : '–'} subtitle={s ? `5 min ${s.load[1].toFixed(2)} · 15 min ${s.load[2].toFixed(2)}` : undefined} />
        </DashboardWidget>
        <DashboardWidget span={2}>
          <MetricCard title="Network" icon="connected" loading={!s} value={rate ? `↓ ${formatBytes(rate.rx)}/s  ↑ ${formatBytes(rate.tx)}/s` : '…'} subtitle={s ? `${s.network.interfaces.length} interfaces: ${s.network.interfaces.join(', ') || 'none'}` : undefined} />
        </DashboardWidget>
        {widgets.map((w) => (
          <DashboardWidget key={`${w.moduleId}:${w.id}`} span={w.span ?? 1}>
            <Card title={w.title} headerDivider style={{ height: '100%' }}>
              <ModuleScopeProvider moduleId={w.moduleId}>
                <ErrorBoundary label={w.title} resetKey={w.revision}>
                  <w.component />
                </ErrorBoundary>
              </ModuleScopeProvider>
            </Card>
          </DashboardWidget>
        ))}
      </DashboardLayout>
      {widgets.length === 0 && s ? (
        <EmptyState
          size="sm"
          icon="puzzle"
          title="No module widgets"
          description="Modules add widgets here when they are active."
          actions={<Button onClick={() => navigate('/modules')}>Manage modules</Button>}
        />
      ) : null}
    </Page>
  );
}
