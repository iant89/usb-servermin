import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  DescriptionList,
  Dialog,
  Flex,
  Input,
  MessageStrip,
  NumberInput,
  Page,
  PasswordInput,
  SearchField,
  Select,
  Stack,
  StatusIndicator,
  Tab,
  TabList,
  TabPanel,
  Table,
  Tabs,
  Text,
  CopyButton,
  useToast,
} from '@enterprise-ui/react';
import { ErrorMessage, Guard, QueryView, api, formatDate, formatRelative, navigate, usePermission, usePlatform, useLocation, useQuery } from '@servermin/client';
import { UsersPanel } from './Users';

export function SettingsPage() {
  const loc = useLocation();
  const tab = new URLSearchParams(loc.search).get('tab') ?? 'general';
  const canUsers = usePermission('users.manage');
  const canAudit = usePermission('audit.read');
  const canLogs = usePermission('platform.logs.read');
  const setTab = (t: string) => navigate(`/settings${t === 'general' ? '' : `?tab=${t}`}`, { replace: true });
  return (
    <Page title="Settings">
      <Tabs value={tab} onValueChange={setTab}>
        <TabList aria-label="Settings sections">
          <Tab value="general">General</Tab>
          <Tab value="account">Account</Tab>
          {canUsers ? <Tab value="users">Users</Tab> : null}
          {canAudit ? <Tab value="audit">Audit log</Tab> : null}
          {canLogs ? <Tab value="logs">Platform logs</Tab> : null}
          <Tab value="about">About</Tab>
        </TabList>
        <TabPanel value="general">
          <GeneralSettings />
        </TabPanel>
        <TabPanel value="account">
          <AccountSettings />
        </TabPanel>
        {canUsers ? (
          <TabPanel value="users">
            <UsersPanel />
          </TabPanel>
        ) : null}
        {canAudit ? (
          <TabPanel value="audit">
            <AuditLogPanel />
          </TabPanel>
        ) : null}
        {canLogs ? (
          <TabPanel value="logs">
            <PlatformLogs />
          </TabPanel>
        ) : null}
        <TabPanel value="about">
          <About />
        </TabPanel>
      </Tabs>
    </Page>
  );
}

interface ConfigResponse {
  settings: { serverName: string; logLevel: string };
  readOnly: { version: string; http: { host: string; port: number; tls: boolean }; paths: Record<string, string>; privilegedMode: string; dev: boolean; watch: boolean };
}

function GeneralSettings() {
  const q = useQuery(() => api.get<ConfigResponse>('/api/v1/config'), []);
  const canEdit = usePermission('platform.config');
  const toast = useToast();
  const [name, setName] = useState('');
  const [level, setLevel] = useState<string | null>('INFO');
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (q.data) {
      setName(q.data.settings.serverName);
      setLevel(q.data.settings.logLevel);
    }
  }, [q.data]);
  const save = async () => {
    try {
      await api.patch('/api/v1/config', { serverName: name, logLevel: level });
      toast.show({ title: 'Settings saved', description: 'Reload the page to see the new server name everywhere.', tone: 'success' });
      setError(null);
    } catch (e) {
      setError(e as Error);
    }
  };
  return (
    <QueryView query={q}>
      {(c) => (
        <Stack gap={4}>
          <Card title="Platform">
            <Stack gap={4} style={{ maxWidth: 520 }}>
              <Input label="Server name" description="Shown in the header and the browser tab." value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} />
              <Select label="Log level" value={level} onChange={setLevel} disabled={!canEdit} options={['DEBUG', 'INFO', 'WARN', 'ERROR'].map((l) => ({ value: l, label: l }))} />
              {error ? <ErrorMessage error={error} /> : null}
              {canEdit ? (
                <div>
                  <Button variant="primary" onClick={() => void save()}>
                    Save
                  </Button>
                </div>
              ) : null}
            </Stack>
          </Card>
          <Card title="Installation" subtitle="Set in /etc/servermin/config.json. Restart the service after changing it.">
            <DescriptionList
              columns={2}
              items={[
                { term: 'Listening on', description: `${c.readOnly.http.tls ? 'https' : 'http'}://${c.readOnly.http.host}:${c.readOnly.http.port}` },
                {
                  term: 'Privileged operations',
                  description: <StatusIndicator tone={c.readOnly.privilegedMode === 'sudo' ? 'success' : 'warning'}>{c.readOnly.privilegedMode === 'sudo' ? 'Through the privilege helper' : c.readOnly.privilegedMode}</StatusIndicator>,
                },
                ...Object.entries(c.readOnly.paths).map(([k, v]) => ({ id: k, term: `${k} directory`, description: <span className="sm-mono">{v}</span> })),
                { term: 'Development mode', description: c.readOnly.dev ? `On${c.readOnly.watch ? ', with module hot reload' : ''}` : 'Off' },
              ]}
            />
          </Card>
        </Stack>
      )}
    </QueryView>
  );
}

