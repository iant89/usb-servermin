import { describe, expect, it } from 'vitest';
import { createTestContext, testUser } from '@servermin/sdk/testing';
import manifest from '../module.json';
import system from '../src/backend/index';
import { parseAptUpgradable, parseCpuinfo, parseLspciGpus, parseMeminfo, parsePidStat } from '../src/backend/proc';

describe('system parsers', () => {
  it('parses meminfo with and without MemAvailable', () => {
    const m = parseMeminfo('MemTotal: 1000 kB\nMemFree: 200 kB\nMemAvailable: 600 kB\nSwapTotal: 100 kB\nSwapFree: 40 kB');
    expect(m).toMatchObject({ total: 1024000, available: 614400, used: 409600, swapUsed: 61440 });
  });
  it('counts physical cores and threads', () => {
    const block = (p: number, core: number) => `processor\t: ${p}\nmodel name\t: Test CPU\nphysical id\t: 0\ncore id\t: ${core}\nflags\t: fpu vmx hypervisor\n`;
    const c = parseCpuinfo([block(0, 0), block(1, 0), block(2, 1), block(3, 1)].join('\n'));
    expect(c).toMatchObject({ model: 'Test CPU', threads: 4, cores: 2, flags: ['vmx', 'hypervisor'] });
  });
  it('parses process stat lines with spaces in the name', () => {
    const s = parsePidStat('1234 (my (odd) proc) S 1 1234 1234 0 -1 4194560 100 0 0 0 50 25 0 0 20 0 3 0 9000 1000000 256 18446744073709551615');
    expect(s).toMatchObject({ name: 'my (odd) proc', state: 'S', ppid: 1, utime: 50, stime: 25, threads: 3, rssPages: 256 });
  });
  it('parses apt upgradable output', () => {
    const p = parseAptUpgradable('Listing...\nopenssl/jammy-security 3.0.2-0ubuntu1.15 amd64 [upgradable from: 3.0.2-0ubuntu1.14]\ncurl/jammy-updates 7.81.0-1ubuntu1.16 amd64 [upgradable from: 7.81.0-1ubuntu1.15]');
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ name: 'openssl', security: true, from: '3.0.2-0ubuntu1.14' });
  });
  it('finds GPUs in lspci -mm output', () => {
    const g = parseLspciGpus('00:02.0 "VGA compatible controller" "Intel Corporation" "UHD Graphics 620" -r07 "Lenovo" "Device"\n00:14.0 "USB controller" "Intel" "xHCI"');
    expect(g).toEqual([{ slot: '00:02.0', vendor: 'Intel Corporation', device: 'UHD Graphics 620' }]);
  });
});

describe('system module', () => {
  const commands = {
    timedatectl: (args: string[]) => (args[0] === 'show' ? 'Timezone=Europe/Berlin\nNTP=yes\nNTPSynchronized=no\n' : 'UTC\nEurope/Berlin\n'),
    apt: () => 'Listing...\nvim/noble-updates 2:9.1 amd64 [upgradable from: 2:9.0]\n',
  };

  it('reports host information discovered at runtime', async () => {
    const t = createTestContext(manifest as any, { commands });
    await t.start(system);
    const info = await t.request<any>('GET', '/info');
    expect(info.status).toBe(200);
    expect(info.body.time).toMatchObject({ timezone: 'Europe/Berlin', ntp: true, synchronized: false });
    expect(info.body.cpu.threads).toBeGreaterThan(0);
    expect((await t.request<any>('GET', '/processes', { query: { limit: '5' } })).body.processes.length).toBeLessThanOrEqual(5);
    expect((await t.request<any>('GET', '/updates')).body.packages[0].name).toBe('vim');
    await t.stop();
  });

  it('requires confirmation and permission for power actions', async () => {
    const t = createTestContext(manifest as any, { commands });
    await t.start(system);
    expect((await t.request('POST', '/power/reboot', { body: {} })).status).toBe(428);
    expect((await t.request('POST', '/power/reboot', { body: { confirm: true }, user: testUser(['system.read']) })).status).toBe(403);
    expect((await t.request('POST', '/power/reboot', { body: { confirm: true } })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 600));
    expect(t.privileged).toEqual([expect.objectContaining({ operation: 'power.reboot', confirmed: true })]);
    await t.stop();
  });

  it('validates hostnames before crossing the privilege boundary', async () => {
    const t = createTestContext(manifest as any, { commands });
    await t.start(system);
    expect((await t.request('PUT', '/hostname', { body: { hostname: '-bad-' } })).status).toBe(400);
    expect((await t.request('PUT', '/hostname', { body: { hostname: 'usb-server' } })).status).toBe(200);
    expect(t.privileged[0]).toMatchObject({ operation: 'system.set-hostname', args: { hostname: 'usb-server' } });
    expect(t.published.some((e) => e.type === 'system.hostname.changed')).toBe(true);
    await t.stop();
  });

  it('streams live metrics to channel subscribers', async () => {
    const t = createTestContext(manifest as any, { commands });
    await t.start(system);
    const sub = await t.subscribe('metrics');
    expect(sub.messages[0]).toHaveProperty('memory.total');
    await t.stop();
  });
});
