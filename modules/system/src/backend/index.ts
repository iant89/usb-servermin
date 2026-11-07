import os from 'node:os';
import { HttpError, defineModule, type ModuleContext, type ModuleRequest } from '@servermin/sdk';
import { CpuSampler, ProcessSampler, drmGpus, parseAptUpgradable, parseCpuinfo, parseKeyValue, parseLspciGpus, parseMeminfo, read } from './proc';

function requireConfirm(req: ModuleRequest) {
  if ((req.body as { confirm?: unknown })?.confirm !== true) throw new HttpError(428, 'This action needs explicit confirmation ({"confirm": true})');
}

function check(result: { exitCode: number | null; stderr: string; stdout: string }, what: string) {
  if (result.exitCode !== 0) throw new HttpError(502, `${what} failed: ${(result.stderr || result.stdout).trim().slice(0, 500) || `exit ${result.exitCode}`}`);
  return result;
}

export default defineModule(() => {
  let ctx: ModuleContext;
  const cpu = new CpuSampler();
  const procs = new ProcessSampler();
  let lastMetrics: Record<string, unknown> | null = null;
  let stopMetrics: (() => void) | null = null;

  async function metrics() {
    const mem = parseMeminfo((await read('/proc/meminfo')) ?? '');
    const sample = { timestamp: new Date().toISOString(), cpuPercent: await cpu.sample(), memory: mem, load: os.loadavg(), uptimeSeconds: Math.round(os.uptime()) };
    lastMetrics = sample;
    return sample;
  }

  async function time() {
    const r = await ctx.process.execute({ command: 'timedatectl', args: ['show'], timeoutMs: 5000 }).catch(() => null);
    const kv = r?.exitCode === 0 ? parseKeyValue(r.stdout) : {};
    return {
      now: new Date().toISOString(),
      timezone: kv.Timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      ntp: kv.NTP ? kv.NTP === 'yes' : null,
      synchronized: kv.NTPSynchronized ? kv.NTPSynchronized === 'yes' : null,
      rtcInLocalTime: kv.LocalRTC ? kv.LocalRTC === 'yes' : null,
    };
  }

  async function info() {
    const [osRelease, cpuinfo, meminfo, machineId, dmi, virt] = await Promise.all([
      read('/etc/os-release'),
      read('/proc/cpuinfo'),
      read('/proc/meminfo'),
      read('/etc/machine-id'),
      Promise.all(['sys_vendor', 'product_name', 'product_version', 'board_vendor', 'board_name', 'bios_vendor', 'bios_version', 'chassis_type'].map(async (k) => [k, await read(`/sys/class/dmi/id/${k}`)] as const)),
      read('/sys/hypervisor/type'),
    ]);
    const rel = parseKeyValue(osRelease ?? '');
    let gpus = await drmGpus();
    if (await ctx.process.which('lspci')) {
      const r = await ctx.process.execute({ command: 'lspci', args: ['-mm'], timeoutMs: 5000 }).catch(() => null);
      if (r?.exitCode === 0) gpus = parseLspciGpus(r.stdout);
    }
    const cpuInfo = parseCpuinfo(cpuinfo ?? '');
    return {
      hostname: os.hostname(),
      os: { name: rel.PRETTY_NAME ?? os.type(), id: rel.ID, version: rel.VERSION_ID, codename: rel.VERSION_CODENAME },
      kernel: os.release(),
      arch: os.arch(),
      bootedAt: new Date(Date.now() - os.uptime() * 1000).toISOString(),
      uptimeSeconds: Math.round(os.uptime()),
      load: os.loadavg(),
      cpu: { ...cpuInfo, virtualized: cpuInfo.flags.includes('hypervisor') || !!virt },
      memory: parseMeminfo(meminfo ?? ''),
      gpus,
      hardware: { machineId, ...Object.fromEntries(dmi.filter(([, v]) => v)) },
      network: Object.entries(os.networkInterfaces())
        .filter(([n]) => n !== 'lo')
        .map(([name, addrs]) => ({ name, mac: addrs?.[0]?.mac, addresses: (addrs ?? []).map((a) => `${a.address}/${a.netmask}`) })),
      time: await time(),
    };
  }

  return {
    async initialize(c) {
      ctx = c;
      const read_ = { permission: 'system.read' };

      ctx.http.get('/info', info, read_);
      ctx.http.get('/metrics', () => lastMetrics ?? metrics(), read_);
      ctx.http.get('/processes', async (req) => {
        const sort = req.query.sort === 'memory' ? 'memory' : 'cpu';
        const limit = Math.min(Number(req.query.limit) || 100, 1000);
        const search = (req.query.search ?? '').toLowerCase();
        let list = await procs.list();
        if (search) list = list.filter((p) => p.command.toLowerCase().includes(search) || p.user.toLowerCase().includes(search) || String(p.pid) === search);
        list.sort((a, b) => (sort === 'memory' ? b.rssBytes - a.rssBytes : b.cpuPercent - a.cpuPercent || b.rssBytes - a.rssBytes));
        return { total: list.length, processes: list.slice(0, limit) };
      }, read_);
      ctx.http.get('/time', time, read_);
      ctx.http.get('/timezones', async () => {
        const r = await ctx.process.execute({ command: 'timedatectl', args: ['list-timezones'], timeoutMs: 5000 }).catch(() => null);
        return r?.exitCode === 0 ? r.stdout.split('\n').filter(Boolean) : (Intl as any).supportedValuesOf?.('timeZone') ?? ['UTC'];
      }, read_);

      ctx.http.get('/updates', async () => {
        if (!(await ctx.process.which('apt'))) return { supported: false, packages: [] };
        const r = check(await ctx.process.execute({ command: 'apt', args: ['list', '--upgradable'], timeoutMs: 60_000 }), 'apt list');
        const packages = parseAptUpgradable(r.stdout);
        return { supported: true, packages, security: packages.filter((p) => p.security).length, rebootRequired: (await read('/var/run/reboot-required')) !== null };
      }, read_);
      ctx.http.post('/updates/refresh', async (req) => {
        check(await ctx.process.privileged('packages.refresh', {}, { user: req.user }), 'apt-get update');
        return { ok: true };
      }, { permission: 'system.update', audit: 'system.updates.refresh', timeoutMs: 600_000 });
      ctx.http.post('/updates/upgrade', async (req) => {
        requireConfirm(req);
        const r = check(await ctx.process.privileged('packages.upgrade', {}, { confirmed: true, user: req.user }), 'apt-get upgrade');
        ctx.notifications.notify({ title: 'Package upgrade finished', tone: 'success', permission: 'system.read' });
        return { ok: true, output: r.stdout.slice(-4000) };
      }, { permission: 'system.update', audit: 'system.updates.upgrade', timeoutMs: 30 * 60_000 });

      ctx.http.put('/hostname', async (req) => {
        const hostname = String((req.body as any)?.hostname ?? '').trim();
        if (!/^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/.test(hostname)) throw new HttpError(400, 'Use 1-63 letters, digits and hyphens (not at the start or end)');
        check(await ctx.process.privileged('system.set-hostname', { hostname }, { user: req.user }), 'Setting the hostname');
        ctx.events.publish('system.hostname.changed', { hostname });
        return { hostname };
      }, { permission: 'system.write', audit: 'system.hostname.set' });
      ctx.http.put('/timezone', async (req) => {
        const timezone = String((req.body as any)?.timezone ?? '');
        if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(timezone)) throw new HttpError(400, 'Invalid time zone');
        check(await ctx.process.privileged('system.set-timezone', { timezone }, { user: req.user }), 'Setting the time zone');
        return time();
      }, { permission: 'system.write', audit: 'system.timezone.set' });
      ctx.http.put('/ntp', async (req) => {
        const enabled = (req.body as any)?.enabled === true;
        check(await ctx.process.privileged('system.set-ntp', { enabled: String(enabled) }, { user: req.user }), 'Changing time synchronisation');
        return time();
      }, { permission: 'system.write', audit: 'system.ntp.set' });

      for (const action of ['reboot', 'shutdown'] as const) {
        ctx.http.post(`/power/${action}`, async (req) => {
          requireConfirm(req);
          ctx.logger.warn(`${action} requested by ${req.user.username}`);
          ctx.events.publish(`system.power.${action}`, { by: req.user.username });
          // Reply first: the request would otherwise never complete.
          setTimeout(() => void ctx.process.privileged(action === 'reboot' ? 'power.reboot' : 'power.shutdown', {}, { confirmed: true, user: req.user }).catch((e) => ctx.logger.error(`${action} failed: ${e.message}`)), 500);
          return { ok: true, message: action === 'reboot' ? 'The server is rebooting.' : 'The server is shutting down.' };
        }, { permission: 'system.power', audit: `system.power.${action}` });
      }

      ctx.channels.handle('metrics', {
        onSubscribe: async (sub) => {
          ctx.channels.send(sub.id, lastMetrics ?? (await metrics()));
          if (!stopMetrics) stopMetrics = ctx.tasks.interval('live-metrics', Number(ctx.config.get().metricsIntervalMs), async () => ctx.channels.broadcast('metrics', await metrics()));
        },
        onUnsubscribe: () => {
          if (ctx.channels.subscriberCount('metrics') === 0 && stopMetrics) {
            stopMetrics();
            stopMetrics = null;
          }
        },
      });

      ctx.services.provide('system.info', { summary: async () => ({ hostname: os.hostname(), ...(await metrics()) }) });
      ctx.health.register(async () => ((await read('/proc/meminfo')) ? { status: 'HEALTHY' } : { status: 'DEGRADED', message: '/proc is not readable' }));
    },
    async start() {
      await metrics();
      ctx.tasks.interval('metrics-event', Number(ctx.config.get().eventIntervalMs), async () => {
        const m = await metrics();
        ctx.events.publish('system.metrics.updated', m);
      });
    },
  };
});
