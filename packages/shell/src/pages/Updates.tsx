import { useEffect, useState } from 'react';
import { AlertDialog, Button, Card, DescriptionList, ExpandableText, Flex, Link, MessageStrip, Stack, StatusIndicator, Switch, Table, Text, TimePicker, useToast } from '@enterprise-ui/react';
import { ErrorMessage, QueryView, api, formatDate, formatRelative, useChannel, useQuery } from '@servermin/client';

export interface UpdateState {
  currentVersion: string;
  repository: string;
  enabled: boolean;
  blocker: string | null;
  checkedAt: string | null;
  error: string | null;
  available: { version: string; name: string; notes: string; url: string; publishedAt: string; hasBuild: boolean } | null;
  moduleUpdates: { id: string; name: string; installed: string; available: string; compatible: boolean }[];
  previousVersion: string | null;
  applying: boolean;
  lastResult: { state: string; from?: string; to?: string | null; finishedAt?: string | null; error?: string | null; reason?: string | null } | null;
  settings: { autoInstall: boolean; window: string };
  simulated: boolean;
}

const RESULT: Record<string, { tone: 'success' | 'warning' | 'error' | 'information'; label: string }> = {
  verifying: { tone: 'information', label: 'Verifying the release' },
  installing: { tone: 'information', label: 'Installing' },
  checking: { tone: 'information', label: 'Waiting for the new version to start' },
  'rolling-back': { tone: 'warning', label: 'Rolling back' },
  succeeded: { tone: 'success', label: 'Updated' },
  'rolled-back': { tone: 'warning', label: 'Rolled back' },
  failed: { tone: 'error', label: 'Failed' },
};

