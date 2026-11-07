import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  DescriptionList,
  Flex,
  Grid,
  Input,
  MessageStrip,
  Page,
  ProgressBar,
  SearchField,
  SegmentedButton,
  Select,
  Stack,
  StatusIndicator,
  Switch,
  Tab,
  TabList,
  Tabs,
  Table,
  Text,
  useToast,
} from '@enterprise-ui/react';
import {
  ErrorMessage,
  Guard,
  QueryView,
  formatBytes,
  formatDate,
  formatDuration,
  modulePath,
  navigate,
  registerFrontend,
  useChannel,
  useConfirm,
  useModuleApi,
  useQuery,
  type ModuleRouteProps,
} from '@servermin/client';

interface Metrics {
  cpuPercent: number | null;
  memory: { total: number; used: number; available: number; swapTotal: number; swapUsed: number };
  load: number[];
  uptimeSeconds: number;
}

const TABS = [
  { value: '/', label: 'Overview' },
  { value: '/processes', label: 'Processes' },
  { value: '/updates', label: 'Updates' },
  { value: '/time', label: 'Name and time' },
  { value: '/power', label: 'Power' },
];

function SystemPage({ path }: ModuleRouteProps) {
  const tab = TABS.some((t) => t.value === path) ? path : '/';
  return (
    <Page title="System" subtitle="Operating system, hardware and administration of this server.">
      <Tabs value={tab} onValueChange={(v) => navigate(modulePath('system', v), { replace: true })}>
        <TabList aria-label="System sections">
          {TABS.map((t) => (
            <Tab key={t.value} value={t.value}>
              {t.label}
            </Tab>
          ))}
        </TabList>
      </Tabs>
      <div style={{ paddingTop: 16 }}>
        {tab === '/' ? <Overview /> : tab === '/processes' ? <Processes /> : tab === '/updates' ? <Updates /> : tab === '/time' ? <NameAndTime /> : <Power />}
      </div>
    </Page>
  );
}

function LiveMetrics() {
  const [m, setM] = useState<Metrics | null>(null);
  const ch = useChannel<Metrics>('system.metrics', {}, setM);
  if (ch.status === 'error') return <MessageStrip tone="warning">Live metrics unavailable: {ch.error}</MessageStrip>;
  const mem = m ? (m.memory.used / m.memory.total) * 100 : 0;
  return (
    <Grid columns={{ base: 1, sm: 2 }} gap={4}>
      <ProgressBar label="CPU" value={m?.cpuPercent ?? 0} tone={(m?.cpuPercent ?? 0) > 85 ? 'error' : 'information'} />
      <ProgressBar label={`Memory · ${m ? `${formatBytes(m.memory.used)} of ${formatBytes(m.memory.total)}` : '…'}`} value={mem} tone={mem > 90 ? 'error' : mem > 75 ? 'warning' : 'information'} />
      <Text>Load average: {m ? m.load.map((l) => l.toFixed(2)).join(' · ') : '…'}</Text>
      <Text>Uptime: {m ? formatDuration(m.uptimeSeconds) : '…'}</Text>
    </Grid>
  );
}

