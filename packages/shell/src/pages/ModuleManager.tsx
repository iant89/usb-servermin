import { useState } from 'react';
import { Badge, Button, Card, DescriptionList, DropdownMenu, IconButton, Page, StatusIndicator, Tab, TabList, TabPanel, Table, Tabs, Text, useToast, type TableColumn } from '@enterprise-ui/react';
import { ErrorMessage, Guard, QueryView, api, formatRelative, linkHandler, navigate, stateTone, usePermission, usePlatform, useLocation, useModuleEvents, useQuery } from '@servermin/client';
import { InstallDialog } from './InstallDialog';

export interface ModuleSummary {
  id: string;
  name: string;
  version: string;
  description?: string;
  state: string;
  enabled: boolean;
  error?: string;
  blockedBy: string[];
  health: { status: string; message?: string };
  sourceType: string;
  integrity: string;
  updatedAt: string;
  dependents: string[];
}

interface Discovered {
  path: string;
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  errors: string[];
  state: string;
  installedVersion: string | null;
}

export function ModuleStatus({ m }: { m: Pick<ModuleSummary, 'state' | 'enabled' | 'health'> }) {
  const label = m.state === 'ACTIVE' && m.health.status !== 'HEALTHY' ? `Active · ${m.health.status.toLowerCase()}` : m.state.charAt(0) + m.state.slice(1).toLowerCase();
  return <StatusIndicator tone={m.state === 'ACTIVE' && m.health.status !== 'HEALTHY' ? 'warning' : stateTone(m.state)}>{label}</StatusIndicator>;
}

