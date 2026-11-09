import { useEffect, useState } from 'react';
import { Badge, Button, Card, Checkbox, DescriptionList, Dialog, Flex, Input, MessageStrip, Page, RadioGroup, Stack, StatusIndicator, Table, Text, useToast } from '@enterprise-ui/react';
import { ApiRequestError, ErrorMessage, Guard, QueryView, formatBytes, registerFrontend, useModuleApi, useQuery } from '@servermin/client';

interface Iface {
  name: string;
  mac: string | null;
  state: string;
  mtu: number;
  type: string;
  addresses: { family: string; address: string; prefix: number; dynamic: boolean; scope: string }[];
  stats: { rxBytes: number; txBytes: number } | null;
  managed: { mode: string; addresses?: string[]; gateway?: string; dns?: string[] } | null;
  servesThisSession: boolean;
}

function PendingBanner({ pending, onDone }: { pending: { deadline: string; interfaces: string[] } | null; onDone: () => void }) {
  const api = useModuleApi();
  const [left, setLeft] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (!pending) return;
    const tick = () => setLeft(Math.max(0, Math.round((new Date(pending.deadline).getTime() - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [pending]);
  if (!pending) return null;
  const act = async (what: 'confirm' | 'rollback') => {
    try {
      await api.post(`/${what}`);
      onDone();
    } catch (e) {
      setError(e as Error);
    }
  };
  return (
    <MessageStrip
      tone="warning"
      title={`Network change on ${pending.interfaces.join(', ')} is waiting for confirmation`}
      announce="assertive"
      actions={
        <Guard permission="network.write">
          <Button size="sm" variant="primary" onClick={() => void act('confirm')}>
            Keep this configuration
          </Button>
          <Button size="sm" onClick={() => void act('rollback')}>
            Roll back now
          </Button>
        </Guard>
      }
    >
      If you can still reach this page, the new configuration works. It is reverted automatically in {left} seconds unless you keep it.
      {error ? <ErrorMessage error={error} /> : null}
    </MessageStrip>
  );
}

function NetworkPage() {
  const api = useModuleApi();
  const ifaces = useQuery(() => api.get<Iface[]>('/interfaces'), [api], { intervalMs: 10_000 });
  const routes = useQuery(() => api.get<any[]>('/routes'), [api]);
  const dns = useQuery(() => api.get<any>('/dns'), [api]);
  const status = useQuery(() => api.get<any>('/status'), [api], { intervalMs: 5000 });
  const [editing, setEditing] = useState<Iface | null>(null);
  const refresh = () => {
    void ifaces.refresh();
    void routes.refresh();
    void status.refresh();
  };
  return (
    <Page title="Network" subtitle="Interfaces are discovered on every start; names differ between machines.">
      <Stack gap={4}>
        <PendingBanner pending={status.data?.pending ?? null} onDone={refresh} />
        <Card title="Interfaces" noPadding>
          <QueryView query={ifaces}>
            {(list) => (
              <Table
                caption="Network interfaces"
                data={list}
                getRowId={(i) => i.name}
                responsive="stack"
                columns={[
                  {
                    id: 'n',
                    header: 'Interface',
                    rowHeader: true,
                    cell: (i) => (
                      <Flex gap={2} align="center" wrap>
                        <span className="sm-mono">{i.name}</span>
                        {i.servesThisSession ? <Badge tone="information">This connection</Badge> : null}
                        {i.managed ? <Badge>Managed</Badge> : null}
                      </Flex>
                    ),
                  },
                  { id: 't', header: 'Type', accessor: 'type' },
                  { id: 's', header: 'State', cell: (i) => <StatusIndicator tone={i.state === 'up' ? 'success' : i.state === 'down' ? 'neutral' : 'information'}>{i.state}</StatusIndicator> },
                  { id: 'a', header: 'Addresses', wrap: true, cell: (i) => i.addresses.filter((a) => a.scope !== 'link').map((a) => `${a.address}/${a.prefix}${a.dynamic ? ' (DHCP)' : ''}`).join(', ') },
                  { id: 'm', header: 'MAC', cell: (i) => <span className="sm-mono">{i.mac}</span> },
                  { id: 'x', header: 'Traffic', cell: (i) => (i.stats ? `↓ ${formatBytes(i.stats.rxBytes)} ↑ ${formatBytes(i.stats.txBytes)}` : '–') },
                  { id: 'e', header: 'Actions', align: 'end', cell: (i) => (i.type === 'ethernet' ? <Guard permission="network.write"><Button size="sm" onClick={() => setEditing(i)}>Configure</Button></Guard> : null) },
                ]}
              />
            )}
          </QueryView>
        </Card>
        <Flex gap={4} wrap align="stretch">
          <Card title="Routes" style={{ flex: '2 1 420px' }} noPadding>
            <QueryView query={routes}>
              {(list) => (
                <Table
                  caption="Routes"
                  data={list}
                  getRowId={(r, i) => `${r.destination}-${r.device}-${i}`}
                  density="compact"
                  columns={[
                    { id: 'd', header: 'Destination', cell: (r) => (r.destination === 'default' ? <strong>default</strong> : <span className="sm-mono">{r.destination}</span>) },
                    { id: 'g', header: 'Gateway', cell: (r) => <span className="sm-mono">{r.gateway ?? '–'}</span> },
                    { id: 'v', header: 'Device', accessor: 'device' },
                    { id: 'p', header: 'Protocol', accessor: 'protocol' },
                  ]}
                />
              )}
            </QueryView>
          </Card>
          <Card title="DNS" style={{ flex: '1 1 280px' }}>
            <QueryView query={dns}>
              {(d) => (
                <Stack gap={2}>
                  <Text size="sm" tone="secondary">
                    Source: {d.source}
                  </Text>
                  <DescriptionList columns={1} items={d.entries.filter((e: any) => e.servers.length).map((e: any, i: number) => ({ id: String(i), term: e.interface ?? 'Global', description: <span className="sm-mono">{e.servers.join(', ')}</span> }))} />
                </Stack>
              )}
            </QueryView>
          </Card>
        </Flex>
      </Stack>
      {editing ? <ConfigureDialog iface={editing} onClose={() => setEditing(null)} onApplied={() => { setEditing(null); refresh(); }} /> : null}
    </Page>
  );
}

function ConfigureDialog({ iface, onClose, onApplied }: { iface: Iface; onClose: () => void; onApplied: () => void }) {
  const api = useModuleApi();
  const toast = useToast();
  const v4 = iface.addresses.find((a) => a.family === 'ipv4' && a.scope === 'global');
  const [mode, setMode] = useState<'dhcp' | 'static'>((iface.managed?.mode as 'dhcp' | 'static') ?? (v4?.dynamic === false ? 'static' : 'dhcp'));
  const [addresses, setAddresses] = useState((iface.managed?.addresses ?? (v4 ? [`${v4.address}/${v4.prefix}`] : [])).join(', '));
  const [gateway, setGateway] = useState(iface.managed?.gateway ?? '');
  const [dns, setDns] = useState((iface.managed?.dns ?? []).join(', '));
  const [risk, setRisk] = useState(false);
  const [needsRisk, setNeedsRisk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const split = (s: string) => s.split(/[\s,]+/).filter(Boolean);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.put<{ newAddress: string | null }>(`/interfaces/${iface.name}`, { mode, addresses: split(addresses), gateway: gateway || undefined, dns: split(dns), acknowledgeRisk: risk });
      toast.show({ title: 'Configuration applied', description: 'Confirm it within the time shown, or it is rolled back.', tone: 'warning' });
      if (iface.servesThisSession && r.newAddress && r.newAddress !== location.hostname) {
        toast.show({ title: `Reconnect at http://${r.newAddress}${location.port ? ':' + location.port : ''}/ to confirm`, tone: 'information', duration: 0 });
      }
      onApplied();
    } catch (e) {
      if (e instanceof ApiRequestError && e.reason === 'connection-at-risk') setNeedsRisk(true);
      setError(e as Error);
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Configure ${iface.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={needsRisk && !risk} onClick={() => void submit()}>
            Apply with automatic rollback
          </Button>
        </>
      }
    >
      <Stack gap={3}>
        {iface.servesThisSession ? <MessageStrip tone="warning">You are connected through this interface.</MessageStrip> : null}
        <RadioGroup
          label="IPv4 configuration"
          value={mode}
          onChange={(v) => setMode(v as 'dhcp' | 'static')}
          options={[
            { value: 'dhcp', label: 'Automatic (DHCP)' },
            { value: 'static', label: 'Static' },
          ]}
        />
        {mode === 'static' ? (
          <>
            <Input label="Addresses" description="With prefix, comma-separated, e.g. 192.168.1.10/24" value={addresses} onChange={(e) => setAddresses(e.target.value)} className="sm-mono" required />
            <Input label="Gateway" value={gateway} onChange={(e) => setGateway(e.target.value)} className="sm-mono" />
          </>
        ) : null}
        <Input label="DNS servers" description="Optional, comma-separated" value={dns} onChange={(e) => setDns(e.target.value)} className="sm-mono" />
        {error ? <ErrorMessage error={error} title="Not applied" /> : null}
        {needsRisk ? <Checkbox label="I understand this page may lose its connection" checked={risk} onChange={setRisk} /> : null}
        <Text size="sm" tone="secondary">
          The change is written to /etc/netplan/90-servermin.yaml and applied. If it is not confirmed in time, the previous configuration is restored automatically, even if this server becomes unreachable.
        </Text>
      </Stack>
    </Dialog>
  );
}

function NetworkWidget() {
  const api = useModuleApi();
  const q = useQuery(() => api.get<any>('/status'), [api], { intervalMs: 15_000 });
  return (
    <QueryView query={q} skeletonLines={3}>
      {(s) => (
        <Stack gap={2}>
          {s.pending ? <StatusIndicator tone="warning">Change waiting for confirmation</StatusIndicator> : null}
          {s.up.map((i: any) => (
            <Text key={i.name} size="sm">
              <strong>{i.name}</strong> {i.addresses.join(', ') || 'no address'}
            </Text>
          ))}
          <Text size="sm" tone="secondary">
            Gateway: {s.gateway ? `${s.gateway.gateway} via ${s.gateway.device}` : 'none'}
          </Text>
        </Stack>
      )}
    </QueryView>
  );
}

function PendingIndicator() {
  const api = useModuleApi();
  const q = useQuery(() => api.get<any>('/pending'), [api], { intervalMs: 5000 });
  return q.data ? <StatusIndicator tone="warning" size="sm" indicator="dot">Network change pending</StatusIndicator> : null;
}

registerFrontend('network', {
  routes: [{ path: '/', component: NetworkPage, permission: 'network.read' }],
  navigation: [{ id: 'network', label: 'Network', icon: 'connected', order: 40, permission: 'network.read' }],
  widgets: [{ id: 'status', title: 'Network', component: NetworkWidget, order: 40, permission: 'network.read' }],
  statusIndicators: [{ id: 'pending', component: PendingIndicator, permission: 'network.read' }],
  commands: [{ id: 'interfaces', label: 'Network interfaces', path: '/', permission: 'network.read', keywords: ['ip', 'dns', 'gateway'] }],
});
