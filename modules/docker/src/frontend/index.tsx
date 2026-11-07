import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Card,
  DescriptionList,
  Dialog,
  DropdownMenu,
  EmptyState,
  Flex,
  IconButton,
  Input,
  MessageStrip,
  Page,
  Select,
  Stack,
  StatusIndicator,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Table,
  Text,
  TextArea,
  useToast,
  type TableColumn,
} from '@enterprise-ui/react';
import {
  ErrorMessage,
  Guard,
  QueryView,
  formatBytes,
  formatDate,
  formatRelative,
  linkHandler,
  modulePath,
  navigate,
  registerFrontend,
  stateTone,
  useChannel,
  useConfirm,
  useModuleApi,
  usePermission,
  useQuery,
  type ModuleRouteProps,
} from '@servermin/client';

interface Container {
  id: string;
  shortId: string;
  name: string;
  image: string;
  state: string;
  status: string;
  created: string;
  ports: string[];
  project: string | null;
}

const SECTIONS = [
  { value: '/', label: 'Containers' },
  { value: '/images', label: 'Images' },
  { value: '/networks', label: 'Networks' },
  { value: '/volumes', label: 'Volumes' },
  { value: '/compose', label: 'Compose' },
];

/** Shown instead of the views when the engine is unreachable (§45, §60). */
function EngineGate({ children }: { children: React.ReactNode }) {
  const api = useModuleApi();
  const q = useQuery(() => api.get<any>('/status'), [api], { intervalMs: 15_000 });
  if (q.data && !q.data.available)
    return (
      <EmptyState
        icon="disconnected"
        title="Docker Engine unavailable"
        description={`${q.data.error} The rest of the platform keeps working. Start Docker (sudo systemctl start docker) and this page reconnects.`}
        actions={<Button onClick={() => void q.refresh()}>Check again</Button>}
      />
    );
  return <>{children}</>;
}

function DockerPage({ path }: ModuleRouteProps) {
  const section = SECTIONS.some((s) => s.value === path) ? path : '/';
  return (
    <Page title="Docker" subtitle="Containers and everything they need.">
      <Tabs value={section} onValueChange={(v) => navigate(modulePath('docker', v), { replace: true })}>
        <TabList aria-label="Docker sections">
          {SECTIONS.map((s) => (
            <Tab key={s.value} value={s.value}>
              {s.label}
            </Tab>
          ))}
        </TabList>
      </Tabs>
      <div style={{ paddingTop: 16 }}>
        <EngineGate>{section === '/' ? <Containers /> : section === '/images' ? <Images /> : section === '/networks' ? <Networks /> : section === '/volumes' ? <Volumes /> : <Compose />}</EngineGate>
      </div>
    </Page>
  );
}

function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      if (done) toast.show({ title: done, tone: 'success' });
      return true;
    } catch (e) {
      setError(e as Error);
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, run, clear: () => setError(null) };
}

