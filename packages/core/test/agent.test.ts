import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentService, IdentityStore, deriveCapabilities, isUuid, parseIdentity, readHardwareIdentity, readMachineId, type AgentModuleInfo } from '../src/index';
import { agentStateDir, defaultConfig, mergeConfig, validateConfig } from '../src/config/config';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-test-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mod = (id: string, state: AgentModuleInfo['state'], provides: string[] = [], tags: string[] = []): AgentModuleInfo => ({ id, version: '1.0.0', state, health: 'HEALTHY', provides, tags });
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

describe('agent identity store', () => {
  it('creates two distinct random ids on first start and keeps them private', () => {
    const store = new IdentityStore(join(dir, 'agent'));
    const r = store.load();
    expect(r.created).toBe(true);
    expect(r.replaced).toBeUndefined();
    expect(isUuid(r.identity.agentId) && isUuid(r.identity.serverId)).toBe(true);
    expect(r.identity.agentId).not.toBe(r.identity.serverId);
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
    expect(statSync(store.dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(store.dir)).toEqual(['identity.json']);
  });

  it('returns the same identity on every later start', () => {
    const first = new IdentityStore(dir).load().identity;
    const again = new IdentityStore(dir).load();
    expect(again.created).toBe(false);
    expect(again.identity).toEqual(first);
  });

  it.each([
    ['truncated JSON', '{"agentId": "'],
    ['an empty file', ''],
    ['ids that are not UUIDs', JSON.stringify({ agentId: 'saturn', serverId: '1' })],
    ['a missing server id', JSON.stringify({ agentId: '3f0e7a52-4a67-4c0e-9d6b-0f3c5a1b2c3d' })],
    ['a JSON null', 'null'],
  ])('keeps a damaged file (%s) beside a new identity instead of overwriting it', (_name, content) => {
    const store = new IdentityStore(dir);
    writeFileSync(store.file, content);
    const r = store.load();
    expect(r.created).toBe(true);
    expect(r.replaced?.reason).toBeTruthy();
    expect(readFileSync(r.replaced!.keptAs, 'utf8')).toBe(content);
    expect(new IdentityStore(dir).load().identity).toEqual(r.identity);
  });

  it('adopts a server id from a Manager without changing the agent id, and rejects anything that is not a UUID', () => {
    const store = new IdentityStore(dir);
    const { identity } = store.load();
    const assigned = '0b9f3c1e-2d4a-4f6b-8c7d-9e0f1a2b3c4d';
    const next = store.setServerId(identity, assigned);
    expect(next).toEqual({ ...identity, serverId: assigned });
    expect(store.load().identity).toEqual(next);
    expect(() => store.setServerId(next, '../../etc/passwd')).toThrow(/UUID/);
    expect(store.load().identity).toEqual(next);
  });

  it('tolerates a missing creation date but nothing else', () => {
    const ids = { agentId: '3f0e7a52-4a67-4c0e-9d6b-0f3c5a1b2c3d', serverId: '0b9f3c1e-2d4a-4f6b-8c7d-9e0f1a2b3c4d' };
    expect(parseIdentity(JSON.stringify(ids))).toMatchObject(ids);
    expect(() => parseIdentity(JSON.stringify({ ...ids, agentId: ids.agentId.toUpperCase() + 'x' }))).toThrow();
  });
});

describe('host identity facts', () => {
  it('reads DMI fields and fingerprints the hardware model', () => {
    const dmi = join(dir, 'sys/class/dmi/id');
    mkdirSync(dmi, { recursive: true });
    writeFileSync(join(dmi, 'sys_vendor'), 'Dell Inc.\n');
    writeFileSync(join(dmi, 'product_name'), 'OptiPlex 7060\n');
    writeFileSync(join(dmi, 'board_name'), '0C96W1\n');
    const a = readHardwareIdentity(dir);
    expect(a).toMatchObject({ vendor: 'Dell Inc.', product: 'OptiPlex 7060', board: '0C96W1' });
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(dmi, 'product_name'), 'OptiPlex 3080\n');
    expect(readHardwareIdentity(dir).fingerprint).not.toBe(a.fingerprint);
  });

  it('falls back to the device-tree model and reports nothing rather than guessing', () => {
    expect(readHardwareIdentity(dir)).toEqual({ vendor: null, product: null, board: null, fingerprint: null });
    mkdirSync(join(dir, 'proc/device-tree'), { recursive: true });
    writeFileSync(join(dir, 'proc/device-tree/model'), 'Raspberry Pi 4 Model B Rev 1.4\0');
    expect(readHardwareIdentity(dir).product).toBe('Raspberry Pi 4 Model B Rev 1.4');
  });

  it('accepts only a well-formed machine id', () => {
    mkdirSync(join(dir, 'etc'));
    expect(readMachineId(dir)).toBeNull();
    writeFileSync(join(dir, 'etc/machine-id'), '4f2a9c0d1b3e4a5f8c7d6e5f4a3b2c1d\n');
    expect(readMachineId(dir)).toBe('4f2a9c0d1b3e4a5f8c7d6e5f4a3b2c1d');
    writeFileSync(join(dir, 'etc/machine-id'), 'uninitialized\n');
    expect(readMachineId(dir)).toBeNull();
  });
});