function Overview() {
  const api = useModuleApi();
  const q = useQuery(() => api.get('/info'), [api]);
  return (
    <Stack gap={4}>
      <Card title="Live">
        <LiveMetrics />
      </Card>
      <QueryView query={q}>
        {(i: any) => (
          <Stack gap={4}>
            <Card title="Operating system">
              <DescriptionList
                columns={3}
                items={[
                  { term: 'Hostname', description: i.hostname },
                  { term: 'Distribution', description: i.os.name },
                  { term: 'Kernel', description: i.kernel },
                  { term: 'Architecture', description: i.arch },
                  { term: 'Booted', description: formatDate(i.bootedAt) },
                  { term: 'Time zone', description: i.time.timezone },
                ]}
              />
            </Card>
            <Card title="Hardware" subtitle="Detected at runtime. The installation can move between machines.">
              <DescriptionList
                columns={3}
                items={[
                  { term: 'Processor', description: i.cpu.model },
                  { term: 'Cores / threads', description: `${i.cpu.cores} / ${i.cpu.threads}` },
                  { term: 'Virtualised', description: i.cpu.virtualized ? 'Yes' : 'No' },
                  { term: 'Memory', description: formatBytes(i.memory.total) },
                  { term: 'Swap', description: formatBytes(i.memory.swapTotal) },
                  { term: 'Graphics', description: i.gpus.length ? i.gpus.map((g: any) => `${g.vendor} ${g.device}`).join('; ') : 'None detected' },
                  { term: 'Vendor', description: i.hardware.sys_vendor },
                  { term: 'Product', description: [i.hardware.product_name, i.hardware.product_version].filter(Boolean).join(' ') },
                  { term: 'Board', description: [i.hardware.board_vendor, i.hardware.board_name].filter(Boolean).join(' ') },
                  { term: 'BIOS', description: [i.hardware.bios_vendor, i.hardware.bios_version].filter(Boolean).join(' ') },
                  { term: 'Machine ID', description: <span className="sm-mono">{i.hardware.machineId}</span>, span: 2 },
                ]}
              />
            </Card>
            <Card title="Network interfaces" noPadding>
              <Table
                caption="Network interfaces"
                data={i.network}
                getRowId={(n: any) => n.name}
                density="compact"
                columns={[
                  { id: 'n', header: 'Interface', rowHeader: true, accessor: 'name' },
                  { id: 'm', header: 'MAC', cell: (n: any) => <span className="sm-mono">{n.mac}</span> },
                  { id: 'a', header: 'Addresses', wrap: true, cell: (n: any) => n.addresses.join(', ') },
                ]}
              />
            </Card>
          </Stack>
        )}
      </QueryView>
    </Stack>
  );
}

function Processes() {
  const api = useModuleApi();
  const [sort, setSort] = useState('cpu');
  const [search, setSearch] = useState('');
  const q = useQuery(() => api.get<{ total: number; processes: any[] }>('/processes', { sort, search, limit: 200 }), [api, sort, search], { intervalMs: 3000 });
  return (
    <Stack gap={3}>
      <Flex gap={3} wrap align="flex-end">
        <SearchField label="Filter" value={search} onChange={setSearch} placeholder="Command, user or PID" />
        <SegmentedButton
          aria-label="Sort by"
          selectionMode="single"
          value={[sort]}
          onChange={(v) => v[0] && setSort(v[0])}
          items={[
            { value: 'cpu', label: 'CPU' },
            { value: 'memory', label: 'Memory' },
          ]}
        />
      </Flex>
      <QueryView query={q}>
        {(d) => (
          <Table
            caption={`${d.total} processes`}
            hideCaption={false}
            data={d.processes}
            getRowId={(p) => String(p.pid)}
            density="compact"
            stickyHeader
            maxHeight={560}
            responsive="stack"
            columns={[
              { id: 'pid', header: 'PID', width: 80, accessor: 'pid', align: 'end' },
              { id: 'user', header: 'User', width: 110, accessor: 'user' },
              { id: 'cpu', header: 'CPU', width: 80, align: 'end', cell: (p) => `${p.cpuPercent.toFixed(1)} %` },
              { id: 'mem', header: 'Memory', width: 100, align: 'end', cell: (p) => formatBytes(p.rssBytes) },
              { id: 'state', header: 'State', width: 70, accessor: 'state' },
              { id: 'cmd', header: 'Command', cell: (p) => <span className="sm-mono" title={p.command}>{p.command.slice(0, 160)}</span> },
            ]}
          />
        )}
      </QueryView>
    </Stack>
  );
}

