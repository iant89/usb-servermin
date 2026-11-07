import { useState } from 'react';
import { Button, SearchField, Select, Stack, StatusIndicator, Switch, Table } from '@enterprise-ui/react';
import { QueryView, api, formatDate, useChannel, usePermission, useQuery } from '@servermin/client';

interface LogEntry {
  id?: number;
  timestamp: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  source: string;
  module?: string;
  message: string;
}

const tone = { DEBUG: 'neutral', INFO: 'information', WARN: 'warning', ERROR: 'error' } as const;

/** Logs of one module. They remain available after the module fails (§25, §60). */
export function ModuleLogs({ moduleId }: { moduleId: string }) {
  const [level, setLevel] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [live, setLive] = useState(false);
  const canLive = usePermission('platform.logs.read');
  const q = useQuery(() => api.get<LogEntry[]>(`/api/v1/platform/modules/${moduleId}/logs`, { level: level ?? undefined, search, limit: 500 }), [moduleId, level, search]);
  useChannel<LogEntry>(live ? 'platform.logs' : null, { module: moduleId }, (entry) => {
    q.setData((prev) => [entry, ...(prev ?? [])].slice(0, 1000));
  });

  return (
    <Stack gap={3}>
      <Stack direction="horizontal" gap={3} wrap align="flex-end">
        <Select label="Minimum level" value={level} onChange={setLevel} placeholder="All levels" options={['DEBUG', 'INFO', 'WARN', 'ERROR'].map((l) => ({ value: l, label: l }))} />
        <SearchField label="Search messages" value={search} onChange={setSearch} />
        {canLive ? <Switch label="Live" checked={live} onChange={setLive} /> : null}
        <Button icon="refresh" onClick={() => void q.refresh()}>
          Refresh
        </Button>
      </Stack>
      <QueryView query={q} empty={<StatusIndicator tone="neutral">No log entries.</StatusIndicator>}>
        {(rows) => (
          <Table
            caption={`Logs of ${moduleId}`}
            data={rows}
            getRowId={(r, i) => String(r.id ?? `${r.timestamp}-${i}`)}
            density="compact"
            stickyHeader
            maxHeight={520}
            columns={[
              { id: 'time', header: 'Time', width: 190, cell: (r) => formatDate(r.timestamp) },
              { id: 'level', header: 'Level', width: 110, cell: (r) => <StatusIndicator tone={tone[r.level]} size="sm">{r.level}</StatusIndicator> },
              { id: 'source', header: 'Source', width: 100, accessor: 'source' },
              { id: 'message', header: 'Message', wrap: true, cell: (r) => <span className="sm-mono">{r.message}</span> },
            ]}
          />
        )}
      </QueryView>
    </Stack>
  );
}
