import { useMemo, useState } from 'react';
import { Badge, Button, Checkbox, Dialog, Flex, Input, PasswordInput, Select, Stack, Switch, Table, Text, useToast } from '@enterprise-ui/react';
import { ErrorMessage, QueryView, api, formatRelative, usePlatform, useQuery } from '@servermin/client';

interface User {
  id: number;
  username: string;
  displayName: string;
  permissions: string[];
  disabled: boolean;
  lastLoginAt: string | null;
}

interface Catalog {
  permissions: { id: string; description: string; module: string }[];
  presets: Record<string, { label: string; permissions: string[] }>;
}

/** Users receive permissions independently of modules (§19). */
export function UsersPanel() {
  const { user: me } = usePlatform();
  const users = useQuery(() => api.get<User[]>('/api/v1/users'), []);
  const catalog = useQuery(() => api.get<Catalog>('/api/v1/permissions'), []);
  const [editing, setEditing] = useState<User | 'new' | null>(null);

  return (
    <Stack gap={3}>
      <Flex justify="space-between" align="center" wrap gap={2}>
        <Text tone="secondary">Grant each user exactly the permissions they need. `*` grants everything.</Text>
        <Button variant="primary" icon="add" onClick={() => setEditing('new')}>
          Add user
        </Button>
      </Flex>
      <QueryView query={users}>
        {(list) => (
          <Table
            caption="Users"
            data={list}
            responsive="stack"
            columns={[
              { id: 'u', header: 'User', rowHeader: true, cell: (u) => <div>{u.displayName}<Text as="div" size="sm" tone="secondary">{u.username}</Text></div> },
              {
                id: 'p',
                header: 'Permissions',
                cell: (u) => (
                  <Flex gap={1} wrap>
                    {u.permissions.includes('*') ? <Badge tone="information">Administrator</Badge> : u.permissions.slice(0, 6).map((p) => <Badge key={p}>{p}</Badge>)}
                    {!u.permissions.includes('*') && u.permissions.length > 6 ? <Badge>+{u.permissions.length - 6}</Badge> : null}
                  </Flex>
                ),
              },
              { id: 's', header: 'Status', cell: (u) => (u.disabled ? <Badge tone="warning">Disabled</Badge> : <Badge tone="success">Active</Badge>) },
              { id: 'l', header: 'Last sign-in', cell: (u) => formatRelative(u.lastLoginAt) },
              { id: 'a', header: 'Actions', align: 'end', cell: (u) => <Button size="sm" onClick={() => setEditing(u)}>Edit</Button> },
            ]}
          />
        )}
      </QueryView>
      {editing && catalog.data ? (
        <UserDialog
          user={editing === 'new' ? null : editing}
          isSelf={editing !== 'new' && editing.id === me.id}
          catalog={catalog.data}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void users.refresh();
          }}
        />
      ) : null}
    </Stack>
  );
}

function UserDialog({ user, isSelf, catalog, onClose, onSaved }: { user: User | null; isSelf: boolean; catalog: Catalog; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [username, setUsername] = useState(user?.username ?? '');
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [password, setPassword] = useState('');
  const [perms, setPerms] = useState<string[]>(user?.permissions ?? catalog.presets.viewer.permissions);
  const [disabled, setDisabled] = useState(user?.disabled ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const isAdmin = perms.includes('*');
  const groups = useMemo(() => {
    const g = new Map<string, Catalog['permissions']>();
    for (const p of catalog.permissions) g.set(p.module, [...(g.get(p.module) ?? []), p]);
    return [...g.entries()];
  }, [catalog]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (user) await api.patch(`/api/v1/users/${user.id}`, { displayName, permissions: perms, disabled, password: password || undefined });
      else await api.post('/api/v1/users', { username, displayName, password, permissions: perms });
      toast.show({ title: user ? 'User updated' : 'User created', tone: 'success' });
      onSaved();
    } catch (e) {
      setError(e as Error);
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!user || !window.confirm(`Delete ${user.username}? Their sessions and API tokens end immediately.`)) return;
    try {
      await api.delete(`/api/v1/users/${user.id}`);
      onSaved();
    } catch (e) {
      setError(e as Error);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={user ? `Edit ${user.username}` : 'Add user'}
      size="lg"
      footer={
        <>
          {user && !isSelf ? (
            <Button variant="destructive" onClick={() => void remove()} style={{ marginInlineEnd: 'auto' }}>
              Delete user
            </Button>
          ) : null}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!user && (!username || !password)} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <Stack gap={4}>
        {error ? <ErrorMessage error={error} title="Not saved" /> : null}
        <Flex gap={3} wrap>
          <Input label="Username" value={username} onChange={(e) => setUsername(e.target.value)} disabled={!!user} required />
          <Input label="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Flex>
        <PasswordInput
          label={user ? 'New password' : 'Password'}
          description={user ? 'Leave empty to keep the current password. Setting one signs the user out everywhere.' : 'At least 10 characters, mixing letters with digits or symbols.'}
          purpose="new"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required={!user}
          autoComplete="new-password"
        />
        {user && !isSelf ? <Switch label="Disabled" description="Disabled users cannot sign in." checked={disabled} onChange={setDisabled} /> : null}
        <Select
          label="Start from a preset"
          value={null}
          placeholder="Choose a preset"
          options={Object.entries(catalog.presets).map(([k, p]) => ({ value: k, label: p.label }))}
          onChange={(k) => k && setPerms(catalog.presets[k].permissions)}
          disabled={isSelf}
        />
        <Checkbox label="Administrator (all permissions)" checked={isAdmin} disabled={isSelf} onChange={(c) => setPerms(c ? ['*'] : [])} />
        {!isAdmin
          ? groups.map(([module, list]) => (
              <fieldset key={module} style={{ border: 0, padding: 0, margin: 0 }}>
                <legend>
                  <Text as="strong">{module === 'core' ? 'Platform' : module}</Text>
                </legend>
                <Flex gap={3} wrap>
                  {list.map((p) => (
                    <Checkbox
                      key={p.id}
                      label={p.id}
                      description={p.description}
                      checked={perms.includes(p.id) || perms.includes(p.id.split('.')[0] + '.*')}
                      onChange={(c) => setPerms((cur) => (c ? [...cur.filter((x) => x !== p.id), p.id] : cur.filter((x) => x !== p.id && x !== p.id.split('.')[0] + '.*')))}
                    />
                  ))}
                </Flex>
              </fieldset>
            ))
          : null}
      </Stack>
    </Dialog>
  );
}
