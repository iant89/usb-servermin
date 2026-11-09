import { stat } from 'node:fs/promises';
import { HttpError, defineModule, type HealthResult, type ModuleContext } from '@servermin/sdk';
import { flatten, isAllowedMountTarget, isProtectedMount, parseFindmnt, parseLsblk, parseSmart, type Mount } from './parse';

const LSBLK_COLUMNS = 'NAME,KNAME,PATH,TYPE,SIZE,FSTYPE,LABEL,UUID,MOUNTPOINT,MODEL,SERIAL,TRAN,RM,RO,HOTPLUG,ROTA,FSSIZE,FSUSED,FSAVAIL';

export default defineModule(() => {
  let ctx: ModuleContext;
  let previous = new Map<string, Mount>();
  let health: HealthResult = { status: 'HEALTHY' };

  async function run(command: string, args: string[]) {
    const r = await ctx.process.execute({ command, args, timeoutMs: 15_000 });
    if (r.exitCode !== 0) throw new HttpError(502, `${command} failed: ${r.stderr.trim() || r.exitCode}`);
    return r.stdout;
  }

  const disks = async () => parseLsblk(await run('lsblk', ['-J', '-b', '-o', LSBLK_COLUMNS]));
  const mounts = async () => parseFindmnt(await run('findmnt', ['-J', '-b', '-o', 'TARGET,SOURCE,FSTYPE,OPTIONS,SIZE,USED,AVAIL,USE%']));
  const roots = () => String(ctx.config.get().mountRoots ?? '').split(',').filter(Boolean);

  /** Which disk holds `/`? On a USB installation this is the boot stick, and it is never offered for mounting. */
  async function systemDevices() {
    const m = (await mounts()).find((x) => x.target === '/');
    return m ? m.source.replace(/\[.*\]$/, '') : null;
  }

  async function poll() {
    const current = new Map((await mounts()).map((m) => [m.target, m]));
    for (const [t, m] of current) if (!previous.has(t) && previous.size) ctx.events.publish('storage.mount.created', { target: t, source: m.source, fstype: m.fstype });
    for (const [t, m] of previous) if (!current.has(t)) ctx.events.publish('storage.mount.removed', { target: t, source: m.source });
    previous = current;
    const warn = Number(ctx.config.get().warnPercent);
    const full = [...current.values()].filter((m) => (m.usePercent ?? 0) >= warn);
    health = full.length ? { status: 'DEGRADED', message: `Almost full: ${full.map((m) => `${m.target} ${m.usePercent}%`).join(', ')}` } : { status: 'HEALTHY' };
    ctx.events.publish('storage.metrics', { metrics: [...current.values()].filter((m) => m.usePercent !== null).map((m) => ({ name: `usage${m.target === '/' ? '.root' : m.target.replace(/\//g, '.')}`, value: m.usePercent, unit: '%' })) });
  }

  return {
    async initialize(c) {
      ctx = c;
      const R = { permission: 'storage.read' };

      ctx.http.get('/disks', async () => {
        const [list, sys] = await Promise.all([disks(), systemDevices()]);
        const containsSystem = (d: ReturnType<typeof flatten>[number]): boolean => d.path === sys || d.children.some(containsSystem);
        return list.map((d) => ({ ...d, system: containsSystem(d) }));
      }, R);
      ctx.http.get('/mounts', async () => (await mounts()).map((m) => ({ ...m, protected: isProtectedMount(m.target) })), R);
      ctx.http.get('/summary', async () => {
        const m = await mounts();
        const list = await disks();
        return {
          disks: list.filter((d) => d.type === 'disk').length,
          capacity: list.filter((d) => d.type === 'disk').reduce((a, d) => a + d.size, 0),
          filesystems: m.filter((x) => x.size).map((x) => ({ target: x.target, size: x.size, used: x.used, usePercent: x.usePercent })),
          health,
        };
      }, R);
      ctx.http.get('/mountable', async () => {
        const sys = await systemDevices();
        return flatten(await disks()).filter((d) => d.fstype && !d.mountpoints.length && d.fstype !== 'swap' && d.path !== sys && !['LVM2_member', 'crypto_LUKS', 'linux_raid_member'].includes(d.fstype));
      }, R);
      ctx.http.get('/health/:device', async (req) => {
        const device = `/dev/${req.params.device}`;
        if (!/^\/dev\/[A-Za-z0-9]+$/.test(device)) throw new HttpError(400, 'Invalid device');
        const r = await ctx.process.privileged('storage.smart', { device }, { user: req.user });
        if (r.exitCode === 127) return { supported: false, message: 'smartmontools is not installed (sudo apt install smartmontools).' };
        if (r.stdout.startsWith('simulated')) return { supported: false, message: 'Health data is not available in simulated mode.' };
        try {
          return { supported: true, ...parseSmart(r.stdout) };
        } catch {
          return { supported: false, message: r.stderr.trim() || 'The device did not report S.M.A.R.T. data.' };
        }
      }, { permission: 'storage.read', timeoutMs: 60_000 });

      ctx.http.post('/mount', async (req) => {
        const { device, target, fstype, readonly } = (req.body ?? {}) as Record<string, unknown>;
        const all = flatten(await disks());
        const dev = all.find((d) => d.path === device);
        if (!dev) throw new HttpError(400, 'Unknown block device');
        if (dev.mountpoints.length) throw new HttpError(409, `${device} is already mounted at ${dev.mountpoints.join(', ')}`);
        if (dev.path === (await systemDevices())) throw new HttpError(409, 'The system disk cannot be mounted again');
        if (typeof target !== 'string' || !isAllowedMountTarget(target, roots())) throw new HttpError(400, `Mount points must be inside ${roots().join(', ')}`);
        const existing = await stat(target).catch(() => null);
        if (existing && !existing.isDirectory()) throw new HttpError(409, `${target} exists and is not a directory`);
        const args: Record<string, string> = { device: dev.path, target };
        if (fstype || dev.fstype) args.fstype = String(fstype || dev.fstype);
        if (readonly) args.readonly = 'true';
        const r = await ctx.process.privileged('storage.mount', args, { user: req.user });
        if (r.exitCode !== 0) throw new HttpError(502, r.stderr.trim() || 'mount failed');
        ctx.events.publish('storage.mount.created', { target, source: dev.path, fstype: args.fstype });
        await poll();
        return { mounted: true, target };
      }, { permission: 'storage.write', audit: 'storage.mount' });

      ctx.http.post('/unmount', async (req) => {
        const { target, confirm } = (req.body ?? {}) as Record<string, unknown>;
        if (typeof target !== 'string') throw new HttpError(400, 'target is required');
        if (confirm !== true) throw new HttpError(428, 'Unmounting needs explicit confirmation');
        if (isProtectedMount(target, [ctx.module.dataDir])) throw new HttpError(403, `${target} is required by the system and cannot be unmounted here`);
        if (!(await mounts()).some((m) => m.target === target)) throw new HttpError(404, `${target} is not mounted`);
        const r = await ctx.process.privileged('storage.unmount', { target }, { confirmed: true, user: req.user });
        if (r.exitCode !== 0) throw new HttpError(502, r.stderr.trim() || 'umount failed (is the file system in use?)');
        ctx.events.publish('storage.mount.removed', { target });
        await poll();
        return { unmounted: true, target };
      }, { permission: 'storage.write', audit: 'storage.unmount' });

      ctx.health.register(() => health);
    },
    async start() {
      await poll().catch((e) => ctx.logger.warn(`Initial scan failed: ${e.message}`));
      ctx.tasks.interval('poll', 15_000, poll);
    },
  };
});
