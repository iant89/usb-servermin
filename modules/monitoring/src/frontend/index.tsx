import { useState } from 'react';
import { Card, EmptyState, Grid, LineChart, MessageStrip, Page, SegmentedButton, Stack, Text } from '@enterprise-ui/react';
import { QueryView, formatBytes, registerFrontend, useChannel, useModuleApi, useQuery } from '@servermin/client';

interface Series {
  bucketSeconds: number;
  units: Record<string, string>;
  points: Record<string, number | string>[];
}

const RANGES = ['15m', '1h', '6h', '24h', '7d', '30d'];

function label(t: string, range: string) {
  const d = new Date(t);
  return ['7d', '30d'].includes(range) ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' }) : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatter(unit: string) {
  if (unit === 'bytes/s') return (v: number) => `${formatBytes(v)}/s`;
  if (unit === 'bytes') return (v: number) => formatBytes(v);
  if (unit === '%') return (v: number) => `${v.toFixed(0)} %`;
  return (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
}

function MetricChart({ title, metrics, labels, range, height = 220, refreshKey, bare }: { title: string; metrics: string[]; labels: string[]; range: string; height?: number; refreshKey?: number; bare?: boolean }) {
  const api = useModuleApi();
  const q = useQuery(() => api.get<Series>('/series', { metrics: metrics.join(','), range }), [api, metrics.join(','), range, refreshKey], { intervalMs: 30_000 });
  const unit = q.data?.units[metrics[0]] ?? '';
  const body = (
      <QueryView query={q} skeletonLines={4} isEmpty={(s) => s.points.length === 0} empty={<Text tone="secondary">No data in this range yet.</Text>}>
        {(s) => (
          <LineChart
            label={title}
            height={height}
            data={s.points.map((p) => ({ ...p, t: label(String(p.t), range) }))}
            categoryKey="t"
            categoryLabel="Time"
            series={metrics.map((m, i) => ({ key: m, label: labels[i] ?? m }))}
            formatValue={formatter(unit)}
            area={metrics.length === 1}
            includeZero
            yDomain={unit === '%' ? [0, 100] : undefined}
            tableToggle
            directLabels={false}
          />
        )}
      </QueryView>
  );
  return bare ? body : <Card title={title}>{body}</Card>;
}

function MonitoringPage() {
  const api = useModuleApi();
  const [range, setRange] = useState('1h');
  const catalogue = useQuery(() => api.get<{ name: string; unit: string; source: string; last: number | null }[]>('/metrics'), [api], { intervalMs: 60_000 });
  const alerts = useQuery(() => api.get<{ metric: string; value: number }[]>('/alerts'), [api], { intervalMs: 15_000 });
  const contributed = (catalogue.data ?? []).filter((m) => m.source !== 'host');
  const bySource = new Map<string, typeof contributed>();
  for (const m of contributed) bySource.set(m.source, [...(bySource.get(m.source) ?? []), m]);
  return (
    <Page
      title="Monitoring"
      subtitle="History of host metrics and metrics contributed by modules."
      actions={<SegmentedButton aria-label="Time range" selectionMode="single" value={[range]} onChange={(v) => v[0] && setRange(v[0])} items={RANGES.map((r) => ({ value: r, label: r }))} />}
    >
      <Stack gap={4}>
        {alerts.data?.length ? (
          <MessageStrip tone="warning" title="Active alerts">
            {alerts.data.map((a) => `${a.metric} at ${a.value}`).join(', ')}
          </MessageStrip>
        ) : null}
        <Grid columns={{ base: 1, md: 2 }} gap={4}>
          <MetricChart title="CPU" metrics={['cpu.usage']} labels={['CPU usage']} range={range} />
          <MetricChart title="Memory" metrics={['memory.usage', 'swap.usage']} labels={['Memory', 'Swap']} range={range} />
          <MetricChart title="Load average" metrics={['load.1', 'load.5', 'load.15']} labels={['1 min', '5 min', '15 min']} range={range} />
          <MetricChart title="Network" metrics={['network.rx', 'network.tx']} labels={['Received', 'Sent']} range={range} />
          <MetricChart title="Root disk" metrics={['disk.root.usage']} labels={['Used']} range={range} />
          <MetricChart title="Processes" metrics={['processes.total', 'processes.running']} labels={['Total', 'Running']} range={range} />
        </Grid>
        <Card title="Module metrics" subtitle="Any module can contribute metrics by publishing a <module>.metrics event.">
          {bySource.size === 0 ? (
            <EmptyState size="sm" icon="line-chart" title="No module metrics yet" description="Docker, Storage, Network and Services publish metrics when they are active." />
          ) : (
            <Grid columns={{ base: 1, md: 2 }} gap={4}>
              {[...bySource].map(([source, list]) => (
                <MetricChart key={source} title={source} metrics={list.slice(0, 4).map((m) => m.name)} labels={list.slice(0, 4).map((m) => m.name.slice(source.length + 1))} range={range} />
              ))}
            </Grid>
          )}
        </Card>
      </Stack>
    </Page>
  );
}

function MonitoringWidget() {
  const [n, setN] = useState(0);
  // Reload the chart every fourth live sample instead of polling.
  useChannel('monitoring.live', {}, () => setN((x) => x + 1));
  return <MetricChart bare title="CPU and memory, last hour" metrics={['cpu.usage', 'memory.usage']} labels={['CPU', 'Memory']} range="1h" height={160} refreshKey={Math.floor(n / 4)} />;
}

registerFrontend('monitoring', {
  routes: [{ path: '/', component: MonitoringPage, permission: 'monitoring.read' }],
  navigation: [{ id: 'monitoring', label: 'Monitoring', icon: 'line-chart', order: 15, permission: 'monitoring.read' }],
  widgets: [{ id: 'history', title: 'CPU and memory, last hour', component: MonitoringWidget, span: 2, order: 5, permission: 'monitoring.read' }],
  commands: [{ id: 'charts', label: 'Show metrics history', path: '/', permission: 'monitoring.read', keywords: ['graphs', 'cpu', 'memory'] }],
});