function Containers() {
  const api = useModuleApi();
  const [all, setAll] = useState(true);
  const q = useQuery(() => api.get<Container[]>('/containers', { all }), [api, all], { intervalMs: 5000 });
  const canWrite = usePermission('docker.write');
  const { confirm, dialog } = useConfirm();
  const a = useAction();
  useChannel('docker.events', {}, () => void q.refresh());

  const act = async (c: Container, action: string) => {
    if (action === 'remove') {
      if (!(await confirm({ title: `Remove ${c.name}?`, message: 'The container is deleted. Its anonymous volumes are kept unless you remove them separately.', confirmLabel: 'Remove', tone: 'error' }))) return;
      await a.run(c.id, () => api.delete(`/containers/${c.id}`, { force: 'true' }), `${c.name} removed`);
    } else await a.run(c.id, () => api.post(`/containers/${c.id}/${action}`), `${c.name}: ${action}`);
    void q.refresh();
  };

  const columns: TableColumn<Container>[] = [
    {
      id: 'name',
      header: 'Name',
      rowHeader: true,
      sortable: true,
      accessor: 'name',
      cell: (c) => (
        <a href={modulePath('docker', `/containers/${c.id}`)} onClick={linkHandler(modulePath('docker', `/containers/${c.id}`))}>
          {c.name}
        </a>
      ),
    },
    { id: 'state', header: 'State', sortable: true, accessor: 'state', cell: (c) => <StatusIndicator tone={stateTone(c.state)}>{c.status}</StatusIndicator> },
    { id: 'image', header: 'Image', accessor: 'image', cell: (c) => <span className="sm-mono">{c.image}</span> },
    { id: 'ports', header: 'Ports', cell: (c) => c.ports.join(', ') },
    { id: 'project', header: 'Project', accessor: 'project' },
    {
      id: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (c) =>
        canWrite ? (
          <Flex gap={1} justify="flex-end">
            {c.state === 'running' ? (
              <IconButton icon="stop" label={`Stop ${c.name}`} loading={a.busy === c.id} onClick={() => void act(c, 'stop')} />
            ) : (
              <IconButton icon="media-play" label={`Start ${c.name}`} loading={a.busy === c.id} onClick={() => void act(c, 'start')} />
            )}
            <DropdownMenu
              trigger={<IconButton icon="overflow" label={`More actions for ${c.name}`} />}
              placement="bottom-end"
              items={[
                { id: 'restart', label: 'Restart' },
                c.state === 'paused' ? { id: 'unpause', label: 'Resume' } : { id: 'pause', label: 'Pause', disabled: c.state !== 'running' },
                { type: 'separator' },
                { id: 'remove', label: 'Remove…', destructive: true },
              ]}
              onAction={(id) => void act(c, id)}
            />
          </Flex>
        ) : null,
    },
  ];

  return (
    <Stack gap={3}>
      {dialog}
      <Switch label="Show stopped containers" checked={all} onChange={setAll} />
      {a.error ? <ErrorMessage error={a.error} /> : null}
      <QueryView query={q} empty={<EmptyState icon="product" title="No containers" description="Run a container or deploy an application to see it here." />}>
        {(list) => <Table caption="Containers" data={list} columns={columns} responsive="stack" defaultSort={{ columnId: 'name', direction: 'ascending' }} />}
      </QueryView>
    </Stack>
  );
}

