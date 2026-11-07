import { useState, type FormEvent } from 'react';
import { Button, Card, Input, MessageStrip, PasswordInput, Stack, Text, Title } from '@enterprise-ui/react';
import { api } from '@servermin/client';

const requirements = [
  { label: 'At least 10 characters', test: (p: string) => p.length >= 10 },
  { label: 'Letters and digits or symbols', test: (p: string) => /[A-Za-z]/.test(p) && /[^A-Za-z]/.test(p) },
];

/** First-run setup: create the first administrator, proven by the setup token on disk. */
export function SetupPage({ serverName, onDone }: { serverName: string; onDone: () => void }) {
  const [form, setForm] = useState({ setupToken: '', username: 'admin', displayName: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const mismatch = form.confirm.length > 0 && form.confirm !== form.password;
  const valid = form.setupToken && form.username && requirements.every((r) => r.test(form.password)) && form.password === form.confirm;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/v1/auth/setup', { setupToken: form.setupToken.trim(), username: form.username, displayName: form.displayName, password: form.password });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="sm-auth">
      <Card className="sm-auth-card">
        <form onSubmit={submit} noValidate>
          <Stack gap={4}>
            <div>
              <Title level={1} size="lg">
                Set up Server Control
              </Title>
              <Text tone="secondary">Create the administrator account for {serverName}.</Text>
            </div>
            <MessageStrip tone="information">
              The setup token was printed to the service log (<code>journalctl -u server-control</code>) and saved in <code>/var/lib/servermin/setup-token</code>.
            </MessageStrip>
            {error ? (
              <MessageStrip tone="error" announce="assertive">
                {error}
              </MessageStrip>
            ) : null}
            <Input label="Setup token" value={form.setupToken} onChange={set('setupToken')} required autoComplete="off" autoFocus />
            <Input label="Username" value={form.username} onChange={set('username')} required autoComplete="username" />
            <Input label="Display name" value={form.displayName} onChange={set('displayName')} autoComplete="name" />
            <PasswordInput label="Password" purpose="new" requirements={requirements} value={form.password} onChange={set('password')} required autoComplete="new-password" />
            <PasswordInput label="Confirm password" value={form.confirm} onChange={set('confirm')} required autoComplete="new-password" error={mismatch ? 'The passwords do not match' : undefined} />
            <Button type="submit" variant="primary" loading={busy} disabled={!valid} fullWidth>
              Create administrator
            </Button>
          </Stack>
        </form>
      </Card>
    </main>
  );
}
