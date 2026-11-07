import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestContext } from '@servermin/sdk/testing';
import manifest from '../module.json';
import network from '../src/backend/index';
import { parseCidr, parseIpAddr, parseResolvectl, renderNetplan, sameSubnet, validateConfig } from '../src/backend/net';

const ADDR = JSON.stringify([
  { ifindex: 1, ifname: 'lo', flags: ['LOOPBACK', 'UP'], mtu: 65536, operstate: 'UNKNOWN', link_type: 'loopback', address: '00:00:00:00:00:00', addr_info: [{ family: 'inet', local: '127.0.0.1', prefixlen: 8, scope: 'host' }] },
  { ifindex: 2, ifname: 'enp3s0', flags: ['UP'], mtu: 1500, operstate: 'UP', link_type: 'ether', address: 'aa:bb:cc:dd:ee:ff', addr_info: [{ family: 'inet', local: '192.168.1.20', prefixlen: 24, scope: 'global', dynamic: true }] },
  { ifindex: 3, ifname: 'docker0', flags: ['UP'], mtu: 1500, operstate: 'DOWN', link_type: 'ether', address: '02:42:00:00:00:01', linkinfo: { info_kind: 'bridge' }, addr_info: [] },
]);
const ROUTES = JSON.stringify([{ dst: 'default', gateway: '192.168.1.1', dev: 'enp3s0', protocol: 'dhcp', metric: 100 }, { dst: '192.168.1.0/24', dev: 'enp3s0', protocol: 'kernel', prefsrc: '192.168.1.20' }]);

describe('network helpers', () => {
  it('classifies interfaces without assuming names', () => {
    const list = parseIpAddr(ADDR);
    expect(list.map((i) => [i.name, i.type])).toEqual([['lo', 'loopback'], ['enp3s0', 'ethernet'], ['docker0', 'bridge']]);
  });
  it('validates addresses, gateways and DNS', () => {
    expect(parseCidr('10.0.0.5/8')).toMatchObject({ prefix: 8, v6: false });
    expect(parseCidr('10.0.0.256/8')).toBeNull();
    expect(parseCidr('fd00::1/64')).toMatchObject({ v6: true });
    expect(sameSubnet('192.168.1.1', '192.168.1.20/24')).toBe(true);
    expect(sameSubnet('192.168.2.1', '192.168.1.20/24')).toBe(false);
    expect(validateConfig({ mode: 'static', addresses: ['192.168.1.30/24'], gateway: '10.0.0.1', dns: ['x'] })).toEqual([
      'The gateway is not inside any of the configured subnets',
      'DNS server "x" is not an IP address',
    ]);
    expect(validateConfig({ mode: 'static', addresses: [] })).toHaveLength(1);
    expect(validateConfig({ mode: 'dhcp' })).toEqual([]);
  });
  it('renders netplan YAML', () => {
    const y = renderNetplan({ enp3s0: { mode: 'static', addresses: ['192.168.1.30/24'], gateway: '192.168.1.1', dns: ['1.1.1.1'] } });
    expect(y).toContain('    enp3s0:\n      dhcp4: false');
    expect(y).toContain('        - to: default\n          via: "192.168.1.1"');
    expect(() => renderNetplan({ 'bad name': { mode: 'dhcp' } })).toThrow();
  });
  it('parses resolvectl dns output', () => {
    expect(parseResolvectl('Global: 1.1.1.1\nLink 2 (enp3s0): 192.168.1.1 fd00::1\nLink 3 (docker0):')).toEqual([
      { interface: null, servers: ['1.1.1.1'] },
      { interface: 'enp3s0', servers: ['192.168.1.1', 'fd00::1'] },
      { interface: 'docker0', servers: [] },
    ]);
  });
});

describe('network module', () => {
  const commands = { ip: (args: string[]) => (args.includes('route') ? ROUTES : ADDR) };
  const dataDir = mkdtempSync(join(tmpdir(), 'net-'));

  it('lists interfaces and the default gateway', async () => {
    const t = createTestContext(manifest as any, { commands, dataDir });
    await t.start(network);
    const s = (await t.request<any>('GET', '/status')).body;
    expect(s.gateway).toMatchObject({ gateway: '192.168.1.1', device: 'enp3s0' });
    expect(s.up).toEqual([{ name: 'enp3s0', addresses: ['192.168.1.20/24'] }]);
    await t.stop();
  });

  it('protects the connection in use and applies with a rollback timer', async () => {
    const t = createTestContext(manifest as any, { commands, dataDir });
    await t.start(network);
    // The browser reaches the server through 192.168.1.20 on enp3s0.
    const req = (body: unknown) => t.request<any>('PUT', '/interfaces/enp3s0', { body, host: '192.168.1.20:80' });
    const risky = await req({ mode: 'static', addresses: ['192.168.1.30/24'], gateway: '192.168.1.1' });
    expect(risky.status).toBe(409);
    expect(risky.body.details.reason).toBe('connection-at-risk');
    expect(t.privileged).toHaveLength(0);
    expect((await req({ mode: 'static', addresses: ['192.168.1.300/24'] })).status).toBe(400);
    expect((await t.request('PUT', '/interfaces/docker0', { body: { mode: 'dhcp' } })).status).toBe(400);
    const ok = await req({ mode: 'static', addresses: ['192.168.1.30/24'], gateway: '192.168.1.1', dns: ['1.1.1.1'], acknowledgeRisk: true });
    expect(ok.status).toBe(200);
    expect(ok.body.pending.interfaces).toEqual(['enp3s0']);
    expect(t.privileged[0]).toMatchObject({ operation: 'network.apply', args: { rollback: '120' }, confirmed: true });
    expect(readFileSync(join(dataDir, 'staged-netplan.yaml'), 'utf8')).toContain('"192.168.1.30/24"');
    expect((await req({ mode: 'dhcp' })).status).toBe(409); // a change is already pending
    expect((await t.request('POST', '/confirm')).status).toBe(200);
    expect((await t.request('GET', '/pending')).body).toBeNull();
    await t.stop();
  });
});
