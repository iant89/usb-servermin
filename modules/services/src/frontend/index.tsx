import { useMemo, useState } from 'react';
import { Badge, Button, Card, DescriptionList, DropdownMenu, Flex, IconButton, Page, SearchField, SegmentedButton, Select, Stack, StatusIndicator, Table, Text, useToast } from '@enterprise-ui/react';
import { ApiRequestError, ErrorMessage, Guard, QueryView, formatBytes, formatDate, linkHandler, modulePath, registerFrontend, stateTone, useConfirm, useModuleApi, usePermission, useQuery, type ModuleRouteProps } from '@servermin/client';

interface Unit {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
  enabled: string | null;
}

function useServiceAction(onDone: () => void) {
  const api = useModuleApi();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const run = async (unit: string, action: string, confirmed = false): Promise<void> => {
    if (action === 'stop' && !confirmed && !(await confirm({ title: `Stop ${unit}?`, message: 'Anything that depends on this service stops working until it is started again.', confirmLabel: 'Stop service' }))) return;
    setBusy(`${unit}:${action}`);
    setError(null);
    try {
      await api.post(`/services/${unit}/${action}`, { confirm: confirmed || action === 'stop' });
      toast.show({ title: `${unit}: ${action} done`, tone: 'success' });
      onDone();
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 428 && !confirmed) {
        if (await confirm({ title: `${action} ${unit}?`, message: e.message, tone: 'error', confirmLabel: action, acknowledge: 'I have another way to reach this server if access is lost' })) return run(unit, action, true);
      } else setError(e as Error);
    } finally {
      setBusy(null);
    }
  };
  return { run, busy, error, dialog };
}

function ServicesPage() {
  const api = useModuleApi();
  const q = useQuery(() => api.get<Unit[]>('/services'), [api], { intervalMs: 15_000 });
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('loaded');
  const canWrite = usePermission('services.write');
  const a = useServiceAction(() => void q.refresh());
  const rows = useMemo(
    () =>
      (q.data ?? []).filter((u) => {
        if (filter === 'running' && u.sub !== 'running') return false;
        if (filter === 'failed' && u.active !== 'failed') return false;
        if (filter === 'loaded' && u.load === 'not-loaded') return false;
        const s = search.toLowerCase();
        return !s || u.unit.toLowerCase().includes(s) || u.description.toLowerCase().includes(s);
      }),
    [q.data, search, filter],
  );
  const failedCount = (q.data ?? []).filter((u) => u.active === 'failed').length;
  return (
    <Page title="Services" subtitle="systemd services on this server.">
      {a.dialog}
      <Stack gap={3}>
        <Flex gap={3} wrap align="flex-end">
          <SearchField label="Search services" value={search} onChange={setSearch} />
          <SegmentedButton
            aria-label="Show"
            selectionMode="single"
            value={[filter]}
            onChange={(v) => v[0] && setFilter(v[0])}
            items={[
              { value: 'loaded', label: 'Loaded' },
              { value: 'running', label: 'Running' },
              { value: 'failed', label: `Failed (${failedCount})` },
              { value: 'all', label: 'All' },
            ]}
          />
        </Flex>
        {a.error ? <ErrorMessage error={a.error} /> : null}
        <QueryView query={q}>
          {() => (
            <Table
              caption="Services"
              data={rows}
              getRowId={(u) => u.unit}
              responsive="stack"
              stickyHeader
              maxHeight={640}
              getRowHighlight={(u) => (u.active === 'failed' ? 'error' : undefined)}
              emptyState={<Text tone="secondary">No services match.</Text>}
              columns={[
                {
                  id: 'unit',
                  header: 'Service',
                  rowHeader: true,
                  sortable: true,
                  accessor: 'unit',
                  cell: (u) => (
                    <div>
                      <a href={modulePath('services', `/${u.unit}`)} onClick={linkHandler(modulePath('services', `/${u.unit}`))}>
                        {u.unit.replace(/\.service$/, '')}
                      </a>
                      <Text as="div" size="sm" tone="secondary" maxLines={1}>
                        {u.description}
                      </Text>
                    </div>
                  ),
                },
                { id: 'state', header: 'State', sortable: true, accessor: 'active', cell: (u) => <StatusIndicator tone={stateTone(u.active === 'active' ? 'running' : u.active)}>{`${u.active} (${u.sub})`}</StatusIndicator> },
                { id: 'enabled', header: 'At boot', accessor: 'enabled', cell: (u) => (u.enabled ? <Badge tone={u.enabled === 'enabled' ? 'success' : 'neutral'}>{u.enabled}</Badge> : '–') },
                {
                  id: 'actions',
                  header: 'Actions',
                  align: 'end',
                  cell: (u) =>
                    canWrite ? (
                      <DropdownMenu
                        trigger={<IconButton icon="overflow" label={`Actions for ${u.unit}`} loading={a.busy?.startsWith(u.unit + ':')} />}
                        placement="bottom-end"
                        items={[
                          { id: 'start', label: 'Start', disabled: u.active === 'active' },
                          { id: 'restart', label: 'Restart' },
                          { id: 'stop', label: 'Stop', disabled: u.active !== 'active' },
                          { type: 'separator' },
                          { id: 'enable', label: 'Enable at boot', disabled: u.enabled === 'enabled' || u.enabled === 'static' },
                          { id: 'disable', label: 'Disable at boot', disabled: u.enabled !== 'enabled' },
                        ]}
                        onAction={(action) => void a.run(u.unit, action)}
                      />
                    ) : null,
                },
              ]}
            />
          )}
        </QueryView>
      </Stack>
    </Page>
  );
}

