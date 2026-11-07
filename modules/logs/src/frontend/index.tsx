import { useState } from 'react';
import { Button, ComboBox, Flex, Page, SearchField, Select, Stack, StatusIndicator, Switch, Tab, TabList, TabPanel, Tabs, Table, Text } from '@enterprise-ui/react';
import { Guard, QueryView, api as coreApi, formatDate, registerFrontend, useChannel, useModuleApi, usePermission, useQuery } from '@servermin/client';

interface Line {
  time: string;
  priority: string;
  source: string;
  pid: number | null;
  message: string;
}

const TONE: Record<string, 'error' | 'warning' | 'information' | 'neutral'> = { emerg: 'error', alert: 'error', crit: 'error', err: 'error', ERROR: 'error', warning: 'warning', WARN: 'warning', notice: 'information', INFO: 'information', info: 'neutral', debug: 'neutral', DEBUG: 'neutral' };
const PRIORITY_OPTIONS = [
  { value: '3', label: 'Errors and worse' },
  { value: '4', label: 'Warnings and worse' },
  { value: '5', label: 'Notices and worse' },
  { value: '6', label: 'Info and worse' },
];

function LogTable({ rows, caption }: { rows: Line[]; caption: string }) {
  return (
    <Table
      caption={caption}
      data={rows}
      getRowId={(r, i) => `${r.time}-${i}`}
      density="compact"
      stickyHeader
      maxHeight={620}
      responsive="stack"
      emptyState={<Text tone="secondary">No entries match.</Text>}
      columns={[
        { id: 't', header: 'Time', width: 180, cell: (r) => formatDate(r.time) },
        { id: 'p', header: 'Severity', width: 110, cell: (r) => <StatusIndicator size="sm" tone={TONE[r.priority] ?? 'neutral'}>{r.priority}</StatusIndicator> },
        { id: 's', header: 'Source', width: 200, cell: (r) => <span className="sm-mono">{r.source}{r.pid ? `[${r.pid}]` : ''}</span> },
        { id: 'm', header: 'Message', wrap: true, cell: (r) => <span className="sm-mono">{r.message}</span> },
      ]}
    />
  );
}

function Journal() {
  const api = useModuleApi();
  const units = useQuery(() => api.get<string[]>('/units'), [api]);
  const [unit, setUnit] = useState<string | null>(null);
  const [priority, setPriority] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [since, setSince] = useState<string | null>('-1h');
  const [live, setLive] = useState(false);
  const params = { unit: unit ?? '', priority: priority ?? '', search, since: since ?? '', lines: 1000 };
  const q = useQuery(() => api.get<Line[]>('/journal', params), [api, unit, priority, search, since], { enabled: !live });
  const [liveRows, setLiveRows] = useState<Line[]>([]);
  useChannel<Line[]>(live ? 'logs.stream' : null, { unit: unit ?? undefined, priority: priority ?? undefined }, (entries) => setLiveRows((prev) => [...entries.reverse(), ...prev].slice(0, 2000)));
  const exportUrl = (format: string) => api.url('/export', Object.fromEntries(Object.entries({ ...params, format }).filter(([, v]) => v !== '' && v !== undefined).map(([k, v]) => [k, String(v)])));
  return (
    <Stack gap={3}>
      <Flex gap={3} wrap align="flex-end">
        <ComboBox label="Unit" value={unit} onChange={setUnit} placeholder="All units" options={(units.data ?? []).map((u) => ({ value: u, label: u }))} />
        <Select label="Severity" value={priority} onChange={setPriority} placeholder="All" options={PRIORITY_OPTIONS} />
        <Select
          label="Time range"
          value={since}
          onChange={setSince}
          disabled={live}
          options={[
            { value: '-15m', label: 'Last 15 minutes' },
            { value: '-1h', label: 'Last hour' },
            { value: '-24h', label: 'Last 24 hours' },
            { value: '-7d', label: 'Last 7 days' },
          ]}
        />
        <SearchField label="Search" value={search} onChange={setSearch} disabled={live} />
        <Switch label="Live" checked={live} onChange={(v) => { setLiveRows([]); setLive(v); }} />
        <Button icon="download" onClick={() => window.open(exportUrl('text'), '_blank')}>
          Export
        </Button>
      </Flex>
      {live ? (
        <LogTable rows={liveRows} caption="Live journal" />
      ) : (
        <QueryView query={q}>{(rows) => <LogTable rows={[...rows].reverse()} caption="System journal" />}</QueryView>
      )}
    </Stack>
  );
}