function Updates() {
  const api = useModuleApi();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const q = useQuery(() => api.get<{ supported: boolean; packages: any[]; security: number; rebootRequired: boolean }>('/updates'), [api]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const run = async (what: 'refresh' | 'upgrade') => {
    if (what === 'upgrade' && !(await confirm({ title: 'Install updates?', message: `Install ${q.data?.packages.length ?? 0} package upgrades now. Services may restart.`, confirmLabel: 'Install updates' }))) return;
    setBusy(what);
    setError(null);
    try {
      await api.post(`/updates/${what}`, what === 'upgrade' ? { confirm: true } : {});
      toast.show({ title: what === 'refresh' ? 'Package index refreshed' : 'Updates installed', tone: 'success' });
      await q.refresh();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Stack gap={3}>
      {dialog}
      <Guard permission="system.update">
        <Flex gap={2}>
          <Button icon="refresh" loading={busy === 'refresh'} onClick={() => void run('refresh')}>
            Check for updates
          </Button>
          <Button variant="primary" loading={busy === 'upgrade'} disabled={!q.data?.packages.length} onClick={() => void run('upgrade')}>
            Install all updates
          </Button>
        </Flex>
      </Guard>
      {error ? <ErrorMessage error={error} /> : null}
      <QueryView query={q}>
        {(d) =>
          !d.supported ? (
            <MessageStrip tone="information">This system does not use apt.</MessageStrip>
          ) : (
            <Stack gap={3}>
              {d.rebootRequired ? <MessageStrip tone="warning">A reboot is required to finish installing updates.</MessageStrip> : null}
              <Text>
                {d.packages.length ? `${d.packages.length} upgrades available, ${d.security} security updates.` : 'The system is up to date.'}
              </Text>
              {d.packages.length ? (
                <Table
                  caption="Available upgrades"
                  data={d.packages}
                  getRowId={(p) => p.name}
                  density="compact"
                  columns={[
                    { id: 'n', header: 'Package', rowHeader: true, accessor: 'name', sortable: true },
                    { id: 'f', header: 'Installed', cell: (p) => <span className="sm-mono">{p.from}</span> },
                    { id: 'v', header: 'Available', cell: (p) => <span className="sm-mono">{p.version}</span> },
                    { id: 's', header: 'Source', cell: (p) => (p.security ? <StatusIndicator tone="warning" size="sm">{p.suite}</StatusIndicator> : p.suite) },
                  ]}
                />
              ) : null}
            </Stack>
          )
        }
      </QueryView>
    </Stack>
  );
}

function NameAndTime() {
  const api = useModuleApi();
  const toast = useToast();
  const info = useQuery(() => api.get('/info'), [api]);
  const zones = useQuery(() => api.get<string[]>('/timezones'), [api]);
  const [hostname, setHostname] = useState('');
  const [tz, setTz] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (info.data) {
      setHostname((info.data as any).hostname);
      setTz((info.data as any).time.timezone);
    }
  }, [info.data]);
  const save = async (fn: () => Promise<unknown>, message: string) => {
    try {
      await fn();
      setError(null);
      toast.show({ title: message, tone: 'success' });
      void info.refresh();
    } catch (e) {
      setError(e as Error);
    }
  };
  const t = (info.data as any)?.time;
  return (
    <Stack gap={4} style={{ maxWidth: 560 }}>
      {error ? <ErrorMessage error={error} /> : null}
      <Card title="Hostname">
        <Stack gap={3}>
          <Input label="Hostname" value={hostname} onChange={(e) => setHostname(e.target.value)} />
          <Guard permission="system.write">
            <div>
              <Button onClick={() => void save(() => api.put('/hostname', { hostname }), 'Hostname changed')}>Save hostname</Button>
            </div>
          </Guard>
        </Stack>
      </Card>
      <Card title="Time">
        <Stack gap={3}>
          <Text>Server time: {t ? formatDate(t.now) : '…'}</Text>
          <Select label="Time zone" value={tz} onChange={setTz} options={(zones.data ?? []).map((z) => ({ value: z, label: z }))} />
          <Guard permission="system.write">
            <div>
              <Button onClick={() => void save(() => api.put('/timezone', { timezone: tz }), 'Time zone changed')} disabled={!tz}>
                Save time zone
              </Button>
            </div>
            {t?.ntp !== null && t !== undefined ? (
              <Switch
                label="Synchronise time over the network (NTP)"
                description={t.synchronized ? 'The clock is synchronised.' : 'The clock is not synchronised yet.'}
                checked={!!t.ntp}
                onChange={(enabled) => void save(() => api.put('/ntp', { enabled }), enabled ? 'NTP enabled' : 'NTP disabled')}
              />
            ) : null}
          </Guard>
        </Stack>
      </Card>
    </Stack>
  );
}

