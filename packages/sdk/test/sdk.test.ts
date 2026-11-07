import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  compilePath,
  configDefaults,
  hasPermission,
  matchPath,
  matchesEventPattern,
  redactConfig,
  satisfies,
  validateConfig,
  validateManifest,
  validatePrivilegedArgs,
} from '../src/index';

const base = { id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: 1, backend: { entry: 'dist/backend.js' } };

describe('manifest validation', () => {
  it('accepts a minimal manifest', () => {
    expect(validateManifest(base)).toMatchObject({ valid: true, errors: [] });
  });
  it('reports every problem', () => {
    const r = validateManifest({
      id: 'Demo!',
      name: '',
      version: 'one',
      apiVersion: 2,
      coreVersion: '>=9',
      dependencies: { demo: '^1', other: 'not a range' },
      permissions: [{ id: 'users.steal', description: 'x' }, { id: 'nodot', description: 'x' }],
      channels: [{ name: 'live', permission: 'demo.undeclared' }],
      host: { commands: ['ls; rm'], privileged: ['root.everything'] },
      config: [{ key: 'a', type: 'enum', label: 'A' }, { key: 'a', type: 'string', label: 'A' }],
      backend: { entry: '../escape.js' },
      events: { publishes: ['module'] },
    }, { coreVersion: '1.0.0' });
    expect(r.valid).toBe(false);
    const text = r.errors.join('\n');
    for (const fragment of ['id must be', 'name is required', 'semantic version', 'apiVersion 2', 'Requires core >=9', 'invalid version range', 'reserved for the core', 'namespace.action', 'undeclared permission', 'host.commands', 'unknown privileged operation', 'needs options', 'duplicated', 'backend.entry', 'event namespace "module"'])
      expect(text).toContain(fragment);
  });
  it('rejects a dependency on itself', () => {
    expect(validateManifest({ ...base, dependencies: { demo: '^1.0.0' } }).errors).toEqual(['a module cannot depend on itself']);
  });
  it('warns about shell access in host commands', () => {
    expect(validateManifest({ ...base, host: { commands: ['bash'] } }).warnings[0]).toMatch(/arbitrary commands/);
  });
});

describe('semver', () => {
  it.each([
    ['1.2.3', '^1.0.0', true],
    ['2.0.0', '^1.0.0', false],
    ['0.2.5', '^0.2.1', true],
    ['0.3.0', '^0.2.1', false],
    ['1.2.9', '~1.2.0', true],
    ['1.3.0', '~1.2.0', false],
    ['1.5.0', '>=1.2 <2', true],
    ['3.0.0', '^1 || ^3', true],
    ['1.0.0-beta.1', '>=1.0.0', false],
    ['1.4.2', '1.4', true],
    ['5.0.0', '*', true],
  ])('%s satisfies %s → %s', (v, r, expected) => expect(satisfies(v, r)).toBe(expected));
  it('orders prereleases before releases', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
  });
});

describe('permissions', () => {
  it('supports exact, namespace wildcard and global wildcard grants', () => {
    expect(hasPermission(['docker.read'], 'docker.read')).toBe(true);
    expect(hasPermission(['docker.*'], 'docker.write')).toBe(true);
    expect(hasPermission(['docker.*'], 'dockers.write')).toBe(false);
    expect(hasPermission(['*'], 'anything.at.all')).toBe(true);
    expect(hasPermission([], 'authenticated')).toBe(true);
    expect(hasPermission(['system.read'], 'system.write')).toBe(false);
  });
});

describe('events', () => {
  it.each([
    ['docker.container.*', 'docker.container.started', true],
    ['docker.*', 'docker.container.started', false],
    ['docker.**', 'docker.container.started', true],
    ['*.metrics', 'storage.metrics', true],
    ['*.metrics', 'storage.metrics.extra', false],
    ['*', 'x.y', true],
  ])('%s matches %s → %s', (p, t, e) => expect(matchesEventPattern(p, t)).toBe(e));
});

describe('module config', () => {
  const schema = [
    { key: 'port', type: 'number' as const, label: 'Port', default: 80, min: 1, max: 65535 },
    { key: 'mode', type: 'enum' as const, label: 'Mode', options: ['a', 'b'], default: 'a' },
    { key: 'on', type: 'boolean' as const, label: 'On' },
    { key: 'token', type: 'secret' as const, label: 'Token' },
    { key: 'name', type: 'string' as const, label: 'Name', pattern: '^[a-z]+$', required: true, default: 'x' },
  ];
  it('validates, coerces and reports errors', () => {
    expect(configDefaults(schema)).toEqual({ port: 80, mode: 'a', name: 'x' });
    const ok = validateConfig(schema, {}, { port: '8080', on: 'true', token: 's' });
    expect(ok).toEqual({ ok: true, values: { port: 8080, mode: 'a', name: 'x', on: true, token: 's' } });
    const bad = validateConfig(schema, {}, { port: 0, mode: 'c', name: 'A1', nope: 1 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(['mode', 'name', 'nope', 'port']);
    expect(redactConfig(schema, { token: 'secret', port: 1 })).toEqual({ token: '••••••••', port: 1 });
  });
});

describe('privileged operation catalogue', () => {
  it('validates arguments', () => {
    expect(validatePrivilegedArgs('service.restart', { unit: 'nginx.service' })).toEqual([]);
    expect(validatePrivilegedArgs('service.restart', { unit: 'nginx; reboot' })).toEqual(['Invalid value for "unit"']);
    expect(validatePrivilegedArgs('storage.mount', { device: '/dev/sdb1' })).toEqual(['Missing argument "target"']);
    expect(validatePrivilegedArgs('power.reboot', { now: 'yes' })).toEqual(['Unknown argument "now"']);
    expect(validatePrivilegedArgs('storage.unmount', { target: '/mnt/../etc' })).toEqual(['Invalid value for "target"']);
  });
});

describe('route patterns', () => {
  it('matches parameters and rest segments', () => {
    expect(matchPath(compilePath('/containers/:id'), '/containers/abc')).toEqual({ id: 'abc' });
    expect(matchPath(compilePath('/containers/:id'), '/containers/abc/logs')).toBeNull();
    expect(matchPath(compilePath('/files/*'), '/files/a/b%20c')).toEqual({ '*': 'a/b c' });
    expect(compilePath('/a/b').score).toBeGreaterThan(compilePath('/a/:x').score);
    expect(() => compilePath('no-slash')).toThrow();
  });
});
