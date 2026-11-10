import { describe, expect, it } from 'vitest';
import { createTestContext } from '@servermin/sdk/testing';
import manifest from '../module.json';
import services from '../src/backend/index';
import { mergeUnits, parseJournal, parseListUnits, parseUnitFiles } from '../src/backend/systemd';

const UNITS = 'ssh.service loaded active running OpenBSD Secure Shell server\n● nginx.service loaded failed failed A high performance web server\nserver-control.service loaded active running Server Control\n';
const FILES = 'ssh.service enabled enabled\nnginx.service enabled enabled\ncron.service disabled enabled\ngetty@.service enabled enabled\n';

describe('systemd parsers', () => {
  it('merges loaded units with unit files', () => {
    const merged = mergeUnits(parseListUnits(UNITS), parseUnitFiles(FILES));
    expect(merged.map((u) => [u.unit, u.active, u.enabled])).toEqual([
      ['cron.service', 'inactive', 'disabled'],
      ['nginx.service', 'failed', 'enabled'],
      ['server-control.service', 'active', null],
      ['ssh.service', 'active', 'enabled'],
    ]);
  });
  it('parses journal JSON, including byte-array messages', () => {
    const j = parseJournal(['{"__REALTIME_TIMESTAMP":"1700000000000000","PRIORITY":"3","_SYSTEMD_UNIT":"nginx.service","MESSAGE":"bind failed"}', '{"__REALTIME_TIMESTAMP":"1700000001000000","MESSAGE":[104,105]}'].join('\n'));
    expect(j).toMatchObject([{ priority: 'err', unit: 'nginx.service', message: 'bind failed' }, { priority: 'info', message: 'hi' }]);
  });
});

describe('services module', () => {
  const commands = {
    systemctl: (args: string[]) => (args[0] === 'list-units' ? UNITS : args[0] === 'list-unit-files' ? FILES : 'Id=nginx.service\nLoadState=loaded\nActiveState=failed\n'),
    journalctl: () => '{"__REALTIME_TIMESTAMP":"1700000000000000","PRIORITY":"6","MESSAGE":"ok"}\n',
  };

  it('detects failed services, notifies and reports DEGRADED health', async () => {
    const t = createTestContext(manifest as any, { commands });
    await t.start(services);
    expect((await t.runHealthChecks())[0]).toMatchObject({ status: 'DEGRADED' });
    expect(t.notifications[0].title).toBe('nginx.service failed');
    expect(t.published.some((e) => e.type === 'service.failed')).toBe(true);
    await t.stop();
  });

  it('refuses to stop itself and requires confirmation for access-critical units', async () => {
    const t = createTestContext(manifest as any, { commands });
    await t.start(services);
    expect((await t.request('POST', '/services/server-control/stop')).status).toBe(403);
    expect((await t.request('POST', '/services/servermin-agent/stop')).status).toBe(403);
    expect((await t.request('POST', '/services/servermin-agent.service/restart', { body: { confirm: true } })).status).toBe(403);
    expect((await t.request('POST', '/services/ssh.service/stop', { body: {} })).status).toBe(428);
    expect((await t.request('POST', '/services/ssh.service/stop', { body: { confirm: true } })).status).toBe(200);
    expect((await t.request('POST', '/services/nginx/restart', { body: {} })).status).toBe(200);
    expect(t.privileged.map((p) => `${p.operation} ${p.args.unit}`)).toEqual(['service.stop ssh.service', 'service.restart nginx.service']);
    expect(t.published.some((e) => e.type === 'service.stopped')).toBe(true);
    expect((await t.request('POST', '/services/..%2Fetc/start')).status).toBe(400);
    expect((await t.request<any[]>('GET', '/services/nginx/logs')).body[0].message).toBe('ok');
    await t.stop();
  });
});
