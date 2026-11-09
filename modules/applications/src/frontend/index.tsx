import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  DescriptionList,
  Dialog,
  EmptyState,
  Flex,
  Input,
  MessageStrip,
  Page,
  Select,
  Stack,
  StatusIndicator,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Table,
  Text,
  TextArea,
  useToast,
} from '@enterprise-ui/react';
import { ApiRequestError, ErrorMessage, Guard, QueryView, formatDate, formatRelative, linkHandler, modulePath, navigate, registerFrontend, useConfirm, useModuleApi, useQuery, type ModuleRouteProps } from '@servermin/client';

interface App {
  id: string;
  name: string;
  description: string;
  type: 'docker' | 'compose' | 'static' | 'node' | 'service';
  spec: Record<string, any>;
  environment: Record<string, string>;
  ports: string[];
  domains: string[];
  version: string;
  deployedVersion: string | null;
  updatedAt: string;
  status: { state: string; detail: string; containers?: any[] };
}

const TYPES = [
  { value: 'docker', label: 'Container image' },
  { value: 'compose', label: 'Docker Compose' },
  { value: 'static', label: 'Static website' },
  { value: 'node', label: 'Node.js application' },
  { value: 'service', label: 'System service' },
];
const typeLabel = (t: string) => TYPES.find((x) => x.value === t)?.label ?? t;
const stateTone = (s: string) => (s === 'running' ? 'success' : s === 'failed' ? 'error' : s === 'degraded' ? 'warning' : s === 'unknown' ? 'warning' : 'neutral');

function AppsPage() {
  const api = useModuleApi();
  const q = useQuery(() => api.get<App[]>('/apps'), [api], { intervalMs: 10_000 });
  const caps = useQuery(() => api.get<{ docker: boolean; systemd: boolean }>('/capabilities'), [api]);
  const [creating, setCreating] = useState(false);
  return (
    <Page
      title="Applications"
      subtitle="Software deployed on this server, with versions and deployment history."
      actions={
        <Guard permission="applications.write">
          <Button variant="primary" icon="add" onClick={() => setCreating(true)}>
            New application
          </Button>
        </Guard>
      }
    >
      <Stack gap={3}>
        {caps.data && !caps.data.docker ? <MessageStrip tone="information">The Docker module is not active. Only system-service applications can be deployed until it is enabled.</MessageStrip> : null}
        <QueryView query={q} empty={<EmptyState icon="product" title="No applications yet" description="Deploy a container image, a Compose stack, a static site, a Node.js app or manage an existing system service." />}>
          {(apps) => (
            <Table
              caption="Applications"
              data={apps}
              responsive="stack"
              columns={[
                {
                  id: 'name',
                  header: 'Application',
                  rowHeader: true,
                  sortable: true,
                  accessor: 'name',
                  cell: (a) => (
                    <div>
                      <a href={modulePath('applications', `/${a.id}`)} onClick={linkHandler(modulePath('applications', `/${a.id}`))}>
                        {a.name}
                      </a>
                      <Text as="div" size="sm" tone="secondary" maxLines={1}>
                        {a.description}
                      </Text>
                    </div>
                  ),
                },
                { id: 'type', header: 'Type', cell: (a) => typeLabel(a.type) },
                { id: 'status', header: 'Status', cell: (a) => <StatusIndicator tone={stateTone(a.status.state)}>{a.status.state.replace('-', ' ')}</StatusIndicator> },
                { id: 'version', header: 'Version', cell: (a) => <span className="sm-mono">{a.deployedVersion ?? '–'}</span> },
                { id: 'ports', header: 'Ports', cell: (a) => a.ports.join(', ') },
                { id: 'domains', header: 'Domains', cell: (a) => a.domains.join(', ') },
              ]}
            />
          )}
        </QueryView>
      </Stack>
      {creating ? <AppDialog onClose={() => setCreating(false)} onSaved={(id) => navigate(modulePath('applications', `/${id}`))} /> : null}
    </Page>
  );
}

