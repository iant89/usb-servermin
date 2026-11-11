import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const helper = join(import.meta.dirname, '../../../deploy/servermin-privileged');
const run = (...args: string[]) => spawnSync('bash', [helper, ...args], { encoding: 'utf8' });

/** The root helper is the security boundary; it must refuse anything outside the catalogue (§22). */
describe('privilege helper', () => {
  it.each([
    [['bogus'], /unknown operation/],
    [[], /usage/],
    [['power.reboot', 'now=1'], /unexpected argument now/],
    [['service.stop', 'unit=server-control.service'], /refusing to stop Server Control/],
    [['service.stop', 'unit=servermin-agent.service'], /refusing to stop Server Control/],
    [['service.restart', 'unit=servermin-agent.service'], /refusing to restart Server Control/],
    [['service.disable', 'unit=servermin-agent.service'], /refusing to disable Server Control/],
    [['service.restart', 'unit=nginx.service;reboot'], /invalid or missing argument: unit/],
    [['service.start', 'unit=nginx.service', 'unit=x.service'], /duplicate argument/],
    [['system.set-hostname', 'hostname=-x-'], /hostname/],
    [['system.set-timezone', 'timezone=../../etc/shadow'], /timezone/],
    [['storage.mount', 'device=/dev/sdb1', 'target=/etc/cron.d'], /target/],
    [['storage.mount', 'device=/dev/../etc/passwd', 'target=/mnt/x'], /\.\./],
    [['storage.unmount', 'target=/'], /protected/],
    [['storage.unmount', 'target=/boot/efi/'], /protected/],
    [['network.apply', 'file=/etc/shadow', 'rollback=60'], /file/],
    [['network.apply', 'file=/var/lib/servermin/module-data/network/staged-netplan.yaml', 'rollback=10'], /rollback must be 30-900/],
    [['storage.smart', 'device=/dev/sda;id'], /device/],
    [['platform.update', 'manifest=/etc/shadow', 'signature=/var/tmp/servermin/updates/a.sig', 'archive=/var/tmp/servermin/updates/a.tar.gz'], /manifest/],
    [['platform.update', 'manifest=/var/tmp/servermin/updates/../x', 'signature=/var/tmp/servermin/updates/a.sig', 'archive=/var/tmp/servermin/updates/a.tar.gz'], /manifest/],
    [['platform.update', 'manifest=/var/tmp/servermin/updates/release.json'], /signature/],
    [['platform.update', 'manifest=/var/tmp/servermin/updates/missing.json', 'signature=/var/tmp/servermin/updates/a.sig', 'archive=/var/tmp/servermin/updates/a.tar.gz'], /not a regular file/],
    [['platform.rollback', 'version=1.0.0'], /unexpected argument version/],
    [['bad-key!=1'], /unknown operation|invalid argument name/],
  ])('rejects %j', (args, message) => {
    const r = run(...(args as string[]));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(message as RegExp);
  });
});
