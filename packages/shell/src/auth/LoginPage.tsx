import { useState, type FormEvent } from 'react';
import { Button, Card, Input, MessageStrip, PasswordInput, Stack, Text, Title } from '@enterprise-ui/react';
import { api } from '@servermin/client';

export function LoginPage({ serverName, onDone }: { serverName: string; onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/v1/auth/login', { username, password });
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
                Sign in
              </Title>
              <Text tone="secondary">Server Control on {serverName}</Text>
            </div>
            {error ? (
              <MessageStrip tone="error" announce="assertive">
                {error}
              </MessageStrip>
            ) : null}
            <Input label="Username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
            <PasswordInput label="Password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <Button type="submit" variant="primary" loading={busy} disabled={!username || !password} fullWidth>
              Sign in
            </Button>
          </Stack>
        </form>
      </Card>
    </main>
  );
}
