import { describe, expect, it } from 'vitest';
import { createTestContext } from '@servermin/sdk/testing';
import manifest from '../module.json';
import storage from '../src/backend/index';
import { flatten, isAllowedMountTarget, isProtectedMount, parseFindmnt, parseLsblk, parseSmart } from '../src/backend/parse';

const LSBLK = JSON.stringify({
  blockdevices: [
    { name: 'sda', path: '/dev/sda', type: 'disk', size: 64e9, tran: 'usb', rm: true, model: 'USB Stick ', children: [
      { name: 'sda1', path: '/dev/sda1', type: 'part', size: 5e8, fstype: 'vfat', mountpoint: '/boot/efi' },
      { name: 'sda2', path: '/dev/sda2', type: 'part', size: 63e9, fstype: 'ext4', mountpoint: '/', fssize: 63e9, fsused: 1e10, fsavail: 5e10 },
    ] },
    { name: 'nvme0n1', path: '/dev/nvme0n1', type: 'disk', size: 512e9, tran: 'nvme', rota: false, children: [
      { name: 'nvme0n1p1', path: '/dev/nvme0n1p1', type: 'part', size: 512e9, fstype: 'ext4', label: 'data', mountpoint: null },
    ] },
  ],
});
const FINDMNT = JSON.stringify({
  filesystems: [
    { target: '/', source: '/dev/sda2', fstype: 'ext4', options: 'rw', size: 63e9, used: 1e10, avail: 5e10, 'use%': '16%', children: [
      { target: '/proc', source: 'proc', fstype: 'proc', options: 'rw' },
      { target: '/boot/efi', source: '/dev/sda1', fstype: 'vfat', options: 'rw', size: 5e8, used: 1e7, avail: 4.9e8, 'use%': '2%' },
    ] },
  ],
});

describe('storage parsers', () => {
  it('parses lsblk trees including the USB system disk', () => {
    const d = parseLsblk(LSBLK);
    expect(d[0]).toMatchObject({ transport: 'usb', removable: true, model: 'USB Stick' });
    expect(flatten(d).map((x) => x.name)).toEqual(['sda', 'sda1', 'sda2', 'nvme0n1', 'nvme0n1p1']);
  });
  it('drops pseudo file systems from findmnt', () => {
    expect(parseFindmnt(FINDMNT).map((m) => m.target)).toEqual(['/', '/boot/efi']);
  });
  it('protects system mounts and restricts mount targets', () => {
    expect(isProtectedMount('/boot/efi/')).toBe(true);
    expect(isProtectedMount('/mnt/data')).toBe(false);
    expect(isAllowedMountTarget('/mnt/data', ['/mnt'])).toBe(true);
    expect(isAllowedMountTarget('/mnt', ['/mnt'])).toBe(false);
    expect(isAllowedMountTarget('/mnt/../etc', ['/mnt'])).toBe(false);
    expect(isAllowedMountTarget('/etc/x', ['/mnt'])).toBe(false);
  });
  it('parses smartctl JSON', () => {
    expect(parseSmart(JSON.stringify({ smart_status: { passed: true }, temperature: { current: 38 }, ata_smart_attributes: { table: [{ name: 'Reallocated_Sector_Ct', raw: { value: 0 } }] } }))).toMatchObject({ passed: true, temperature: 38, reallocatedSectors: 0 });
  });
});

describe('storage module', () => {
  const commands = { lsblk: () => LSBLK, findmnt: () => FINDMNT };

  it('marks the disk holding / as the system disk', async () => {
    const t = createTestContext(manifest as any, { commands });
    await t.start(storage);
    const disks = (await t.request<any[]>('GET', '/disks')).body;
    expect(disks.find((d) => d.name === 'sda').system).toBe(true);
    expect(disks.find((d) => d.name === 'nvme0n1').system).toBe(false);
    expect((await t.request<any[]>('GET', '/mountable')).body.map((d) => d.path)).toEqual(['/dev/nvme0n1p1']);
    await t.stop();
  });

  it('mounts only to allowed locations and unmounts only with confirmation', async () => {
    const t = createTestContext(manifest as any, { commands });
    await t.start(storage);
    expect((await t.request('POST', '/mount', { body: { device: '/dev/nvme0n1p1', target: '/etc/data' } })).status).toBe(400);
    expect((await t.request('POST', '/mount', { body: { device: '/dev/sda2', target: '/mnt/x' } })).status).toBe(409);
    expect((await t.request('POST', '/mount', { body: { device: '/dev/nvme0n1p1', target: '/mnt/data' } })).status).toBe(200);
    expect(t.privileged.at(-1)).toMatchObject({ operation: 'storage.mount', args: { device: '/dev/nvme0n1p1', target: '/mnt/data', fstype: 'ext4' } });
    expect((await t.request('POST', '/unmount', { body: { target: '/boot/efi', confirm: true } })).status).toBe(403);
    expect((await t.request('POST', '/unmount', { body: { target: '/boot/efi' } })).status).toBe(428);
    await t.stop();
  });
});
