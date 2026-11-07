import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Button, Flex, MessageStrip, Page, Stack, StatusIndicator, Text } from '@enterprise-ui/react';
import { registerFrontend, socket, useModuleApi, useQuery, type ChannelHandle } from '@servermin/client';

function TerminalView({ onState }: { onState: (s: { status: string; detail?: string }) => void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 14,
      scrollback: 5000,
      theme: { background: '#1d232a', foreground: '#e8eaed' },
      screenReaderMode: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    fit.fit();
    onState({ status: 'connecting' });
    let handle: ChannelHandle | null = socket.subscribe(
      'terminal.session',
      { rows: term.rows, cols: term.cols },
      {
        onData: (msg: any) => {
          if (msg.type === 'output') term.write(msg.data);
          else if (msg.type === 'exit') onState({ status: 'ended', detail: `Shell exited (${msg.code ?? 'signal'})` });
          onState({ status: 'open' });
        },
        onClosed: (reason) => {
          onState({ status: 'ended', detail: reason === 'idle' ? 'Closed after inactivity' : reason === 'module-unloaded' ? 'The terminal module was reloaded' : 'Session ended' });
          handle = null;
        },
        onError: (message) => onState({ status: 'error', detail: message }),
      },
    );
    const input = term.onData((data) => handle?.send({ type: 'input', data }));
    const resize = term.onResize(({ rows, cols }) => handle?.send({ type: 'resize', rows, cols }));
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(host.current!);
    term.focus();
    return () => {
      ro.disconnect();
      input.dispose();
      resize.dispose();
      handle?.close();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div ref={host} role="application" aria-label="Terminal" style={{ height: 'calc(100vh - 260px)', minHeight: 320, padding: 8, background: '#1d232a', borderRadius: 6 }} />;
}

function TerminalPage() {
  const api = useModuleApi();
  const status = useQuery(() => api.get<any>('/status'), [api]);
  const [key, setKey] = useState(0);
  const [state, setState] = useState<{ status: string; detail?: string }>({ status: 'connecting' });
  const tone = state.status === 'open' ? 'success' : state.status === 'connecting' ? 'information' : state.status === 'error' ? 'error' : 'neutral';
  return (
    <Page
      title="Terminal"
      subtitle={status.data ? `${status.data.shell} as the Server Control service account` : undefined}
      actions={
        <Flex gap={2} align="center">
          <StatusIndicator tone={tone}>{state.detail ?? state.status}</StatusIndicator>
          <Button icon="refresh" onClick={() => setKey((k) => k + 1)}>
            New session
          </Button>
        </Flex>
      }
    >
      <Stack gap={3}>
        {status.data && !status.data.available ? <MessageStrip tone="error">python3 is not installed on the server, so the terminal is unavailable.</MessageStrip> : null}
        <TerminalView key={key} onState={setState} />
        <Text size="sm" tone="secondary">
          Sessions are audited and close after inactivity. Use sudo or su with your own account for administrative commands.
        </Text>
      </Stack>
    </Page>
  );
}

registerFrontend('terminal', {
  routes: [{ path: '/', component: TerminalPage, permission: 'terminal.access' }],
  navigation: [{ id: 'terminal', label: 'Terminal', icon: 'syntax', order: 80, permission: 'terminal.access' }],
  commands: [{ id: 'open', label: 'Open a terminal', path: '/', permission: 'terminal.access', keywords: ['shell', 'ssh', 'console'] }],
});