/** Settings → Updates: signed releases from GitHub, installed without rebuilding. */
export function UpdatesPanel() {
  const q = useQuery(() => api.get<UpdateState>('/api/v1/updates'), []);
  const [live, setLive] = useState<UpdateState | null>(null);
  useChannel<UpdateState>('platform.updates', {}, setLive);
  const toast = useToast();
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'apply' | 'rollback' | null>(null);
  const [windowStart, setWindowStart] = useState<string | null>(null);
  const state = live ?? q.data;
  useEffect(() => {
    if (state && windowStart === null) setWindowStart(state.settings.window);
  }, [state, windowStart]);

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
      await q.refresh();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(null);
    }
  };

  const install = () =>
    act('apply', async () => {
      const r = await api.post<{ version: string; simulated: boolean }>('/api/v1/updates/apply');
      toast.show({
        title: r.simulated ? `Simulated: the update to ${r.version} would start now` : `Installing ${r.version}`,
        description: r.simulated ? undefined : 'The server restarts in a moment. This page reconnects when it is back.',
        tone: 'information',
      });
    });

  return (
    <QueryView query={q}>
      {() =>
        state ? (
          <Stack gap={4}>
            {state.blocker ? <MessageStrip tone="warning" title="Automatic updates are not available">{state.blocker}</MessageStrip> : null}
            {state.applying ? <MessageStrip tone="information" title={RESULT[state.lastResult!.state]?.label ?? 'Updating'}>Server Control restarts during the update; if the new version does not start, the previous one is restored automatically.</MessageStrip> : null}
            {error ? <ErrorMessage error={error} /> : null}

            <Card
              title="Server Control"
              subtitle={`Signed releases from github.com/${state.repository}`}
              headerActions={
                <Button onClick={() => void act('check', () => api.post('/api/v1/updates/check'))} loading={busy === 'check'} disabled={!!state.blocker || !!busy}>
                  Check now
                </Button>
              }
            >
              <Stack gap={4}>
                <DescriptionList
                  columns={2}
                  items={[
                    { term: 'Installed version', description: state.currentVersion },
                    {
                      term: 'Latest release',
                      description: state.available ? <StatusIndicator tone="information">{state.available.version} available</StatusIndicator> : state.checkedAt && !state.error ? <StatusIndicator tone="success">Up to date</StatusIndicator> : '—',
                    },
                    { term: 'Last checked', description: state.checkedAt ? `${formatRelative(state.checkedAt)}${state.error ? ` — ${state.error}` : ''}` : 'Never' },
                    {
                      term: 'Last update',
                      description: state.lastResult?.finishedAt ? (
                        <span>
                          <StatusIndicator tone={RESULT[state.lastResult.state]?.tone ?? 'information'}>{RESULT[state.lastResult.state]?.label ?? state.lastResult.state}</StatusIndicator>{' '}
                          {state.lastResult.from} → {state.lastResult.to ?? '?'} · {formatDate(state.lastResult.finishedAt)}
                          {state.lastResult.error ? <Text as="div" size="sm" tone="secondary">{state.lastResult.error}</Text> : null}
                        </span>
                      ) : (
                        '—'
                      ),
                    },
                  ]}
                />
                {state.available ? (
                  <Stack gap={3}>
                    <Text as="strong">
                      {state.available.name} · published {formatDate(state.available.publishedAt)}
                    </Text>
                    {state.available.notes ? <ExpandableText text={state.available.notes} maxCharacters={600} /> : null}
                    <Flex gap={3} align="center" wrap>
                      <Button variant="primary" onClick={() => setConfirm('apply')} disabled={!!state.blocker || !state.available.hasBuild || state.applying || !!busy} loading={busy === 'apply'}>
                        Install {state.available.version}
                      </Button>
                      <Link href={state.available.url} target="_blank" rel="noreferrer">
                        Release notes on GitHub
                      </Link>
                    </Flex>
                    {!state.available.hasBuild ? <MessageStrip tone="warning">This release has no build for this server's processor architecture.</MessageStrip> : null}
                  </Stack>
                ) : null}
              </Stack>
            </Card>

            {state.moduleUpdates.length ? (
              <Card title="Module updates" subtitle="Module packages from the latest release. Updating a module does not restart the server.">
                <Table
                  caption="Module updates"
                  hideCaption
                  data={state.moduleUpdates}
                  density="compact"
                  getRowId={(m) => m.id}
                  columns={[
                    { id: 'n', header: 'Module', rowHeader: true, accessor: 'name' },
                    { id: 'i', header: 'Installed', accessor: 'installed' },
                    { id: 'a', header: 'Available', accessor: 'available' },
                    {
                      id: 'x',
                      header: '',
                      align: 'end',
                      cell: (m) =>
                        m.compatible ? (
                          <Button size="sm" onClick={() => void act(`module:${m.id}`, () => api.post(`/api/v1/updates/modules/${m.id}`))} loading={busy === `module:${m.id}`} disabled={!!busy}>
                            Update
                          </Button>
                        ) : (
                          <Text size="sm" tone="secondary">Needs a newer Server Control</Text>
                        ),
                    },
                  ]}
                />
              </Card>
            ) : null}

            <Card title="Automatic installation" subtitle="New releases are checked daily. Turn this on to install them in a maintenance window as well; a failed update is rolled back automatically.">
              <Stack gap={3} style={{ maxWidth: 520 }}>
                <Switch
                  label="Install updates automatically"
                  checked={state.settings.autoInstall}
                  disabled={!!state.blocker}
                  onChange={(on) => void act('settings', () => api.put('/api/v1/updates/settings', { autoInstall: on }))}
                />
                <Flex gap={3} align="flex-end" wrap>
                  <TimePicker label="Maintenance window starts at" description="Server local time; the window lasts one hour." value={windowStart} onChange={setWindowStart} step={30} />
                  <Button onClick={() => void act('settings', () => api.put('/api/v1/updates/settings', { window: windowStart }))} disabled={!windowStart || windowStart === state.settings.window || !!busy}>
                    Save
                  </Button>
                </Flex>
              </Stack>
            </Card>

            {state.previousVersion ? (
              <Card title="Previous version" subtitle="The version installed before the last update is kept so it can be restored.">
                <Flex gap={3} align="center" wrap>
                  <Text>Server Control {state.previousVersion}</Text>
                  <Button variant="destructive" onClick={() => setConfirm('rollback')} disabled={state.applying || !!busy} loading={busy === 'rollback'}>
                    Roll back to {state.previousVersion}
                  </Button>
                </Flex>
              </Card>
            ) : null}

            <AlertDialog
              open={confirm === 'apply'}
              title={`Install Server Control ${state.available?.version ?? ''}?`}
              confirmLabel="Install and restart"
              tone="warning"
              onCancel={() => setConfirm(null)}
              onConfirm={() => {
                setConfirm(null);
                return install();
              }}
            >
              The server restarts and the web interface is unavailable for a minute or two. Its database is backed up first; if the new version does not start, the previous one is restored automatically.
            </AlertDialog>
            <AlertDialog
              open={confirm === 'rollback'}
              title={`Roll back to ${state.previousVersion ?? ''}?`}
              confirmLabel="Roll back and restart"
              tone="error"
              onCancel={() => setConfirm(null)}
              onConfirm={() => {
                setConfirm(null);
                return act('rollback', () => api.post('/api/v1/updates/rollback'));
              }}
            >
              The server restarts with the previous version and the database as it was before the last update. Changes made since then are lost.
            </AlertDialog>
          </Stack>
        ) : null
      }
    </QueryView>
  );
}