function ContainerDetail({ params }: ModuleRouteProps) {
  const api = useModuleApi();
  const cid = params.id;
  const q = useQuery(() => api.get<any>(`/containers/${cid}`), [api, cid], { intervalMs: 10_000 });
  const stats = useQuery(() => api.get<any>(`/containers/${cid}/stats`), [api, cid], { intervalMs: 5000, enabled: q.data?.State?.Running === true });
  const [tab, setTab] = useState('overview');
  const name = q.data?.Name?.replace(/^\//, '') ?? cid.slice(0, 12);
  return (
    <Page
      title={name}
      breadcrumbs={[{ label: 'Docker', href: modulePath('docker'), onClick: linkHandler(modulePath('docker')) } as any, { label: name }]}
      titleAddon={q.data ? <StatusIndicator tone={stateTone(q.data.State.Status)}>{q.data.State.Status}</StatusIndicator> : undefined}
    >
      <QueryView query={q}>
        {(c) => (
          <Tabs value={tab} onValueChange={setTab}>
            <TabList aria-label="Container">
              <Tab value="overview">Overview</Tab>
              <Tab value="logs">Logs</Tab>
              <Tab value="exec">Run command</Tab>
              <Tab value="inspect">Inspect</Tab>
            </TabList>
            <TabPanel value="overview">
              <Stack gap={4}>
                <Card title="Container">
                  <DescriptionList
                    columns={3}
                    items={[
                      { term: 'Image', description: <span className="sm-mono">{c.Config.Image}</span> },
                      { term: 'Created', description: formatDate(c.Created) },
                      { term: 'Started', description: c.State.Running ? formatRelative(c.State.StartedAt) : '–' },
                      { term: 'Restart policy', description: c.HostConfig.RestartPolicy?.Name || 'no' },
                      { term: 'Command', description: <span className="sm-mono">{[...(c.Config.Entrypoint ?? []), ...(c.Config.Cmd ?? [])].join(' ')}</span>, span: 2 },
                      { term: 'Ports', description: Object.entries(c.NetworkSettings.Ports ?? {}).map(([p, b]: any) => `${b?.[0]?.HostPort ?? '–'}→${p}`).join(', ') },
                      { term: 'Networks', description: Object.keys(c.NetworkSettings.Networks ?? {}).join(', ') },
                      { term: 'Mounts', description: (c.Mounts ?? []).map((m: any) => `${m.Source || m.Name} → ${m.Destination}`).join('; '), span: 'full' },
                    ]}
                  />
                </Card>
                {c.State.Running ? (
                  <Card title="Resource usage">
                    <QueryView query={stats} skeletonLines={2}>
                      {(s) => (
                        <DescriptionList
                          columns={4}
                          items={[
                            { term: 'CPU', description: s.cpuPercent === null ? '–' : `${s.cpuPercent.toFixed(1)} %` },
                            { term: 'Memory', description: `${formatBytes(s.memory.used)}${s.memory.limit ? ` of ${formatBytes(s.memory.limit)}` : ''}` },
                            { term: 'Network', description: `↓ ${formatBytes(s.network.rx)} ↑ ${formatBytes(s.network.tx)}` },
                            { term: 'Processes', description: s.pids ?? '–' },
                          ]}
                        />
                      )}
                    </QueryView>
                  </Card>
                ) : null}
              </Stack>
            </TabPanel>
            <TabPanel value="logs">
              <LiveLogs id={cid} />
            </TabPanel>
            <TabPanel value="exec">
              <Guard permission="docker.execute" fallback={<Text tone="secondary">You need the docker.execute permission.</Text>}>
                <Exec id={cid} running={c.State.Running} />
              </Guard>
            </TabPanel>
            <TabPanel value="inspect">
              <pre className="sm-pre">{JSON.stringify(c, null, 2)}</pre>
            </TabPanel>
          </Tabs>
        )}
      </QueryView>
    </Page>
  );
}

function LiveLogs({ id }: { id: string }) {
  const [lines, setLines] = useState<{ stream: string; text: string }[]>([]);
  const [follow, setFollow] = useState(true);
  const ref = useRef<HTMLPreElement>(null);
  const ch = useChannel<{ stream: string; lines: string[] }>(follow ? 'docker.logs' : null, { id, tail: 300 }, (d) =>
    setLines((prev) => [...prev, ...d.lines.map((text) => ({ stream: d.stream, text }))].slice(-3000)),
  );
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);
  return (
    <Stack gap={3}>
      <Flex gap={3} align="center" wrap>
        <Switch label="Follow" checked={follow} onChange={setFollow} />
        <Button size="sm" onClick={() => setLines([])}>
          Clear
        </Button>
        <Button
          size="sm"
          icon="download"
          onClick={() => {
            const blob = new Blob([lines.map((l) => l.text).join('\n')], { type: 'text/plain' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${id.slice(0, 12)}.log`;
            a.click();
          }}
        >
          Export
        </Button>
        {ch.status === 'error' ? <StatusIndicator tone="error">{ch.error}</StatusIndicator> : null}
      </Flex>
      <pre ref={ref} className="sm-pre" aria-live="off" style={{ maxHeight: 560 }}>
        {lines.length ? lines.map((l, i) => <div key={i} style={l.stream === 'stderr' ? { color: 'var(--eui-color-text-error, #b00)' } : undefined}>{l.text}</div>) : 'No log output yet.'}
      </pre>
    </Stack>
  );
}

function Exec({ id, running }: { id: string; running: boolean }) {
  const api = useModuleApi();
  const [command, setCommand] = useState('');
  const [result, setResult] = useState<{ exitCode: number; stdout: string; stderr: string } | null>(null);
  const a = useAction();
  if (!running) return <MessageStrip tone="information">Start the container to run commands in it.</MessageStrip>;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void a.run('exec', async () => setResult(await api.post(`/containers/${id}/exec`, { command })));
      }}
    >
      <Stack gap={3}>
        <Flex gap={2} align="flex-end">
          <Input label="Command" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="ls -la /" className="sm-mono" style={{ minWidth: 320 }} />
          <Button type="submit" variant="primary" loading={a.busy === 'exec'} disabled={!command}>
            Run
          </Button>
        </Flex>
        <Text size="sm" tone="secondary">
          Runs once with sh -c and returns the output. For an interactive shell use the Terminal module: docker exec -it {id.slice(0, 12)} sh
        </Text>
        {a.error ? <ErrorMessage error={a.error} /> : null}
        {result ? (
          <Stack gap={2}>
            <StatusIndicator tone={result.exitCode === 0 ? 'success' : 'error'}>Exit code {result.exitCode}</StatusIndicator>
            <pre className="sm-pre">{result.stdout + result.stderr || '(no output)'}</pre>
          </Stack>
        ) : null}
      </Stack>
    </form>
  );
}

function Images() {
  const api = useModuleApi();
  const q = useQuery(() => api.get<any[]>('/images'), [api]);
  const [image, setImage] = useState('');
  const a = useAction();
  const { confirm, dialog } = useConfirm();
  return (
    <Stack gap={3}>
      {dialog}
      <Guard permission="docker.write">
        <form onSubmit={(e) => (e.preventDefault(), void a.run('pull', () => api.post('/images/pull', { image }), `Pulled ${image}`).then((ok) => { if (ok) { setImage(''); void q.refresh(); } }))}>
          <Flex gap={2} align="flex-end" wrap>
            <Input label="Pull image" value={image} onChange={(e) => setImage(e.target.value)} placeholder="nginx:alpine" />
            <Button type="submit" loading={a.busy === 'pull'} disabled={!image}>
              Pull
            </Button>
            <Button onClick={() => void a.run('prune', () => api.post('/images/prune'), 'Unused images removed').then(() => q.refresh())} loading={a.busy === 'prune'}>
              Remove unused images
            </Button>
          </Flex>
        </form>
      </Guard>
      {a.error ? <ErrorMessage error={a.error} /> : null}
      <QueryView query={q}>
        {(list) => (
          <Table
            caption="Images"
            data={list}
            responsive="stack"
            columns={[
              { id: 't', header: 'Tags', rowHeader: true, cell: (i) => <span className="sm-mono">{i.tags.join(', ') || '<none>'}</span> },
              { id: 'id', header: 'Id', cell: (i) => <span className="sm-mono">{i.shortId}</span> },
              { id: 's', header: 'Size', align: 'end', sortable: true, accessor: 'size', cell: (i) => formatBytes(i.size) },
              { id: 'c', header: 'Created', cell: (i) => formatRelative(i.created) },
              {
                id: 'a',
                header: 'Actions',
                align: 'end',
                cell: (i) => (
                  <Guard permission="docker.write">
                    <IconButton
                      icon="delete"
                      label={`Remove ${i.tags[0] ?? i.shortId}`}
                      onClick={async () => (await confirm({ title: 'Remove image?', message: i.tags.join(', ') || i.shortId, confirmLabel: 'Remove', tone: 'error' })) && (await a.run(i.id, () => api.delete(`/images/${i.id.replace('sha256:', '')}`), 'Image removed'), q.refresh())}
                    />
                  </Guard>
                ),
              },
            ]}
          />
        )}
      </QueryView>
    </Stack>
  );
}

function Networks() {
  const api = useModuleApi();
  const q = useQuery(() => api.get<any[]>('/networks'), [api]);
  const [name, setName] = useState('');
  const [driver, setDriver] = useState<string | null>('bridge');
  const a = useAction();
  const builtIn = (n: string) => ['bridge', 'host', 'none'].includes(n);
  return (
    <Stack gap={3}>
      <Guard permission="docker.write">
        <Flex gap={2} align="flex-end" wrap>
          <Input label="New network" value={name} onChange={(e) => setName(e.target.value)} />
          <Select label="Driver" value={driver} onChange={setDriver} options={['bridge', 'macvlan', 'ipvlan', 'overlay'].map((d) => ({ value: d, label: d }))} />
          <Button disabled={!name} loading={a.busy === 'create'} onClick={() => void a.run('create', () => api.post('/networks', { name, driver }), 'Network created').then((ok) => { if (ok) { setName(''); void q.refresh(); } })}>
            Create
          </Button>
        </Flex>
      </Guard>
      {a.error ? <ErrorMessage error={a.error} /> : null}
      <QueryView query={q}>
        {(list) => (
          <Table
            caption="Networks"
            data={list}
            responsive="stack"
            columns={[
              { id: 'n', header: 'Name', rowHeader: true, accessor: 'name', sortable: true },
              { id: 'd', header: 'Driver', accessor: 'driver' },
              { id: 's', header: 'Subnets', cell: (n) => n.subnets.join(', ') },
              { id: 'c', header: 'Containers', accessor: 'containers', align: 'end' },
              {
                id: 'a',
                header: 'Actions',
                align: 'end',
                cell: (n) => (builtIn(n.name) ? null : <Guard permission="docker.write"><IconButton icon="delete" label={`Remove ${n.name}`} onClick={() => void a.run(n.id, () => api.delete(`/networks/${n.id}`), 'Network removed').then(() => q.refresh())} /></Guard>),
              },
            ]}
          />
        )}
      </QueryView>
    </Stack>
  );
}

function Volumes() {
  const api = useModuleApi();
  const q = useQuery(() => api.get<any[]>('/volumes'), [api]);
  const [name, setName] = useState('');
  const a = useAction();
  const { confirm, dialog } = useConfirm();
  return (
    <Stack gap={3}>
      {dialog}
      <Guard permission="docker.write">
        <Flex gap={2} align="flex-end">
          <Input label="New volume" value={name} onChange={(e) => setName(e.target.value)} />
          <Button disabled={!name} onClick={() => void a.run('create', () => api.post('/volumes', { name }), 'Volume created').then((ok) => { if (ok) { setName(''); void q.refresh(); } })}>
            Create
          </Button>
        </Flex>
      </Guard>
      {a.error ? <ErrorMessage error={a.error} /> : null}
      <QueryView query={q} empty={<Text tone="secondary">No volumes.</Text>}>
        {(list) => (
          <Table
            caption="Volumes"
            data={list}
            getRowId={(v) => v.name}
            responsive="stack"
            columns={[
              { id: 'n', header: 'Name', rowHeader: true, cell: (v) => <span className="sm-mono">{v.name}</span> },
              { id: 'p', header: 'Project', accessor: 'project' },
              { id: 'd', header: 'Driver', accessor: 'driver' },
              { id: 'm', header: 'Mount point', wrap: true, cell: (v) => <span className="sm-mono">{v.mountpoint}</span> },
              {
                id: 'a',
                header: 'Actions',
                align: 'end',
                cell: (v) => (
                  <Guard permission="docker.write">
                    <IconButton
                      icon="delete"
                      label={`Remove ${v.name}`}
                      onClick={async () =>
                        (await confirm({ title: 'Delete volume?', message: `All data in ${v.name} is deleted permanently.`, confirmLabel: 'Delete volume', tone: 'error', acknowledge: 'I understand the data cannot be recovered' })) &&
                        (await a.run(v.name, () => api.delete(`/volumes/${v.name}`), 'Volume deleted'), q.refresh())
                      }
                    />
                  </Guard>
                ),
              },
            ]}
          />
        )}
      </QueryView>
    </Stack>
  );
}

function Compose() {
  const api = useModuleApi();
  const q = useQuery(() => api.get<any[]>('/compose'), [api], { intervalMs: 10_000 });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [yaml, setYaml] = useState('services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "8080:80"\n    restart: unless-stopped\n');
  const [output, setOutput] = useState<string | null>(null);
  const a = useAction();
  const run = (project: string, action: string) => a.run(`${project}:${action}`, async () => setOutput((await api.post<{ output: string }>(`/compose/${project}/${action}`)).output), `${project}: ${action}`).then(() => q.refresh());
  return (
    <Stack gap={3}>
      <Guard permission="docker.write">
        <div>
          <Button variant="primary" icon="add" onClick={() => setOpen(true)}>
            New project
          </Button>
        </div>
      </Guard>
      {a.error ? <ErrorMessage error={a.error} /> : null}
      <QueryView query={q} empty={<EmptyState icon="grid" title="No Compose projects" description="Projects appear here when their containers exist." />}>
        {(list) => (
          <Table
            caption="Compose projects"
            data={list}
            getRowId={(p) => p.name}
            responsive="stack"
            columns={[
              { id: 'n', header: 'Project', rowHeader: true, accessor: 'name' },
              { id: 's', header: 'Services', cell: (p) => p.services.join(', ') },
              { id: 'r', header: 'Running', cell: (p) => <StatusIndicator tone={p.running === p.total ? 'success' : p.running ? 'warning' : 'neutral'}>{`${p.running} of ${p.total}`}</StatusIndicator> },
              { id: 'd', header: 'Directory', cell: (p) => <span className="sm-mono">{p.workingDir}</span> },
              {
                id: 'a',
                header: 'Actions',
                align: 'end',
                cell: (p) => (
                  <Guard permission="docker.write">
                    <DropdownMenu
                      trigger={<IconButton icon="overflow" label={`Actions for ${p.name}`} loading={a.busy?.startsWith(p.name + ':')} />}
                      placement="bottom-end"
                      items={[{ id: 'up', label: 'Up' }, { id: 'restart', label: 'Restart' }, { id: 'stop', label: 'Stop' }, { id: 'pull', label: 'Pull images' }, { type: 'separator' }, { id: 'down', label: 'Down (remove containers)', destructive: true }]}
                      onAction={(action) => void run(p.name, action)}
                    />
                  </Guard>
                ),
              },
            ]}
          />
        )}
      </QueryView>
      {output ? <pre className="sm-pre">{output}</pre> : null}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="New Compose project"
        size="lg"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={a.busy === 'create'} disabled={!name || !yaml} onClick={() => void a.run('create', async () => setOutput((await api.post<{ output: string }>('/compose', { name, yaml })).output), 'Project started').then((ok) => { if (ok) { setOpen(false); void q.refresh(); } })}>
              Create and start
            </Button>
          </>
        }
      >
        <Stack gap={3}>
          <Input label="Project name" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} description="Lowercase letters, digits, - and _." />
          <TextArea label="compose.yaml" value={yaml} onChange={(e) => setYaml(e.target.value)} rows={14} className="sm-mono" />
          {a.error ? <ErrorMessage error={a.error} /> : null}
        </Stack>
      </Dialog>
    </Stack>
  );
}

function DockerWidget() {
  const api = useModuleApi();
  const q = useQuery(() => api.get<any>('/status'), [api], { intervalMs: 15_000 });
  return (
    <QueryView query={q} skeletonLines={2}>
      {(s) =>
        s.available ? (
          <Stack gap={2}>
            <StatusIndicator tone="success">Docker {s.version}</StatusIndicator>
            <DescriptionList
              columns={3}
              items={[
                { term: 'Running', description: String(s.containers.running) },
                { term: 'Stopped', description: String(s.containers.stopped) },
                { term: 'Images', description: String(s.images) },
              ]}
            />
            <Button size="sm" variant="tertiary" onClick={() => navigate(modulePath('docker'))}>
              Open containers
            </Button>
          </Stack>
        ) : (
          <StatusIndicator tone="error">{s.error}</StatusIndicator>
        )
      }
    </QueryView>
  );
}

registerFrontend('docker', {
  routes: [...SECTIONS.map((s) => ({ path: s.value, component: DockerPage, permission: 'docker.read' })), { path: '/containers/:id', component: ContainerDetail, permission: 'docker.read' }],
  navigation: [{ id: 'docker', label: 'Docker', icon: 'shipping-status', order: 20, permission: 'docker.read', children: SECTIONS.map((s) => ({ id: `docker${s.value}`, label: s.label, path: s.value })) }],
  widgets: [{ id: 'status', title: 'Docker', component: DockerWidget, order: 20, permission: 'docker.read' }],
  commands: [
    { id: 'containers', label: 'Show containers', path: '/', permission: 'docker.read' },
    { id: 'pull', label: 'Pull an image', path: '/images', permission: 'docker.write' },
    { id: 'compose', label: 'New Compose project', path: '/compose', permission: 'docker.write' },
  ],
});
