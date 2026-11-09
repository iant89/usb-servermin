import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  DescriptionList,
  Dialog,
  EmptyState,
  Flex,
  MessageStrip,
  Page,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Table,
  Tabs,
  Text,
  useToast,
} from '@enterprise-ui/react';
import type { ConfigField } from '@servermin/sdk';
import { ErrorMessage, Guard, QueryView, api, formatDate, navigate, usePlatform, useLocation, useModuleEvents, useQuery } from '@servermin/client';
import { InstallDialog } from './InstallDialog';
import { ModuleConfigForm } from './ModuleConfigForm';
import { ModuleLogs } from './ModuleLogs';
import { ModuleStatus, type ModuleSummary } from './ModuleManager';

interface ModuleDetails extends ModuleSummary {
  author?: string;
  installedAt: string;
  source: string;
  dependencies: Record<string, string>;
  requires: { capability: string; optional?: boolean }[];
  provides: string[];
  capabilities: string[];
  permissions: { id: string; description: string }[];
  channels: { name: string; permission: string }[];
  host: { commands?: string[]; privileged?: string[] };
  config: ConfigField[];
  hasBackend: boolean;
  hasFrontend: boolean;
  runtime: null | { startedAt: string; routes: { method: string; path: string; permission: string }[]; channels: string[]; services: string[]; eventHandlers: number };
}

const chips = (list: string[], empty = 'None') => (list.length ? <Flex gap={1} wrap>{list.map((x) => <Badge key={x}>{x}</Badge>)}</Flex> : <Text tone="secondary">{empty}</Text>);