const PRIORITY_TONE: Record<string, 'error' | 'warning' | 'information' | 'neutral'> = { emerg: 'error', alert: 'error', crit: 'error', err: 'error', warning: 'warning', notice: 'information', info: 'neutral', debug: 'neutral' };

function ServiceDetail({ params }: ModuleRouteProps) {
  const api = useModuleApi();
  const unit = params.unit;
  const q = useQuery(() => api.get<Record<string, string>>(`/services/${unit}`), [api, unit], { intervalMs: 10_000 });
  const [lines, setLines] = useState<string | null>('200');
  const logs = useQuery(() => api.get<any[]>(`/services/${unit}/logs`, { lines: lines ?? '200' }), [api, unit, lines], { intervalMs: 10_000 });
  const a = useServiceAction(() => void q.refresh());
  const p = q.data;
  return (
    <Page
      title={unit.replace(/\.service$/, '')}
      subtitle={p?.Description}
      breadcrumbs={[{ label: 'Services', href: modulePath('services'), onClick: linkHandler(modulePath('services')) } as any, { label: unit }]}
      titleAddon={p ? <StatusIndicator tone={stateTone(p.ActiveState === 'active' ? 'running' : p.ActiveState)}>{`${p.ActiveState} (${p.SubState})`}</StatusIndicator> : undefined}
      actions={
        <Guard permission="services.write">
          <Flex gap={2} wrap>
            <Button onClick={() => void a.run(unit, 'start')} disabled={p?.ActiveState === 'active'} loading={a.busy === `${unit}:start`}>
              Start
            </Button>
            <Button onClick={() => void a.run(unit, 'restart')} loading={a.busy === `${unit}:restart`}>
              Restart
            </Button>
            <Button variant="destructive" onClick={() => void a.run(unit, 'stop')} disabled={p?.ActiveState !== 'active'} loading={a.busy === `${unit}:stop`}>
              Stop
            </Button>
          </Flex>
        </Guard>
      }
    >
      {a.dialog}
      <Stack gap={4}>
        {a.error ? <ErrorMessage error={a.error} /> : null}
        <QueryView query={q}>
          {(s) => (
            <Card title="Properties">
              <DescriptionList
                columns={3}
                items={[
                  { term: 'At boot', description: s.UnitFileState },
                  { term: 'Main PID', description: s.MainPID !== '0' ? s.MainPID : '–' },
                  { term: 'Running since', description: s.ActiveState === 'active' ? formatDate(s.ActiveEnterTimestamp) : '–' },
                  { term: 'Memory', description: /^\d+$/.test(s.MemoryCurrent ?? '') ? formatBytes(Number(s.MemoryCurrent)) : '–' },
                  { term: 'CPU time', description: /^\d+$/.test(s.CPUUsageNSec ?? '') ? `${(Number(s.CPUUsageNSec) / 1e9).toFixed(1)} s` : '–' },
                  { term: 'Tasks', description: /^\d+$/.test(s.TasksCurrent ?? '') ? s.TasksCurrent : '–' },
                  { term: 'Restart policy', description: `${s.Restart} (${s.NRestarts ?? 0} restarts)` },
                  { term: 'Last result', description: s.Result },
                  { term: 'Runs as', description: s.User || 'root' },
                  { term: 'Unit file', description: <span className="sm-mono">{s.FragmentPath}</span>, span: 'full' },
                ]}
              />
            </Card>
          )}
        </QueryView>
        <Card title="Logs" headerActions={<Select label="Lines" hideLabel value={lines} onChange={setLines} options={['100', '200', '500', '2000'].map((n) => ({ value: n, label: `${n} lines` }))} size="sm" />} noPadding>
          <QueryView query={logs} empty={<div style={{ padding: 16 }}><Text tone="secondary">No log entries.</Text></div>}>
            {(rows) => (
              <Table
                caption={`Logs of ${unit}`}
                data={[...rows].reverse()}
                getRowId={(r, i) => `${r.time}-${i}`}
                density="compact"
                maxHeight={520}
                stickyHeader
                columns={[
                  { id: 't', header: 'Time', width: 180, cell: (r) => formatDate(r.time) },
                  { id: 'p', header: 'Priority', width: 110, cell: (r) => <StatusIndicator size="sm" tone={PRIORITY_TONE[r.priority]}>{r.priority}</StatusIndicator> },
                  { id: 'm', header: 'Message', wrap: true, cell: (r) => <span className="sm-mono">{r.message}</span> },
                ]}
              />
            )}
          </QueryView>
        </Card>
      </Stack>
    </Page>
  );
}