function AccountSettings() {
  const { user } = usePlatform();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const tokens = useQuery(() => api.get<{ id: number; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; expiresAt: string | null }[]>('/api/v1/auth/tokens'), []);
  const [tokenName, setTokenName] = useState('serverctl');
  const [days, setDays] = useState<number | null>(90);
  const [created, setCreated] = useState<string | null>(null);

  const change = async () => {
    try {
      await api.post('/api/v1/auth/password', { currentPassword: current, newPassword: next });
      toast.show({ title: 'Password changed', tone: 'success' });
      setCurrent('');
      setNext('');
      setError(null);
    } catch (e) {
      setError(e as Error);
    }
  };

  const createToken = async () => {
    const t = await api.post<{ token: string }>('/api/v1/auth/tokens', { name: tokenName, expiresInDays: days ?? undefined });
    setCreated(t.token);
    void tokens.refresh();
  };

  return (
    <Stack gap={4}>
      <Card title="Profile">
        <DescriptionList items={[{ term: 'Username', description: user.username }, { term: 'Display name', description: user.displayName }, { term: 'Permissions', description: user.permissions.join(', ') }]} columns={3} />
      </Card>
      <Card title="Change password">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void change();
          }}
        >
          <Stack gap={3} style={{ maxWidth: 420 }}>
            <PasswordInput label="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
            <PasswordInput label="New password" purpose="new" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
            {error ? <ErrorMessage error={error} title="Password not changed" /> : null}
            <div>
              <Button type="submit" variant="primary" disabled={!current || !next}>
                Change password
              </Button>
            </div>
          </Stack>
        </form>
      </Card>
      <Card title="API tokens" subtitle="For serverctl and automation. A token acts with your permissions.">
        <Stack gap={3}>
          <Flex gap={3} wrap align="flex-end">
            <Input label="Token name" value={tokenName} onChange={(e) => setTokenName(e.target.value)} />
            <NumberInput label="Expires after (days)" value={days} onChange={setDays} min={1} max={3650} />
            <Button onClick={() => void createToken()} disabled={!tokenName}>
              Create token
            </Button>
          </Flex>
          <QueryView query={tokens} empty={<Text tone="secondary">No API tokens.</Text>}>
            {(list) => (
              <Table
                caption="API tokens"
                data={list}
                density="compact"
                columns={[
                  { id: 'n', header: 'Name', rowHeader: true, accessor: 'name' },
                  { id: 'p', header: 'Prefix', cell: (t) => <span className="sm-mono">{t.prefix}…</span> },
                  { id: 'c', header: 'Created', cell: (t) => formatDate(t.createdAt) },
                  { id: 'u', header: 'Last used', cell: (t) => formatRelative(t.lastUsedAt) },
                  { id: 'e', header: 'Expires', cell: (t) => (t.expiresAt ? formatDate(t.expiresAt) : 'Never') },
                  {
                    id: 'x',
                    header: 'Actions',
                    align: 'end',
                    cell: (t) => (
                      <Button size="sm" variant="destructive" onClick={async () => (await api.delete(`/api/v1/auth/tokens/${t.id}`), void tokens.refresh())}>
                        Revoke
                      </Button>
                    ),
                  },
                ]}
              />
            )}
          </QueryView>
        </Stack>
      </Card>
      <Dialog open={!!created} onClose={() => setCreated(null)} title="Token created" size="sm" footer={<Button variant="primary" onClick={() => setCreated(null)}>Done</Button>}>
        <Stack gap={3}>
          <MessageStrip tone="warning">Copy the token now. It is not shown again.</MessageStrip>
          <Flex gap={2} align="center">
            <code className="sm-mono" style={{ wordBreak: 'break-all' }}>
              {created}
            </code>
            {created ? <CopyButton value={created} /> : null}
          </Flex>
          <Text size="sm">Use it with: <code>serverctl login --token &lt;token&gt;</code></Text>
        </Stack>
      </Dialog>
    </Stack>
  );
}