const lines = (s: string) => s.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
const envToText = (e: Record<string, string>) => Object.entries(e).map(([k, v]) => `${k}=${v}`).join('\n');
const textToEnv = (s: string) => Object.fromEntries(s.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=') < 0 ? l.length : l.indexOf('=')), l.indexOf('=') < 0 ? '' : l.slice(l.indexOf('=') + 1)]));

function AppDialog({ app, onClose, onSaved }: { app?: App; onClose: () => void; onSaved: (id: string) => void }) {
  const api = useModuleApi();
  const toast = useToast();
  const [type, setType] = useState<string | null>(app?.type ?? 'docker');
  const [f, setF] = useState({
    id: app?.id ?? '',
    name: app?.name ?? '',
    description: app?.description ?? '',
    version: app?.version ?? 'latest',
    image: app?.spec.image ?? '',
    compose: app?.spec.compose ?? 'services:\n  app:\n    image: nginx:${APP_VERSION}\n    ports:\n      - "8080:80"\n',
    directory: app?.spec.directory ?? '',
    command: app?.spec.command ?? '',
    nodeVersion: app?.spec.nodeVersion ?? '22',
    unit: app?.spec.unit ?? '',
    volumes: (app?.spec.volumes ?? []).join('\n'),
    ports: (app?.ports ?? []).join('\n'),
    domains: (app?.domains ?? []).join('\n'),
    env: envToText(app?.environment ?? {}),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    const body = {
      id: f.id,
      name: f.name,
      description: f.description,
      type,
      version: f.version,
      spec: { image: f.image || undefined, compose: type === 'compose' ? f.compose : undefined, directory: f.directory || undefined, command: f.command || undefined, nodeVersion: type === 'node' ? f.nodeVersion : undefined, unit: f.unit || undefined, volumes: lines(f.volumes) },
      ports: lines(f.ports),
      domains: lines(f.domains),
      environment: textToEnv(f.env),
    };
    try {
      const saved = app ? await api.put<App>(`/apps/${app.id}`, body) : await api.post<App>('/apps', body);
      toast.show({ title: app ? 'Application saved' : 'Application created', description: app ? undefined : 'Deploy it to start it.', tone: 'success' });
      onSaved(saved.id);
    } catch (e) {
      setError(e as Error);
      setBusy(false);
    }
  };
  const containerBased = type !== 'service' && type !== 'compose';
  return (
    <Dialog
      open
      onClose={onClose}
      title={app ? `Edit ${app.name}` : 'New application'}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {app ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <Stack gap={3}>
        {error ? <ErrorMessage error={error} title="Not saved" /> : null}
        <Flex gap={3} wrap>
          <Input label="Name" value={f.name} onChange={(e) => setF((x) => ({ ...x, name: e.target.value, id: app ? x.id : e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^(\d)/, 'app-$1') }))} required />
          <Input label="Id" value={f.id} onChange={set('id')} disabled={!!app} className="sm-mono" required />
        </Flex>
        <Input label="Description" value={f.description} onChange={set('description')} />
        <Flex gap={3} wrap>
          <Select label="Type" value={type} onChange={setType} options={TYPES} disabled={!!app} />
          <Input label={type === 'docker' ? 'Version (image tag)' : 'Version'} value={f.version} onChange={set('version')} className="sm-mono" />
        </Flex>
        {type === 'docker' ? <Input label="Image" value={f.image} onChange={set('image')} placeholder="ghcr.io/example/app" className="sm-mono" required /> : null}
        {type === 'compose' ? <TextArea label="compose.yaml" description="${APP_VERSION} is replaced with the version being deployed." value={f.compose} onChange={set('compose')} rows={12} className="sm-mono" /> : null}
        {type === 'static' || type === 'node' ? <Input label="Directory on the server" value={f.directory} onChange={set('directory')} placeholder="/srv/www/site" className="sm-mono" required /> : null}
        {type === 'node' ? (
          <Flex gap={3} wrap>
            <Input label="Start command" value={f.command} onChange={set('command')} placeholder="npm ci --omit=dev && npm start" className="sm-mono" />
            <Input label="Node.js version" value={f.nodeVersion} onChange={set('nodeVersion')} />
          </Flex>
        ) : null}
        {type === 'service' ? <Input label="systemd unit" value={f.unit} onChange={set('unit')} placeholder="myapp.service" className="sm-mono" required /> : null}
        {containerBased ? (
          <>
            <TextArea label="Ports" description="One per line: host:container, e.g. 8080:80" value={f.ports} onChange={set('ports')} rows={2} className="sm-mono" />
            <TextArea label="Volumes" description="One per line: name:/path or /host/path:/path[:ro]" value={f.volumes} onChange={set('volumes')} rows={2} className="sm-mono" />
            <TextArea label="Environment" description="One KEY=value per line. Values of keys containing PASS, SECRET, TOKEN or KEY are hidden." value={f.env} onChange={set('env')} rows={4} className="sm-mono" />
          </>
        ) : null}
        <TextArea label="Domains" description="Host names this application is reached under (used by reverse-proxy modules)." value={f.domains} onChange={set('domains')} rows={2} />
      </Stack>
    </Dialog>
  );
}

function AppDetail({ params }: ModuleRouteProps) {
  const api = useModuleApi();
  const toast = useToast();
  const id = params.id;
  const q = useQuery(() => api.get<App>(`/apps/${id}`), [api, id], { intervalMs: 10_000 });
  const deployments = useQuery(() => api.get<any[]>(`/apps/${id}/deployments`), [api, id]);
  const [tab, setTab] = useState('overview');
  const logs = useQuery(() => api.get<string[]>(`/apps/${id}/logs`, { tail: 500 }), [api, id], { enabled: tab === 'logs', intervalMs: 10_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [deployOpen, setDeployOpen] = useState(false);
  const [version, setVersion] = useState('');
  const [editing, setEditing] = useState(false);
  const { confirm, dialog } = useConfirm();
  const app = q.data;

  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      toast.show({ title: done, tone: 'success' });
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(null);
      void q.refresh();
      void deployments.refresh();
    }
  };

  if (q.error && !app)
    return (
      <Page title="Application">
        <ErrorMessage error={q.error} />
      </Page>
    );
  return (
    <Page
      title={app?.name ?? id}
      subtitle={app?.description}
      breadcrumbs={[{ label: 'Applications', href: modulePath('applications'), onClick: linkHandler(modulePath('applications')) } as any, { label: app?.name ?? id }]}
      titleAddon={app ? <StatusIndicator tone={stateTone(app.status.state)}>{app.status.detail}</StatusIndicator> : undefined}
      actions={
        app ? (
          <Flex gap={2} wrap>
            <Guard permission="applications.deploy">
              <Button variant="primary" icon="upload" loading={busy === 'deploy'} onClick={() => { setVersion(app.version); setDeployOpen(true); }}>
                Deploy
              </Button>
              <Button loading={busy === 'restart'} disabled={app.status.state === 'not-deployed'} onClick={() => void run('restart', () => api.post(`/apps/${id}/restart`), 'Restarted')}>
                Restart
              </Button>
              {app.status.state === 'running' ? (
                <Button loading={busy === 'stop'} onClick={() => void run('stop', () => api.post(`/apps/${id}/stop`), 'Stopped')}>
                  Stop
                </Button>
              ) : (
                <Button loading={busy === 'start'} disabled={app.status.state === 'not-deployed'} onClick={() => void run('start', () => api.post(`/apps/${id}/start`), 'Started')}>
                  Start
                </Button>
              )}
            </Guard>
            <Guard permission="applications.write">
              <Button onClick={() => setEditing(true)}>Edit</Button>
              <Button
                variant="destructive"
                onClick={async () => {
                  if (!(await confirm({ title: `Remove ${app.name}?`, message: 'Its containers are removed and its deployment history is deleted. Named volumes and files on the server are kept.', confirmLabel: 'Remove', tone: 'error' }))) return;
                  await run('remove', () => api.delete(`/apps/${id}`), 'Application removed');
                  navigate(modulePath('applications'));
                }}
              >
                Remove
              </Button>
            </Guard>
          </Flex>
        ) : undefined
      }
    >
      {dialog}
      <Stack gap={4}>
        {error ? (
          <Stack gap={2}>
            <ErrorMessage error={error} title="The operation failed" />
            {error instanceof ApiRequestError && error.details?.log ? <pre className="sm-pre">{error.details.log.join('\n')}</pre> : null}
          </Stack>
        ) : null}
        <QueryView query={q}>
          {(a) => (
            <Tabs value={tab} onValueChange={setTab}>
              <TabList aria-label="Application">
                <Tab value="overview">Overview</Tab>
                <Tab value="deployments" count={deployments.data?.length}>
                  Deployments
                </Tab>
                <Tab value="logs">Logs</Tab>
              </TabList>
              <TabPanel value="overview">
                <Card title="Configuration">
                  <DescriptionList
                    columns={3}
                    items={[
                      { term: 'Type', description: typeLabel(a.type) },
                      { term: 'Deployed version', description: a.deployedVersion ?? 'Not deployed' },
                      { term: 'Configured version', description: a.version },
                      { term: 'Image', description: a.spec.image ? <span className="sm-mono">{a.spec.image}</span> : undefined },
                      { term: 'Directory', description: a.spec.directory ? <span className="sm-mono">{a.spec.directory}</span> : undefined },
                      { term: 'Service', description: a.spec.unit },
                      { term: 'Ports', description: a.ports.length ? <Flex gap={1} wrap>{a.ports.map((p) => <Badge key={p}>{p}</Badge>)}</Flex> : undefined },
                      { term: 'Domains', description: a.domains.join(', ') },
                      { term: 'Environment', description: Object.keys(a.environment).join(', ') },
                      { term: 'Updated', description: formatRelative(a.updatedAt) },
                    ]}
                  />
                </Card>
              </TabPanel>
              <TabPanel value="deployments">
                <QueryView query={deployments} empty={<Text tone="secondary">Not deployed yet.</Text>}>
                  {(rows) => (
                    <Table
                      caption="Deployments"
                      data={rows}
                      getRowId={(r) => String(r.id)}
                      columns={[
                        { id: 'id', header: '#', width: 60, accessor: 'id' },
                        { id: 'v', header: 'Version', cell: (r) => <span className="sm-mono">{r.version}</span> },
                        { id: 's', header: 'Result', cell: (r) => <StatusIndicator tone={r.status === 'succeeded' ? 'success' : r.status === 'failed' ? 'error' : 'information'}>{r.status}</StatusIndicator> },
                        { id: 't', header: 'Started', cell: (r) => formatDate(r.started_at) },
                        { id: 'u', header: 'By', accessor: 'user' },
                        { id: 'l', header: 'Log', wrap: true, cell: (r) => <details><summary>Show</summary><pre className="sm-pre">{r.log}</pre></details> },
                        {
                          id: 'a',
                          header: 'Actions',
                          align: 'end',
                          cell: (r) =>
                            r.status === 'succeeded' && r.version !== a.deployedVersion ? (
                              <Guard permission="applications.deploy">
                                <Button size="sm" onClick={() => void run('deploy', () => api.post(`/apps/${id}/deploy`, { version: r.version }), `Rolled back to ${r.version}`)}>
                                  Redeploy
                                </Button>
                              </Guard>
                            ) : null,
                        },
                      ]}
                    />
                  )}
                </QueryView>
              </TabPanel>
              <TabPanel value="logs">
                <QueryView query={logs} empty={<Text tone="secondary">No log output.</Text>}>
                  {(l) => <pre className="sm-pre" style={{ maxHeight: 560 }}>{l.join('\n')}</pre>}
                </QueryView>
              </TabPanel>
            </Tabs>
          )}
        </QueryView>
      </Stack>
      <Dialog
        open={deployOpen}
        onClose={() => setDeployOpen(false)}
        title={`Deploy ${app?.name ?? ''}`}
        size="sm"
        footer={
          <>
            <Button onClick={() => setDeployOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!version}
              onClick={() => {
                setDeployOpen(false);
                void run('deploy', () => api.post(`/apps/${id}/deploy`, { version }), `Deployed ${version}`);
              }}
            >
              Deploy
            </Button>
          </>
        }
      >
        <Input label="Version" value={version} onChange={(e) => setVersion(e.target.value)} className="sm-mono" description={app?.type === 'docker' ? 'The image tag to run.' : undefined} />
      </Dialog>
      {editing && app ? <AppDialog app={app} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void q.refresh(); }} /> : null}
    </Page>
  );
}

