import { useMemo, useState } from 'react';
import { Badge, Button, Card, Dialog, EmptyState, Flex, Input, Link, MessageStrip, NumberInput, Page, PasswordInput, SearchField, Select, Stack, Switch, Text, useToast } from '@enterprise-ui/react';
import { ErrorMessage, QueryView, linkHandler, modulePath, navigate, usePermission, useModuleApi, useQuery } from '@servermin/client';

interface Param {
  key: string;
  label: string;
  description?: string;
  type: 'string' | 'password' | 'port' | 'path' | 'select';
  default?: string;
  generate?: 'password' | 'timezone';
  required?: boolean;
  options?: { value: string; label: string }[];
  readOnly?: boolean;
}

interface Template {
  id: string;
  name: string;
  category: string;
  description: string;
  website: string;
  version: string;
  versionHint: string;
  params: Param[];
  memoryMb: number;
  warnings?: string[];
  notes?: string;
  installed: string[];
  supported: boolean;
}

interface Catalog {
  arch: string;
  memoryMb: number;
  docker: boolean;
  templates: Template[];
}

/** The catalogue: curated applications that install as Compose stacks with a short form. */
export function CatalogPage() {
  const api = useModuleApi();
  const q = useQuery(() => api.get<Catalog>('/catalog'), [api]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>('all');
  const [installing, setInstalling] = useState<string | null>(null);
  const categories = useMemo(() => [...new Set((q.data?.templates ?? []).map((t) => t.category))].sort(), [q.data]);
  const back = modulePath('applications');
  return (
    <Page
      title="App catalogue"
      subtitle="Ready-made applications. Pick one, fill in a few settings and it is installed as a Docker Compose application."
      breadcrumbs={[{ label: 'Applications', href: back, onClick: linkHandler(back) } as any, { label: 'Catalogue' }]}
    >
      <QueryView query={q}>
        {(c) => {
          const needle = search.trim().toLowerCase();
          const shown = c.templates.filter((t) => (category === 'all' || t.category === category) && (!needle || `${t.name} ${t.description} ${t.category}`.toLowerCase().includes(needle)));
          return (
            <Stack gap={4}>
              {!c.docker ? <MessageStrip tone="warning" title="The Docker module is not active">Catalogue applications run in containers. Enable the Docker module (and install Docker on the server) to install them.</MessageStrip> : null}
              <Flex gap={3} wrap align="flex-end">
                <SearchField label="Search" value={search} onChange={setSearch} />
                <Select label="Category" value={category} onChange={setCategory} options={[{ value: 'all', label: 'All categories' }, ...categories.map((x) => ({ value: x, label: x }))]} />
              </Flex>
              {shown.length ? (
                <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))' }}>
                  {shown.map((t) => (
                    <Card
                      key={t.id}
                      title={t.name}
                      subtitle={t.category}
                      headerActions={t.installed.length ? <Badge tone="success">Installed</Badge> : undefined}
                      footer={
                        <Flex gap={2} justify="space-between" align="center" style={{ width: '100%' }}>
                          <Link href={t.website} target="_blank" rel="noreferrer">
                            Website
                          </Link>
                          <Button variant={t.installed.length ? 'secondary' : 'primary'} size="sm" disabled={!t.supported || !c.docker} onClick={() => setInstalling(t.id)}>
                            {t.installed.length ? 'Install again' : 'Install'}
                          </Button>
                        </Flex>
                      }
                    >
                      <Stack gap={2}>
                        <Text>{t.description}</Text>
                        <Text size="sm" tone="secondary">
                          {t.supported ? `Needs about ${t.memoryMb >= 1024 ? `${t.memoryMb / 1024} GB` : `${t.memoryMb} MB`} of memory` : `Not available for ${c.arch} processors`}
                        </Text>
                        {t.installed.length ? (
                          <Text size="sm">
                            {t.installed.map((id, i) => (
                              <span key={id}>
                                {i ? ', ' : ''}
                                <a href={modulePath('applications', `/${id}`)} onClick={linkHandler(modulePath('applications', `/${id}`))}>
                                  {id}
                                </a>
                              </span>
                            ))}
                          </Text>
                        ) : null}
                      </Stack>
                    </Card>
                  ))}
                </div>
              ) : (
                <EmptyState icon="search" title="Nothing matches" description="Try another search or category." />
              )}
              {installing ? <InstallDialog id={installing} serverMemoryMb={c.memoryMb} onClose={() => setInstalling(null)} /> : null}
            </Stack>
          );
        }}
      </QueryView>
    </Page>
  );
}