describe('agent capabilities', () => {
  it('lists active modules and the services they provide, and nothing from modules that are not running', () => {
    const modules = [
      mod('storage', 'ACTIVE', [], ['smart']),
      mod('docker', 'ACTIVE', ['docker.engine'], ['containers']),
      mod('services', 'ERROR', ['services.systemd']),
      mod('network', 'DISABLED'),
      mod('applications', 'BLOCKED'),
    ];
    expect(deriveCapabilities(modules)).toEqual(['docker', 'docker.engine', 'storage']);
    expect(deriveCapabilities([])).toEqual([]);
  });

  it('leaves out an active module whose health check fails, but keeps a degraded one', () => {
    const broken = { ...mod('docker', 'ACTIVE', ['docker.engine']), health: 'ERROR' as const };
    const offline = { ...mod('ups', 'ACTIVE'), health: 'OFFLINE' as const };
    const degraded = { ...mod('storage', 'ACTIVE'), health: 'DEGRADED' as const };
    expect(deriveCapabilities([broken, offline, degraded])).toEqual(['storage']);
  });

  it('counts a service provided by a replacement module once', () => {
    expect(deriveCapabilities([mod('docker', 'ACTIVE', ['docker.engine']), mod('docker-manager-pro', 'ACTIVE', ['docker.engine'])])).toEqual(['docker', 'docker-manager-pro', 'docker.engine']);
  });
});

describe('agent service', () => {
  it('reports identity, host, version, state and live capabilities', async () => {
    let modules = [mod('docker', 'ACTIVE', ['docker.engine'])];
    mkdirSync(join(dir, 'etc'));
    writeFileSync(join(dir, 'etc/machine-id'), '4f2a9c0d1b3e4a5f8c7d6e5f4a3b2c1d\n');
    const agent = new AgentService({ stateDir: join(dir, 'state'), logger: quiet, modules: () => modules, health: () => 'DEGRADED', serverName: () => 'Saturn', hostRoot: dir });
    expect(() => agent.identity).toThrow(/not loaded/);
    expect(agent.start()).toEqual({ replaced: undefined });
    const r = await agent.report();
    expect(r).toMatchObject({ agentId: agent.identity.agentId, serverId: agent.identity.serverId, name: 'Saturn', machineId: '4f2a9c0d1b3e4a5f8c7d6e5f4a3b2c1d', state: 'STARTING', health: 'DEGRADED', capabilities: ['docker', 'docker.engine'] });
    expect(r.hostname).toBeTruthy();
    expect(r.os.kernel).toBeTruthy();
    expect(r.version).toMatch(/^\d+\.\d+\.\d+/);
    agent.setState('RUNNING');
    modules = [mod('docker', 'ERROR', ['docker.engine'])];
    expect(await agent.report()).toMatchObject({ state: 'RUNNING', capabilities: [] });
  });

  it('tells the caller when a damaged identity was replaced', () => {
    mkdirSync(join(dir, 'state'));
    writeFileSync(join(dir, 'state/identity.json'), 'garbage');
    const errors: string[] = [];
    const agent = new AgentService({ stateDir: join(dir, 'state'), logger: { ...quiet, error: (m) => errors.push(m) }, modules: () => [], health: () => 'HEALTHY', serverName: () => 'x' });
    expect(agent.start().replaced?.keptAs).toMatch(/identity\.json\.damaged-\d+$/);
    expect(errors[0]).toMatch(/identity file was unreadable/);
  });
});

describe('agent configuration', () => {
  it('keeps the identity with the data unless a directory is configured', () => {
    const base = defaultConfig('/x');
    expect(agentStateDir(base)).toBe('/x/var/lib/servermin/agent');
    expect(agentStateDir(mergeConfig(base, { agent: { stateDir: '/etc/servermin/agent' } }))).toBe('/etc/servermin/agent');
  });

  it('rejects a relative state directory', () => {
    expect(() => validateConfig(mergeConfig(defaultConfig('/x'), { agent: { stateDir: 'agent' } }))).toThrow(/agent\.stateDir/);
    expect(() => validateConfig(mergeConfig(defaultConfig('/x'), { agent: { stateDir: 5 as any } }))).toThrow(/agent\.stateDir/);
  });
});