interface AuditRow {
  id: number;
  timestamp: string;
  user: string | null;
  action: string;
  module: string | null;
  target: string | null;
  result: string;
  ip: string | null;
  metadata?: Record<string, unknown>;
}

function AuditLogPanel() {
  const [search, setSearch] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const q = useQuery(() => api.get<AuditRow[]>('/api/v1/audit', { search, result: result ?? undefined, limit: 500 }), [search, result]);
  return (
    <Stack gap={3}>
      <Flex gap={3} wrap align="flex-end">
        <SearchField label="Search" value={search} onChange={setSearch} />
        <Select label="Result" value={result} onChange={setResult} placeholder="All" options={[{ value: 'success', label: 'Success' }, { value: 'failure', label: 'Failure' }]} />
        <Button icon="download" onClick={() => window.open(`/api/v1/audit?format=csv&limit=5000${search ? `&search=${encodeURIComponent(search)}` : ''}`, '_blank')}>
          Export CSV
        </Button>
      </Flex>
      <QueryView query={q} empty={<Text tone="secondary">No audit entries match.</Text>}>
        {(rows) => (
          <Table
            caption="Audit log"
            data={rows}
            density="compact"
            stickyHeader
            maxHeight={600}
            responsive="stack"
            columns={[
              { id: 't', header: 'Time', width: 180, cell: (r) => formatDate(r.timestamp) },
              { id: 'u', header: 'User', accessor: 'user' },
              { id: 'a', header: 'Action', cell: (r) => <span className="sm-mono">{r.action}</span> },
              { id: 'm', header: 'Module', accessor: 'module' },
              { id: 'g', header: 'Target', accessor: 'target', wrap: true },
              { id: 'r', header: 'Result', cell: (r) => <StatusIndicator tone={r.result === 'success' ? 'success' : 'error'} size="sm">{r.result}</StatusIndicator> },
              { id: 'd', header: 'Details', wrap: true, cell: (r) => (r.metadata ? <span className="sm-mono">{JSON.stringify(r.metadata).slice(0, 200)}</span> : '') },
            ]}
          />
        )}
      </QueryView>
    </Stack>
  );
}

function PlatformLogs() {
  const [level, setLevel] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const q = useQuery(() => api.get<any[]>('/api/v1/logs', { level: level ?? undefined, search, limit: 500 }), [level, search], { intervalMs: 10_000 });
  const tone = { DEBUG: 'neutral', INFO: 'information', WARN: 'warning', ERROR: 'error' } as const;
  return (
    <Stack gap={3}>
      <Flex gap={3} wrap align="flex-end">
        <Select label="Minimum level" value={level} onChange={setLevel} placeholder="All" options={['DEBUG', 'INFO', 'WARN', 'ERROR'].map((l) => ({ value: l, label: l }))} />
        <SearchField label="Search" value={search} onChange={setSearch} />
      </Flex>
      <QueryView query={q}>
        {(rows) => (
          <Table
            caption="Platform logs"
            data={rows}
            density="compact"
            stickyHeader
            maxHeight={600}
            columns={[
              { id: 't', header: 'Time', width: 180, cell: (r) => formatDate(r.timestamp) },
              { id: 'l', header: 'Level', width: 100, cell: (r) => <StatusIndicator tone={tone[r.level as keyof typeof tone]} size="sm">{r.level}</StatusIndicator> },
              { id: 's', header: 'Source', width: 110, cell: (r) => r.module ?? r.source },
              { id: 'm', header: 'Message', wrap: true, cell: (r) => <span className="sm-mono">{r.message}</span> },
            ]}
          />
        )}
      </QueryView>
    </Stack>
  );
}

function About() {
  const { coreVersion, modules, simulated } = usePlatform();
  return (
    <Stack gap={4}>
      <Card title="Server Control">
        <DescriptionList
          columns={2}
          items={[
            { term: 'Core version', description: coreVersion },
            { term: 'Installed modules', description: modules.map((m) => `${m.name} ${m.version}`).join(', ') || 'None' },
            { term: 'Host actions', description: simulated ? 'Simulated (development)' : 'Live' },
            { term: 'Architecture', description: 'A small core provides infrastructure; modules provide every feature and can be replaced, reloaded or removed independently.' },
          ]}
        />
      </Card>
      <Guard permission="modules.read">
        <Button onClick={() => navigate('/modules')}>Open the Module Manager</Button>
      </Guard>
    </Stack>
  );
}