function InstallDialog({ id, serverMemoryMb, onClose }: { id: string; serverMemoryMb: number; onClose: () => void }) {
  const api = useModuleApi();
  const toast = useToast();
  const canDeploy = usePermission('applications.deploy');
  const q = useQuery(() => api.get<Template & { suggested: { appId: string; values: Record<string, string> } }>(`/catalog/${id}`), [api, id]);
  const [form, setForm] = useState<{ appId: string; name: string; version: string; values: Record<string, string> } | null>(null);
  const [deploy, setDeploy] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const t = q.data;
  if (t && !form) setForm({ appId: t.suggested.appId, name: t.installed.length ? `${t.name} ${t.suggested.appId.split('-').pop()}` : t.name, version: t.version, values: t.suggested.values });
  const setValue = (key: string, value: string) => setForm((f) => f && { ...f, values: { ...f.values, [key]: value } });

  const install = async () => {
    if (!form || !t) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ app: { id: string }; deploying: boolean }>(`/catalog/${id}/install`, { id: form.appId, name: form.name, version: form.version, values: form.values, deploy: deploy && canDeploy });
      toast.show({ title: `${t.name} installed`, description: r.deploying ? 'Downloading and starting it now; this can take a few minutes.' : 'Deploy it to start it.', tone: 'success' });
      navigate(modulePath('applications', `/${r.app.id}`));
    } catch (e) {
      setError(e as Error);
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t ? `Install ${t.name}` : 'Install'}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!form} onClick={() => void install()}>
            {deploy && canDeploy ? 'Install and start' : 'Install'}
          </Button>
        </>
      }
    >
      <QueryView query={q}>
        {(tpl) =>
          form ? (
            <Stack gap={3}>
              <Text>{tpl.description}</Text>
              {tpl.memoryMb > serverMemoryMb / 2 ? <MessageStrip tone="warning">{tpl.name} needs about {tpl.memoryMb} MB of memory; this server has {Math.round(serverMemoryMb / 1024)} GB in total.</MessageStrip> : null}
              {(tpl.warnings ?? []).map((w) => (
                <MessageStrip key={w} tone="warning">
                  {w}
                </MessageStrip>
              ))}
              {error ? <ErrorMessage error={error} title="Not installed" /> : null}
              <Flex gap={3} wrap>
                <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
                <Input label="Id" value={form.appId} onChange={(e) => setForm({ ...form, appId: e.target.value })} className="sm-mono" required description="Also names its containers and volumes." />
                <Input label="Version" value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} className="sm-mono" description={tpl.versionHint} />
              </Flex>
              {tpl.params.map((p) => {
                const value = form.values[p.key] ?? '';
                const common = { key: p.key, label: p.label, description: p.description, required: p.required };
                switch (p.type) {
                  case 'password':
                    return <PasswordInput {...common} value={value} placeholder={p.generate ? 'Generated automatically' : undefined} onChange={(e) => setValue(p.key, e.target.value)} autoComplete="new-password" />;
                  case 'port':
                    return <NumberInput {...common} value={value ? Number(value) : null} min={1} max={65535} onChange={(v) => setValue(p.key, v === null ? '' : String(v))} />;
                  case 'select':
                    return <Select {...common} value={value || null} onChange={(v) => setValue(p.key, v ?? '')} options={p.options ?? []} />;
                  default:
                    return <Input {...common} value={value} className={p.type === 'path' ? 'sm-mono' : undefined} onChange={(e) => setValue(p.key, e.target.value)} />;
                }
              })}
              {canDeploy ? <Switch label="Start it now" description="Downloads the images and starts the containers in the background." checked={deploy} onChange={setDeploy} /> : <MessageStrip tone="information">You can install it; someone with the deploy permission starts it.</MessageStrip>}
              {tpl.notes ? <MessageStrip tone="information" title="After installing">{tpl.notes}</MessageStrip> : null}
            </Stack>
          ) : null
        }
      </QueryView>
    </Dialog>
  );
}
