import { useEffect, useState } from 'react';
import { Button, Input, MessageStrip, NumberInput, PasswordInput, Select, Stack, Switch, Text, useToast } from '@enterprise-ui/react';
import type { ConfigField } from '@servermin/sdk';
import { ErrorMessage, api, usePermission } from '@servermin/client';

/** Settings form generated from the manifest's config schema (§24). */
export function ModuleConfigForm({ moduleId, schema, values, onSaved }: { moduleId: string; schema: ConfigField[]; values: Record<string, unknown>; onSaved: () => void }) {
  const [draft, setDraft] = useState<Record<string, unknown>>(values);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const toast = useToast();
  const canEdit = usePermission('modules.configure');
  useEffect(() => setDraft(values), [values]);

  if (!schema.length) return <Text tone="secondary">This module has no settings.</Text>;
  const dirty = schema.some((f) => draft[f.key] !== values[f.key]);
  const fieldError = (key: string) => (error as any)?.problems?.find((p: string) => p.startsWith(key + ':'))?.slice(key.length + 2);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const changed = Object.fromEntries(schema.filter((f) => draft[f.key] !== values[f.key]).map((f) => [f.key, draft[f.key]]));
      await api.put(`/api/v1/platform/modules/${moduleId}/config`, changed);
      toast.show({ title: 'Settings saved', tone: 'success' });
      onSaved();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      style={{ maxWidth: 640 }}
    >
      <Stack gap={4}>
        {!canEdit ? <MessageStrip tone="information">You can view these settings. Changing them needs the modules.configure permission.</MessageStrip> : null}
        {schema.map((f) => {
          const common = { label: f.label, description: f.description, required: f.required, disabled: !canEdit, error: fieldError(f.key) };
          const set = (v: unknown) => setDraft((d) => ({ ...d, [f.key]: v }));
          switch (f.type) {
            case 'boolean':
              return <Switch key={f.key} label={f.label} description={f.description} checked={!!draft[f.key]} onChange={set} disabled={!canEdit} />;
            case 'number':
              return <NumberInput key={f.key} {...common} value={(draft[f.key] as number) ?? null} min={f.min} max={f.max} onChange={set} />;
            case 'enum':
              return <Select key={f.key} {...common} value={(draft[f.key] as string) ?? null} options={(f.options ?? []).map((o) => ({ value: o, label: o }))} onChange={set} />;
            case 'secret':
              return <PasswordInput key={f.key} {...common} value={(draft[f.key] as string) ?? ''} onChange={(e) => set(e.target.value)} autoComplete="off" />;
            default:
              return <Input key={f.key} {...common} value={(draft[f.key] as string) ?? ''} onChange={(e) => set(e.target.value)} />;
          }
        })}
        {error && !(error as any).problems?.length ? <ErrorMessage error={error} title="Settings were not saved" /> : null}
        {canEdit ? (
          <Stack direction="horizontal" gap={2}>
            <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>
              Save settings
            </Button>
            <Button type="button" disabled={!dirty} onClick={() => setDraft(values)}>
              Discard changes
            </Button>
          </Stack>
        ) : null}
      </Stack>
    </form>
  );
}
