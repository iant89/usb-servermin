import { useState } from 'react';
import { Badge, Button, Card, Checkbox, Dialog, Flex, Input, MessageStrip, Page, ProgressBar, Select, Stack, StatusIndicator, Table, Text, TreeTable, useToast } from '@enterprise-ui/react';
import { ErrorMessage, Guard, QueryView, formatBytes, registerFrontend, useConfirm, useModuleApi, useQuery } from '@servermin/client';

interface Disk {
  name: string;
  path: string;
  type: string;
  size: number;
  fstype: string | null;
  label: string | null;
  mountpoints: string[];
  model: string | null;
  transport: string | null;
  removable: boolean;
  rotational: boolean;
  system?: boolean;
  fsSize: number | null;
  fsUsed: number | null;
  children: Disk[];
}

const usageTone = (p: number | null) => ((p ?? 0) >= 90 ? 'error' : (p ?? 0) >= 75 ? 'warning' : 'information');

function StoragePage() {
  const api = useModuleApi();
  const disks = useQuery(() => api.get<Disk[]>('/disks'), [api], { intervalMs: 15_000 });
  const mounts = useQuery(() => api.get<any[]>('/mounts'), [api], { intervalMs: 15_000 });
  const [mountOpen, setMountOpen] = useState(false);
  const [smart, setSmart] = useState<{ device: string; data?: any; error?: Error } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const toast = useToast();
  const { confirm, dialog } = useConfirm();

  const unmount = async (target: string) => {
    if (!(await confirm({ title: `Unmount ${target}?`, message: 'Programs using files on it lose access. Make sure nothing is writing to it.', confirmLabel: 'Unmount', tone: 'warning' }))) return;
    try {
      await api.post('/unmount', { target, confirm: true });
      toast.show({ title: `${target} unmounted`, tone: 'success' });
      void mounts.refresh();
      void disks.refresh();
    } catch (e) {
      setError(e as Error);
    }
  };

  const health = async (d: Disk) => {
    setSmart({ device: d.path });
    try {
      setSmart({ device: d.path, data: await api.get(`/health/${d.name}`) });
    } catch (e) {
      setSmart({ device: d.path, error: e as Error });
    }
  };

  return (
    <Page
      title="Storage"
      subtitle="Disks are detected at runtime; names can change when the installation moves to another machine."
      actions={
        <Guard permission="storage.write">
          <Button variant="primary" icon="add" onClick={() => setMountOpen(true)}>
            Mount file system
          </Button>
        </Guard>
      }
    >
      {dialog}
      <Stack gap={4}>
        {error ? <ErrorMessage error={error} /> : null}
        <Card title="Disks and partitions" noPadding>
          <QueryView query={disks}>
            {(list) => (
              <TreeTable
                aria-label="Disks and partitions"
                data={list}
                getRowId={(d: Disk) => d.path}
                getChildren={(d: Disk) => (d.children.length ? d.children : undefined)}
                defaultExpandedIds={list.map((d) => d.path)}
                columns={[
                  {
                    id: 'name',
                    header: 'Device',
                    cell: (d: Disk) => (
                      <Flex gap={2} align="center" wrap>
                        <span className="sm-mono">{d.path}</span>
                        {d.system ? <Badge tone="information">System disk</Badge> : null}
                        {d.transport === 'usb' || d.removable ? <Badge>Removable</Badge> : null}
                      </Flex>
                    ),
                  },
                  { id: 'type', header: 'Type', cell: (d: Disk) => (d.type === 'disk' ? [d.model, d.transport?.toUpperCase(), d.rotational ? 'HDD' : 'SSD'].filter(Boolean).join(' · ') : d.type) },
                  { id: 'size', header: 'Size', align: 'end', cell: (d: Disk) => formatBytes(d.size) },
                  { id: 'fs', header: 'File system', cell: (d: Disk) => [d.fstype, d.label].filter(Boolean).join(' · ') },
                  { id: 'mount', header: 'Mounted at', cell: (d: Disk) => <span className="sm-mono">{d.mountpoints.join(', ')}</span> },
                  { id: 'actions', header: 'Health', align: 'end', cell: (d: Disk) => (d.type === 'disk' ? <Button size="sm" variant="tertiary" onClick={() => void health(d)}>Check health</Button> : null) },
                ]}
              />
            )}
          </QueryView>
        </Card>
        <Card title="Mounted file systems" noPadding>
          <QueryView query={mounts}>
            {(list) => (
              <Table
                caption="Mounted file systems"
                data={list}
                getRowId={(m) => m.target}
                responsive="stack"
                columns={[
                  { id: 't', header: 'Mount point', rowHeader: true, cell: (m) => <span className="sm-mono">{m.target}</span> },
                  { id: 's', header: 'Source', cell: (m) => <span className="sm-mono">{m.source}</span> },
                  { id: 'f', header: 'Type', accessor: 'fstype' },
                  { id: 'u', header: 'Usage', minWidth: 200, cell: (m) => (m.size ? <ProgressBar value={m.usePercent ?? 0} tone={usageTone(m.usePercent)} label={`${formatBytes(m.used)} of ${formatBytes(m.size)}`} size="sm" /> : '–') },
                  { id: 'o', header: 'Options', cell: (m) => (m.options.split(',').includes('ro') ? <Badge>read-only</Badge> : null) },
                  {
                    id: 'a',
                    header: 'Actions',
                    align: 'end',
                    cell: (m) => (m.protected ? <Text size="sm" tone="secondary">System</Text> : <Guard permission="storage.write"><Button size="sm" onClick={() => void unmount(m.target)}>Unmount</Button></Guard>),
                  },
                ]}
              />
            )}
          </QueryView>
        </Card>
      </Stack>
      {mountOpen ? <MountDialog onClose={() => setMountOpen(false)} onDone={() => { setMountOpen(false); void mounts.refresh(); void disks.refresh(); }} /> : null}
      <Dialog open={!!smart} onClose={() => setSmart(null)} title={`Disk health · ${smart?.device ?? ''}`} size="sm" footer={<Button onClick={() => setSmart(null)}>Close</Button>}>
        {smart?.error ? (
          <ErrorMessage error={smart.error} />
        ) : !smart?.data ? (
          <Text>Reading S.M.A.R.T. data…</Text>
        ) : !smart.data.supported ? (
          <MessageStrip tone="information">{smart.data.message}</MessageStrip>
        ) : (
          <Stack gap={2}>
            <StatusIndicator tone={smart.data.passed ? 'success' : 'error'}>{smart.data.passed ? 'Self-assessment passed' : 'Self-assessment FAILED'}</StatusIndicator>
            {smart.data.temperature !== null ? <Text>Temperature: {smart.data.temperature} °C</Text> : null}
            {smart.data.powerOnHours !== null ? <Text>Power-on hours: {smart.data.powerOnHours}</Text> : null}
            {smart.data.reallocatedSectors !== null ? <Text>Reallocated sectors: {smart.data.reallocatedSectors}</Text> : null}
            {smart.data.nvmePercentageUsed !== null ? <Text>Wear: {smart.data.nvmePercentageUsed} %</Text> : null}
          </Stack>
        )}
      </Dialog>
    </Page>
  );
}

function MountDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const api = useModuleApi();
  const toast = useToast();
  const candidates = useQuery(() => api.get<Disk[]>('/mountable'), [api]);
  const [device, setDevice] = useState<string | null>(null);
  const [target, setTarget] = useState('/mnt/');
  const [readonly, setReadonly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const chosen = candidates.data?.find((d) => d.path === device);
  const submit = async () => {
    setBusy(true);
    try {
      await api.post('/mount', { device, target, readonly });
      toast.show({ title: `Mounted at ${target}`, tone: 'success' });
      onDone();
    } catch (e) {
      setError(e as Error);
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Mount file system"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!device || target.length < 6} onClick={() => void submit()}>
            Mount
          </Button>
        </>
      }
    >
      <Stack gap={3}>
        <QueryView query={candidates} empty={<MessageStrip tone="information">No unmounted file systems were found. Plug in a disk, then reopen this dialog.</MessageStrip>}>
          {(list) => (
            <Select
              label="File system"
              value={device}
              onChange={(v) => {
                setDevice(v);
                const d = list.find((x) => x.path === v);
                if (d) setTarget(`/mnt/${(d.label || d.name).replace(/[^A-Za-z0-9_.-]/g, '_')}`);
              }}
              options={list.map((d) => ({ value: d.path, label: `${d.path} · ${d.fstype} · ${formatBytes(d.size)}${d.label ? ` · ${d.label}` : ''}` }))}
            />
          )}
        </QueryView>
        <Input label="Mount point" value={target} onChange={(e) => setTarget(e.target.value)} description="Inside /mnt, /media or /srv. The directory is created if needed." className="sm-mono" />
        <Checkbox label="Read-only" checked={readonly} onChange={setReadonly} />
        {chosen?.fstype === 'ntfs' ? <MessageStrip tone="information">NTFS needs the ntfs-3g package for write access.</MessageStrip> : null}
        {error ? <ErrorMessage error={error} /> : null}
      </Stack>
    </Dialog>
  );
}

function StorageWidget() {
  const api = useModuleApi();
  const q = useQuery(() => api.get<any>('/summary'), [api], { intervalMs: 30_000 });
  return (
    <QueryView query={q} skeletonLines={3}>
      {(s) => (
        <Stack gap={3}>
          <Text size="sm" tone="secondary">
            {s.disks} disks · {formatBytes(s.capacity)}
          </Text>
          {s.filesystems.slice(0, 4).map((f: any) => (
            <ProgressBar key={f.target} size="sm" value={f.usePercent ?? 0} tone={usageTone(f.usePercent)} label={`${f.target} · ${formatBytes(f.used)} of ${formatBytes(f.size)}`} />
          ))}
        </Stack>
      )}
    </QueryView>
  );
}

registerFrontend('storage', {
  routes: [{ path: '/', component: StoragePage, permission: 'storage.read' }],
  navigation: [{ id: 'storage', label: 'Storage', icon: 'database', order: 30, permission: 'storage.read' }],
  widgets: [{ id: 'usage', title: 'Storage', component: StorageWidget, order: 30, permission: 'storage.read' }],
  commands: [{ id: 'mount', label: 'Mount a disk', path: '/', permission: 'storage.write', keywords: ['usb', 'drive'] }],
});