export function ModuleManager() {
  const loc = useLocation();
  const tab = new URLSearchParams(loc.search).get('tab') ?? 'installed';
  const toast = useToast();
  const { refreshModules } = usePlatform();
  const [installOpen, setInstallOpen] = useState<{ path?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const canConfigure = usePermission('modules.configure');
  const installed = useQuery(() => api.get<ModuleSummary[]>('/api/v1/platform/modules'), []);
  const discovered = useQuery(() => api.get<Discovered[]>('/api/v1/platform/modules/discover'), [], { enabled: tab === 'available' });
  const health = useQuery(() => api.get<{ status: string; uptimeSeconds: number; modules: Record<string, { state: string; health: string; message?: string }>; processes: { id: string; owner: string; command: string; startedAt: string; pid?: number; longRunning: boolean }[] }>('/api/v1/platform/health'), [], { enabled: tab === 'health', intervalMs: 5000 });
  useModuleEvents(() => void installed.refresh());

  const act = async (id: string, action: string) => {
    setBusy(`${id}:${action}`);
    setError(null);
    try {
      const r = await api.post<ModuleSummary>(`/api/v1/platform/modules/${id}/${action}`);
      toast.show({ title: `${r.name}: ${r.state.toLowerCase()}`, tone: r.state === 'ERROR' ? 'error' : 'success' });
      await installed.refresh();
      await refreshModules();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(null);
    }
  };

  const columns: TableColumn<ModuleSummary>[] = [
    {
      id: 'name',
      header: 'Module',
      rowHeader: true,
      accessor: 'name',
      sortable: true,
      cell: (m) => (
        <div>
          <a href={`/modules/${m.id}`} onClick={linkHandler(`/modules/${m.id}`)}>
            {m.name}
          </a>
          <Text as="div" size="sm" tone="secondary" maxLines={1}>
            {m.description}
          </Text>
        </div>
      ),
    },
    { id: 'version', header: 'Version', accessor: 'version', cell: (m) => <span className="sm-mono">{m.version}</span> },
    { id: 'state', header: 'Status', accessor: 'state', sortable: true, cell: (m) => <ModuleStatus m={m} /> },
    {
      id: 'source',
      header: 'Source',
      accessor: 'sourceType',
      cell: (m) => (
        <Badge tone={m.integrity === 'verified' ? 'success' : 'neutral'}>
          {m.sourceType}
          {m.integrity === 'verified' ? ' · verified' : ''}
        </Badge>
      ),
    },
    { id: 'updated', header: 'Updated', accessor: 'updatedAt', cell: (m) => formatRelative(m.updatedAt) },
    {
      id: 'actions',
      header: <span className="eui-visually-hidden">Actions</span>,
      headerText: 'Actions',
      align: 'end',
      cell: (m) =>
        canConfigure ? (
          <DropdownMenu
            trigger={<IconButton icon="overflow" label={`Actions for ${m.name}`} loading={busy?.startsWith(m.id + ':')} />}
            placement="bottom-end"
            items={[
              m.enabled ? { id: 'disable', label: 'Disable' } : { id: 'enable', label: 'Enable' },
              { id: 'reload', label: 'Reload', disabled: !m.enabled },
              { id: 'restart', label: 'Restart', disabled: !m.enabled || m.state !== 'ACTIVE' },
              { type: 'separator' },
              { id: 'details', label: 'Details, settings and logs' },
            ]}
            onAction={(action) => (action === 'details' ? navigate(`/modules/${m.id}`) : void act(m.id, action))}
          />
        ) : null,
    },
  ];

  const setTab = (t: string) => navigate(`/modules${t === 'installed' ? '' : `?tab=${t}`}`, { replace: true });

  return (
    <Page
      title="Modules"
      subtitle="Every capability of this server is a module. Install, enable, reload and remove them without restarting the platform."
      actions={
        <Guard permission="modules.install">
          <Button variant="primary" icon="add" onClick={() => setInstallOpen({})}>
            Install module
          </Button>
        </Guard>
      }
    >
      {error ? <ErrorMessage error={error} title="The action failed" /> : null}
      <Tabs value={tab} onValueChange={setTab}>
        <TabList aria-label="Module views">
          <Tab value="installed" count={installed.data?.length}>
            Installed
          </Tab>
          <Tab value="available">Available</Tab>
          <Tab value="health">Health</Tab>
        </TabList>
        <TabPanel value="installed">
          <QueryView query={installed}>
            {(list) => (
              <Table
                columns={columns}
                data={list}
                caption="Installed modules"
                responsive="stack"
                getRowHighlight={(m) => (m.state === 'ERROR' ? 'error' : m.state === 'BLOCKED' ? 'warning' : undefined)}
                defaultSort={{ columnId: 'name', direction: 'ascending' }}
              />
            )}
          </QueryView>
        </TabPanel>
        <TabPanel value="available">
          <Text as="p" tone="secondary">
            Modules found in the local module sources on this server.
          </Text>
          <QueryView query={discovered} empty={<Text>No modules were found in the configured sources.</Text>}>
            {(list) => (
              <Table
                caption="Available modules"
                data={list}
                getRowId={(d) => d.path}
                responsive="stack"
                columns={[
                  { id: 'name', header: 'Module', rowHeader: true, cell: (d) => <div>{d.name ?? d.path}<Text as="div" size="sm" tone="secondary">{d.description}</Text></div> },
                  { id: 'version', header: 'Version', cell: (d) => <span className="sm-mono">{d.version ?? '–'}</span> },
                  {
                    id: 'state',
                    header: 'Status',
                    cell: (d) =>
                      d.errors.length ? (
                        <StatusIndicator tone="error">Invalid: {d.errors[0]}</StatusIndicator>
                      ) : d.installedVersion ? (
                        <StatusIndicator tone={d.installedVersion === d.version ? 'success' : 'information'}>{d.installedVersion === d.version ? 'Installed' : `Installed ${d.installedVersion}`}</StatusIndicator>
                      ) : (
                        <StatusIndicator tone="neutral">Not installed</StatusIndicator>
                      ),
                  },
                  {
                    id: 'action',
                    header: 'Action',
                    headerText: 'Action',
                    align: 'end',
                    cell: (d) =>
                      d.errors.length || d.installedVersion === d.version ? null : (
                        <Guard permission="modules.install">
                          <Button size="sm" onClick={() => setInstallOpen({ path: d.path })}>
                            {d.installedVersion ? 'Update' : 'Install'}
                          </Button>
                        </Guard>
                      ),
                  },
                ]}
              />
            )}
          </QueryView>
        </TabPanel>
        <TabPanel value="health">
          <QueryView query={health}>
            {(h) => (
              <Card title="Platform health" subtitle="Module health is independent of core health.">
                <DescriptionList
                  columns={3}
                  items={[
                    { term: 'Core', description: <StatusIndicator tone={h.status === 'HEALTHY' ? 'success' : 'warning'}>{h.status}</StatusIndicator> },
                    { term: 'Core uptime', description: `${Math.round(h.uptimeSeconds / 60)} min` },
                    { term: 'Running module processes', description: String(h.processes.length) },
                    ...Object.entries(h.modules).map(([id, m]) => ({ id, term: id, description: <StatusIndicator tone={m.state === 'ACTIVE' ? stateTone(m.health) : stateTone(m.state)}>{m.state === 'ACTIVE' ? m.health : m.state}{m.message ? ` · ${m.message}` : ''}</StatusIndicator> })),
                  ]}
                />
              </Card>
            )}
          </QueryView>
        </TabPanel>
      </Tabs>
      {installOpen ? (
        <InstallDialog
          open
          initialPath={installOpen.path}
          moduleId={installOpen.path ? discovered.data?.find((d) => d.path === installOpen.path && d.installedVersion)?.id : undefined}
          onClose={() => setInstallOpen(null)}
          onDone={(warnings) => {
            setInstallOpen(null);
            toast.show({ title: 'Module installed', description: warnings.join(' ') || undefined, tone: 'success' });
            void installed.refresh();
            void discovered.refresh();
            void refreshModules();
          }}
        />
      ) : null}
    </Page>
  );
}