function Power() {
  const api = useModuleApi();
  const { confirm, dialog } = useConfirm();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const act = async (action: 'reboot' | 'shutdown') => {
    const ok = await confirm({
      title: action === 'reboot' ? 'Reboot the server?' : 'Shut down the server?',
      message: action === 'reboot' ? 'All services and connections stop while the server restarts.' : 'The server powers off. Someone must switch it on again at the machine.',
      confirmLabel: action === 'reboot' ? 'Reboot' : 'Shut down',
      tone: 'error',
      acknowledge: 'I understand that this interrupts every service on this server',
    });
    if (!ok) return;
    try {
      setMessage((await api.post<{ message: string }>(`/power/${action}`, { confirm: true })).message);
    } catch (e) {
      setError(e as Error);
    }
  };
  return (
    <Stack gap={4} style={{ maxWidth: 560 }}>
      {dialog}
      {message ? <MessageStrip tone="warning" announce="assertive">{message}</MessageStrip> : null}
      {error ? <ErrorMessage error={error} /> : null}
      <Guard permission="system.power" fallback={<Text tone="secondary">You need the system.power permission.</Text>}>
        <Card title="Power">
          <Flex gap={3} wrap>
            <Button variant="destructive" icon="restart" onClick={() => void act('reboot')}>
              Reboot
            </Button>
            <Button variant="destructive" icon="sys-cancel" onClick={() => void act('shutdown')}>
              Shut down
            </Button>
          </Flex>
        </Card>
      </Guard>
    </Stack>
  );
}

function SystemWidget() {
  const api = useModuleApi();
  const q = useQuery(() => api.get<any>('/info'), [api]);
  return (
    <QueryView query={q} skeletonLines={3}>
      {(i) => (
        <DescriptionList
          columns={1}
          layout="inline"
          items={[
            { term: 'Host', description: i.hostname },
            { term: 'OS', description: i.os.name },
            { term: 'Kernel', description: i.kernel },
            { term: 'CPU', description: `${i.cpu.cores} cores · ${i.cpu.model}` },
          ]}
        />
      )}
    </QueryView>
  );
}

registerFrontend('system', {
  routes: TABS.map((t) => ({ path: t.value, component: SystemPage, permission: 'system.read' })),
  navigation: [
    {
      id: 'system',
      label: 'System',
      icon: 'it-host',
      order: 10,
      permission: 'system.read',
      children: TABS.map((t) => ({ id: `system${t.value}`, label: t.label, path: t.value })),
    },
  ],
  widgets: [{ id: 'summary', title: 'System', component: SystemWidget, span: 2, order: 10, permission: 'system.read' }],
  commands: [
    { id: 'processes', label: 'Show processes', path: '/processes', permission: 'system.read', keywords: ['top', 'ps'] },
    { id: 'updates', label: 'Check for updates', path: '/updates', permission: 'system.read', keywords: ['apt', 'upgrade'] },
    { id: 'reboot', label: 'Reboot server…', path: '/power', permission: 'system.power' },
  ],
});
