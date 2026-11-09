import { useCallback, useEffect, useState } from 'react';
import { BusyIndicator, ThemeProvider, ToastProvider, type ThemePreference } from '@enterprise-ui/react';
import { api, setUnauthorizedHandler, socket, type SessionUser } from '@servermin/client';
import { LoginPage } from './auth/LoginPage';
import { SetupPage } from './auth/SetupPage';
import { Shell } from './shell/Shell';

export interface Session {
  authenticated: boolean;
  needsSetup: boolean;
  serverName: string;
  user?: SessionUser;
  coreVersion?: string;
  simulated?: boolean;
}

const THEME_KEY = 'servermin.theme';

function readTheme(): ThemePreference {
  try {
    return (localStorage.getItem(THEME_KEY) as ThemePreference) || 'system';
  } catch {
    return 'system';
  }
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setThemeState] = useState<ThemePreference>(readTheme);

  const setTheme = (t: ThemePreference) => {
    setThemeState(t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* private mode */
    }
  };

  const load = useCallback(async () => {
    try {
      setSession(await api.get<Session>('/api/v1/auth/session'));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setTimeout(() => void load(), 3000);
    }
  }, []);

  useEffect(() => {
    void load();
    setUnauthorizedHandler(() => void load());
  }, [load]);

  useEffect(() => {
    if (session?.authenticated) socket.start();
    else socket.stop();
  }, [session?.authenticated]);

  useEffect(() => {
    document.title = session?.serverName ? `${session.serverName} · Server Control` : 'Server Control';
  }, [session?.serverName]);

  let content;
  if (!session)
    content = (
      <div className="sm-auth">
        <BusyIndicator active text={error ? `Server unreachable (${error}). Retrying…` : 'Connecting to the server'} />
      </div>
    );
  else if (session.needsSetup) content = <SetupPage serverName={session.serverName} onDone={load} />;
  else if (!session.authenticated || !session.user) content = <LoginPage serverName={session.serverName} onDone={load} />;
  else content = <Shell session={session as Required<Session>} onSessionChange={load} theme={theme} onThemeChange={setTheme} />;

  return (
    <ThemeProvider theme={theme} density="cozy" style={{ minHeight: '100%' }}>
      <ToastProvider position="bottom-end">{content}</ToastProvider>
    </ThemeProvider>
  );
}
