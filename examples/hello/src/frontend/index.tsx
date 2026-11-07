import { useState } from 'react';
import { Button, Card, Input, Page, Stack, Text } from '@enterprise-ui/react';
import { ErrorMessage, QueryView, registerFrontend, useChannel, useModuleApi, usePermission, useQuery } from '@servermin/client';

function HelloPage() {
  const api = useModuleApi();
  const q = useQuery(() => api.get<{ message: string; recent: { name: string; at: string }[] }>('/greeting'), [api]);
  const [name, setName] = useState('');
  const [reply, setReply] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [count, setCount] = useState<number | null>(null);
  useChannel<{ count: number }>('hello.ticks', {}, (d) => setCount(d.count));
  const canWrite = usePermission('hello.write');
  return (
    <Page title="Hello" subtitle="An example module built only with the public module SDK.">
      <Stack gap={4}>
        <Card title="Live channel">
          <Text>Ticks received: {count ?? '…'}</Text>
        </Card>
        <Card title="Greetings">
          <QueryView query={q}>{(d) => <Stack gap={2}><Text as="p">{d.message}</Text>{d.recent.map((r) => <Text key={r.at} size="sm">{r.name} · {new Date(r.at).toLocaleTimeString()}</Text>)}</Stack>}</QueryView>
        </Card>
        {canWrite ? (
          <Card title="Say hello">
            <form onSubmit={async (e) => { e.preventDefault(); try { setReply((await api.post<{ message: string }>('/greeting', { name })).message); setError(null); void q.refresh(); } catch (err) { setError(err as Error); } }}>
              <Stack gap={3} style={{ maxWidth: 360 }}>
                <Input label="Your name" value={name} onChange={(e) => setName(e.target.value)} />
                <div><Button type="submit" variant="primary">Greet</Button></div>
                {reply ? <Text>{reply}</Text> : null}
                {error ? <ErrorMessage error={error} /> : null}
              </Stack>
            </form>
          </Card>
        ) : null}
      </Stack>
    </Page>
  );
}

function HelloWidget() {
  const [count, setCount] = useState<number | null>(null);
  useChannel<{ count: number }>('hello.ticks', {}, (d) => setCount(d.count));
  return <Text>Ticks: {count ?? '…'}</Text>;
}

registerFrontend('hello', {
  routes: [{ path: '/', component: HelloPage, permission: 'hello.read' }],
  navigation: [{ id: 'hello', label: 'Hello', icon: 'hello-world', order: 900, permission: 'hello.read' }],
  widgets: [{ id: 'ticks', title: 'Hello ticks', component: HelloWidget, permission: 'hello.read', order: 900 }],
  commands: [{ id: 'open', label: 'Say hello', path: '/', permission: 'hello.write' }],
});