export function ModuleDetail({ id }: { id: string }) {
  const loc = useLocation();
  const tab = new URLSearchParams(loc.search).get('tab') ?? 'overview';
  const toast = useToast();
  const { refreshModules } = usePlatform();
  const q = useQuery(() => api.get<ModuleDetails>(`/api/v1/platform/modules/${id}`), [id]);
  const config = useQuery(() => api.get<{ schema: ConfigField[]; values: Record<string, unknown> }>(`/api/v1/platform/modules/${id}/config`), [id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [deleteData, setDeleteData] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  useModuleEvents((e) => e.payload?.moduleId === id && void q.refresh());

  const act = async (action: string) => {
    setBusy(action);
    setError(null);
    try {
      const r = await api.post<ModuleSummary>(`/api/v1/platform/modules/${id}/${action}`);
      q.setData(r as ModuleDetails);
      toast.show({ title: `${r.name} is ${r.state.toLowerCase()}`, tone: r.state === 'ERROR' ? 'error' : 'success' });
      void refreshModules();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('remove');
    try {
      await api.delete(`/api/v1/platform/modules/${id}`, { deleteData: deleteData ? 'true' : undefined });
      toast.show({ title: `${q.data?.name ?? id} was removed`, description: deleteData ? 'Its data was deleted.' : 'Its data was kept.', tone: 'success' });
      await refreshModules();
      navigate('/modules');
    } catch (e) {
      setError(e as Error);
      setBusy(null);
      setRemoveOpen(false);
    }
  };

  if (q.error && !q.data)
    return (
      <Page title="Module" breadcrumbs={[{ label: 'Modules', href: '/modules' }, { label: id }]}>
        <EmptyState icon="puzzle" title="Module not found" description={q.error.message} actions={<Button onClick={() => navigate('/modules')}>Back to modules</Button>} />
      </Page>
    );
  const m = q.data;
  const setTab = (t: string) => navigate(`/modules/${id}${t === 'overview' ? '' : `?tab=${t}`}`, { replace: true });

  return (
    <Page
      title={m?.name ?? id}
      subtitle={m?.description}
      breadcrumbs={[
        { label: 'Modules', href: '/modules', onClick: (e: React.MouseEvent) => (e.preventDefault(), navigate('/modules')) } as any,
        { label: m?.name ?? id },
      ]}
      titleAddon={m ? <ModuleStatus m={m} /> : undefined}
      actions={
        m ? (
          <Flex gap={2} wrap>
            <Guard permission="modules.configure">
              {m.enabled ? (
                <Button loading={busy === 'disable'} onClick={() => void act('disable')}>
                  Disable
                </Button>
              ) : (
                <Button variant="primary" loading={busy === 'enable'} onClick={() => void act('enable')}>
                  Enable
                </Button>
              )}
              <Button icon="refresh" loading={busy === 'reload'} disabled={!m.enabled} onClick={() => void act('reload')}>
                Reload
              </Button>
              <Button loading={busy === 'restart'} disabled={!m.enabled || m.state !== 'ACTIVE'} onClick={() => void act('restart')}>
                Restart
              </Button>
            </Guard>
            <Guard permission="modules.install">
              <Button onClick={() => setUpdateOpen(true)}>Update</Button>
            </Guard>
            <Guard permission="modules.remove">
              <Button variant="destructive" onClick={() => setRemoveOpen(true)}>
                Remove
              </Button>
            </Guard>
          </Flex>
        ) : undefined
      }
    >
      <Stack gap={4}>
        {error ? <ErrorMessage error={error} title="The action failed" /> : null}
        {m?.state === 'ERROR' ? (
          <MessageStrip tone="error" title="This module has failed">
            {m.error} The rest of the platform keeps running. Check the logs, fix the cause, then reload the module.
          </MessageStrip>
        ) : null}
        {m?.state === 'BLOCKED' ? (
          <MessageStrip tone="warning" title="Waiting for dependencies">
            {m.blockedBy.join('; ')}
          </MessageStrip>
        ) : null}
        <Tabs value={tab} onValueChange={setTab}>
          <TabList aria-label="Module details">
            <Tab value="overview">Overview</Tab>
            <Tab value="settings" count={m?.config.length || undefined}>
              Settings
            </Tab>
            <Tab value="logs">Logs</Tab>
          </TabList>
          <TabPanel value="overview">
            <QueryView query={q}>
              {(d) => (
                <Stack gap={4}>
                  <Card title="General">
                    <DescriptionList
                      columns={3}
                      items={[
                        { term: 'Id', description: <span className="sm-mono">{d.id}</span> },
                        { term: 'Version', description: d.version },
                        { term: 'Author', description: d.author },
                        { term: 'Source', description: d.source },
                        { term: 'Integrity', description: d.integrity === 'verified' ? 'All files verified (SHA-256)' : 'Not verified' },
                        { term: 'Installed', description: formatDate(d.installedAt) },
                        { term: 'Health', description: d.health.message ? `${d.health.status} · ${d.health.message}` : d.health.status },
                        { term: 'Parts', description: [d.hasBackend && 'backend', d.hasFrontend && 'user interface'].filter(Boolean).join(', ') },
                        { term: 'Used by', description: d.dependents.length ? d.dependents.join(', ') : undefined },
                      ]}
                    />
                  </Card>
                  <Card title="Dependencies and capabilities">
                    <DescriptionList
                      columns={2}
                      items={[
                        { term: 'Depends on modules', description: chips(Object.entries(d.dependencies).map(([k, v]) => `${k} ${v}`)) },
                        { term: 'Requires services', description: chips(d.requires.map((r) => `${r.capability}${r.optional ? ' (optional)' : ''}`)) },
                        { term: 'Provides services', description: chips(d.provides) },
                        { term: 'Capabilities', description: chips(d.capabilities) },
                      ]}
                    />
                  </Card>
                  <Card title="Permissions and host access" subtitle="What the module declared in its manifest. The core refuses anything else.">
                    <Stack gap={4}>
                      <Table
                        caption="Permissions"
                        hideCaption={false}
                        data={d.permissions}
                        density="compact"
                        emptyState={<Text tone="secondary">No permissions declared.</Text>}
                        columns={[
                          { id: 'id', header: 'Permission', rowHeader: true, cell: (p) => <span className="sm-mono">{p.id}</span> },
                          { id: 'd', header: 'Description', accessor: 'description' },
                        ]}
                      />
                      <DescriptionList
                        columns={2}
                        items={[
                          { term: 'Commands it may run', description: chips(d.host.commands ?? []) },
                          { term: 'Privileged operations', description: chips(d.host.privileged ?? []) },
                          { term: 'Real-time channels', description: chips(d.channels.map((c) => `${d.id}.${c.name}`)) },
                        ]}
                      />
                    </Stack>
                  </Card>
                  {d.runtime ? (
                    <Card title="Runtime" subtitle={`Running since ${formatDate(d.runtime.startedAt)} · ${d.runtime.eventHandlers} event handlers`}>
                      <Table
                        caption="Registered routes"
                        hideCaption={false}
                        data={d.runtime.routes}
                        getRowId={(r) => r.method + r.path}
                        density="compact"
                        columns={[
                          { id: 'm', header: 'Method', width: 90, accessor: 'method' },
                          { id: 'p', header: 'Path', cell: (r) => <span className="sm-mono">/api/v1/modules/{d.id}{r.path}</span> },
                          { id: 'perm', header: 'Permission', cell: (r) => <span className="sm-mono">{r.permission}</span> },
                        ]}
                      />
                    </Card>
                  ) : null}
                </Stack>
              )}
            </QueryView>
          </TabPanel>
          <TabPanel value="settings">
            <QueryView query={config}>{(c) => <ModuleConfigForm moduleId={id} schema={c.schema} values={c.values} onSaved={() => void config.refresh()} />}</QueryView>
          </TabPanel>
          <TabPanel value="logs">
            <ModuleLogs moduleId={id} />
          </TabPanel>
        </Tabs>
      </Stack>
      <Dialog
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        title={`Remove ${m?.name ?? id}?`}
        tone="warning"
        size="sm"
        footer={
          <>
            <Button onClick={() => setRemoveOpen(false)}>Cancel</Button>
            <Button variant="destructive" loading={busy === 'remove'} onClick={() => void remove()}>
              Remove module
            </Button>
          </>
        }
      >
        <Stack gap={3}>
          <Text as="p">The module is stopped, and its routes, navigation, widgets and event handlers are removed. The core is not affected.</Text>
          {m?.dependents.length ? <MessageStrip tone="warning">These modules depend on it and will stop: {m.dependents.join(', ')}.</MessageStrip> : null}
          <Checkbox label="Also delete the module's data and settings" description="This cannot be undone." checked={deleteData} onChange={setDeleteData} />
        </Stack>
      </Dialog>
      {updateOpen ? (
        <InstallDialog
          open
          moduleId={id}
          onClose={() => setUpdateOpen(false)}
          onDone={() => {
            setUpdateOpen(false);
            toast.show({ title: 'Module updated', tone: 'success' });
            void q.refresh();
            void refreshModules();
          }}
        />
      ) : null}
    </Page>
  );
}