function ServicesWidget() {
  const api = useModuleApi();
  const q = useQuery(() => api.get<any>('/summary'), [api], { intervalMs: 30_000 });
  return (
    <QueryView query={q} skeletonLines={2}>
      {(s) => (
        <Stack gap={2}>
          <DescriptionList
            columns={2}
            items={[
              { term: 'Running', description: String(s.running) },
              { term: 'Failed', description: <StatusIndicator tone={s.failed.length ? 'error' : 'success'}>{String(s.failed.length)}</StatusIndicator> },
            ]}
          />
          {s.failed.slice(0, 3).map((u: string) => (
            <a key={u} href={modulePath('services', `/${u}`)} onClick={linkHandler(modulePath('services', `/${u}`))}>
              {u}
            </a>
          ))}
        </Stack>
      )}
    </QueryView>
  );
}

registerFrontend('services', {
  routes: [
    { path: '/', component: ServicesPage, permission: 'services.read' },
    { path: '/:unit', component: ServiceDetail, permission: 'services.read' },
  ],
  navigation: [{ id: 'services', label: 'Services', icon: 'process', order: 50, permission: 'services.read' }],
  widgets: [{ id: 'summary', title: 'Services', component: ServicesWidget, order: 50, permission: 'services.read' }],
  commands: [{ id: 'list', label: 'Manage services', path: '/', permission: 'services.read', keywords: ['systemd', 'systemctl'] }],
});