function AppsWidget() {
  const api = useModuleApi();
  const q = useQuery(() => api.get<App[]>('/apps'), [api], { intervalMs: 30_000 });
  return (
    <QueryView query={q} skeletonLines={3} empty={<Text tone="secondary">No applications.</Text>}>
      {(apps) => (
        <Stack gap={2}>
          {apps.slice(0, 6).map((a) => (
            <Flex key={a.id} justify="space-between" gap={2}>
              <a href={modulePath('applications', `/${a.id}`)} onClick={linkHandler(modulePath('applications', `/${a.id}`))}>
                {a.name}
              </a>
              <StatusIndicator size="sm" tone={stateTone(a.status.state)}>
                {a.status.state.replace('-', ' ')}
              </StatusIndicator>
            </Flex>
          ))}
        </Stack>
      )}
    </QueryView>
  );
}

registerFrontend('applications', {
  routes: [
    { path: '/', component: AppsPage, permission: 'applications.read' },
    { path: '/:id', component: AppDetail, permission: 'applications.read' },
  ],
  navigation: [{ id: 'applications', label: 'Applications', icon: 'product', order: 60, permission: 'applications.read' }],
  widgets: [{ id: 'list', title: 'Applications', component: AppsWidget, order: 60, permission: 'applications.read' }],
  commands: [{ id: 'new', label: 'Deploy an application', path: '/', permission: 'applications.write' }],
});
