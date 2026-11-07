import { describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ThemeProvider } from '@enterprise-ui/react';
import { PlatformContext, registerFrontend, getFrontends, unregisterFrontend, type FrontendModuleInfo, type PlatformContextValue } from '@servermin/client';
import { ModuleHost } from '../src/shell/ModuleHost';
import { matchRoute } from '../src/shell/match';

const platform = (modules: FrontendModuleInfo[], permissions = ['*']): PlatformContextValue => ({
  user: { id: 1, username: 'u', displayName: 'U', permissions },
  serverName: 'test',
  coreVersion: '1.0.0',
  simulated: true,
  modules,
  refreshModules: vi.fn(async () => undefined),
  signOut: vi.fn(async () => undefined),
});

const info = (over: Partial<FrontendModuleInfo>): FrontendModuleInfo => ({ id: 'docker', name: 'Docker', version: '1.0.0', state: 'ACTIVE', enabled: true, revision: 1, blockedBy: [], script: null, style: null, ...over });

function host(modules: FrontendModuleInfo[], sub = '/', permissions?: string[]) {
  return render(
    <ThemeProvider>
      <PlatformContext.Provider value={platform(modules, permissions)}>
        <ModuleHost moduleId="docker" subPath={sub} frontends={getFrontends()} />
      </PlatformContext.Provider>
    </ThemeProvider>,
  );
}

describe('route matching', () => {
  it('prefers static segments over parameters', () => {
    const A = () => null;
    const B = () => null;
    const routes = [{ path: '/:id', component: A }, { path: '/images', component: B }];
    expect(matchRoute(routes, '/images')?.route.component).toBe(B);
    expect(matchRoute(routes, '/abc')?.params).toEqual({ id: 'abc' });
    expect(matchRoute(routes, '/a/b')).toBeNull();
  });
});

describe('module states in the shell (§45)', () => {
  it.each([
    [[], 'Module missing'],
    [[info({ enabled: false, state: 'DISABLED' })], 'The Docker module is currently disabled.'],
    [[info({ state: 'BLOCKED', blockedBy: ['module x is stopped'] })], 'Dependency unavailable'],
    [[info({ state: 'ERROR', error: 'Unable to communicate with Docker Engine.' })], 'Unable to communicate with Docker Engine.'],
  ])('renders an explicit state %#', (modules, text) => {
    host(modules as FrontendModuleInfo[]);
    expect(screen.getByText(text)).toBeTruthy();
    cleanup();
  });

  it('offers Enable only to users who may configure modules', () => {
    host([info({ enabled: false, state: 'DISABLED' })]);
    expect(screen.getByRole('button', { name: 'Enable module' })).toBeTruthy();
    cleanup();
    host([info({ enabled: false, state: 'DISABLED' })], '/', ['docker.read']);
    expect(screen.queryByRole('button', { name: 'Enable module' })).toBeNull();
    cleanup();
  });

  it('renders registered routes, checks route permissions and removes UI on unregister', () => {
    registerFrontend('docker', {
      routes: [
        { path: '/', component: () => <p>containers page</p> },
        { path: '/secret', component: () => <p>secret</p>, permission: 'docker.write' },
      ],
    });
    host([info({})]);
    expect(screen.getByText('containers page')).toBeTruthy();
    cleanup();
    host([info({})], '/secret', ['docker.read']);
    expect(screen.getByText('Permission denied')).toBeTruthy();
    cleanup();
    host([info({})], '/nope');
    expect(screen.getByText('Page not found')).toBeTruthy();
    cleanup();
    unregisterFrontend('docker');
    expect(getFrontends()).toEqual([]);
  });

  it('contains a crashing module view in an error boundary', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    registerFrontend('docker', {
      routes: [
        {
          path: '/',
          component: () => {
            throw new Error('render failure');
          },
        },
      ],
    });
    host([info({})]);
    expect(screen.getByText('Docker failed to render')).toBeTruthy();
    cleanup();
    unregisterFrontend('docker');
    spy.mockRestore();
  });
});