function Containers() {
  const api = useModuleApi();
  const list = useQuery(() => api.get<any[]>('/containers'), [api]);
  const [id, setId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const q = useQuery(() => api.get<Line[]>(`/docker/${id}`, { lines: 1000, search }), [api, id, search], { enabled: !!id });
  if (list.data && !list.data.length) return <Text tone="secondary">No containers, or the Docker module is not active.</Text>;
  return (
    <Stack gap={3}>
      <Flex gap={3} wrap align="flex-end">
        <Select label="Container" value={id} onChange={setId} placeholder="Choose a container" options={(list.data ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.state})` }))} />
        <SearchField label="Search" value={search} onChange={setSearch} />
        {id ? (
          <Button icon="download" onClick={() => window.open(api.url('/export', { container: id, ...(search ? { search } : {}) }), '_blank')}>
            Export
          </Button>
        ) : null}
      </Flex>
      {id ? <QueryView query={q}>{(rows) => <LogTable rows={[...rows].reverse()} caption="Container logs" />}</QueryView> : null}
    </Stack>
  );
}

function PlatformLogs() {
  const [module, setModule] = useState<string | null>(null);
  const [level, setLevel] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const q = useQuery(() => coreApi.get<any[]>('/api/v1/logs', { module: module ?? undefined, level: level ?? undefined, search, limit: 1000 }), [module, level, search], { intervalMs: 10_000 });
  const modules = [...new Set((q.data ?? []).map((r) => r.module).filter(Boolean))] as string[];
  return (
    <Stack gap={3}>
      <Flex gap={3} wrap align="flex-end">
        <Select label="Module" value={module} onChange={setModule} placeholder="Core and all modules" options={modules.map((m) => ({ value: m, label: m }))} />
        <Select label="Level" value={level} onChange={setLevel} placeholder="All" options={['DEBUG', 'INFO', 'WARN', 'ERROR'].map((l) => ({ value: l, label: `${l} and above` }))} />
        <SearchField label="Search" value={search} onChange={setSearch} />
      </Flex>
      <QueryView query={q}>{(rows) => <LogTable rows={rows.map((r) => ({ time: r.timestamp, priority: r.level, source: r.module ?? r.source, pid: null, message: r.message }))} caption="Platform logs" />}</QueryView>
    </Stack>
  );
}

function LogsPage() {
  const [tab, setTab] = useState('journal');
  const canPlatform = usePermission('platform.logs.read');
  return (
    <Page title="Logs" subtitle="System, service, application, container and module logs.">
      <Tabs value={tab} onValueChange={setTab}>
        <TabList aria-label="Log sources">
          <Tab value="journal">System and services</Tab>
          <Tab value="containers">Containers and applications</Tab>
          {canPlatform ? <Tab value="platform">Platform and modules</Tab> : null}
        </TabList>
        <TabPanel value="journal">
          <Journal />
        </TabPanel>
        <TabPanel value="containers">
          <Containers />
        </TabPanel>
        <Guard permission="platform.logs.read">
          <TabPanel value="platform">
            <PlatformLogs />
          </TabPanel>
        </Guard>
      </Tabs>
    </Page>
  );
}

registerFrontend('logs', {
  routes: [{ path: '/', component: LogsPage, permission: 'logs.read' }],
  navigation: [{ id: 'logs', label: 'Logs', icon: 'document-text', order: 70, permission: 'logs.read' }],
  commands: [{ id: 'search', label: 'Search logs', path: '/', permission: 'logs.read', keywords: ['journal', 'journalctl'] }],
});
