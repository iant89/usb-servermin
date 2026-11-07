import { HttpError, defineModule, type HealthResult, type ModuleContext } from '@servermin/sdk';
import { CRITICAL_UNITS, SELF_UNITS, UNIT_RE, mergeUnits, parseJournal, parseListUnits, parseShow, parseUnitFiles } from './systemd';

const SHOW_PROPS = 'Id,Description,LoadState,ActiveState,SubState,UnitFileState,UnitFilePreset,MainPID,ActiveEnterTimestamp,InactiveEnterTimestamp,MemoryCurrent,CPUUsageNSec,TasksCurrent,FragmentPath,Restart,NRestarts,Result,User,After,Requires,WantedBy';

export default defineModule(() => {
  let ctx: ModuleContext;
  let failed = new Set<string>();
  let health: HealthResult = { status: 'HEALTHY' };

  async function systemctl(args: string[]) {
    const r = await ctx.process.execute({ command: 'systemctl', args: [...args, '--no-pager'], timeoutMs: 20_000 });
    if (r.exitCode !== 0 && !r.stdout) throw new HttpError(502, `systemctl ${args[0]} failed: ${r.stderr.trim()}`);
    return r.stdout;
  }

  async function list() {
    const [units, files] = await Promise.all([systemctl(['list-units', '--type=service', '--all', '--plain', '--no-legend']), systemctl(['list-unit-files', '--type=service', '--no-legend']).catch(() => '')]);
    return mergeUnits(parseListUnits(units), parseUnitFiles(files));
  }

  function unit(name: string) {
    const u = name.endsWith('.service') ? name : `${name}.service`;
    if (!UNIT_RE.test(u)) throw new HttpError(400, 'Invalid unit name');
    return u;
  }

  async function show(u: string) {
    const p = parseShow(await systemctl(['show', u, `--property=${SHOW_PROPS}`]));
    if (p.LoadState === 'not-found') throw new HttpError(404, `${u} does not exist`);
    return p;
  }

  async function checkFailures() {
    let units;
    try {
      units = await list();
    } catch (e) {
      health = { status: 'ERROR', message: /systemd|bus/i.test((e as Error).message) ? 'systemd is not running on this host' : (e as Error).message };
      return;
    }
    const now = new Set(units.filter((u) => u.active === 'failed').map((u) => u.unit));
    for (const u of now)
      if (!failed.has(u)) {
        ctx.events.publish('service.failed', { unit: u });
        if (ctx.config.get().notifyFailures) ctx.notifications.notify({ title: `${u} failed`, message: 'Open Services to see its logs.', tone: 'error', permission: 'services.read' });
      }
    failed = now;
    health = now.size ? { status: 'DEGRADED', message: `Failed: ${[...now].slice(0, 5).join(', ')}${now.size > 5 ? '…' : ''}` } : { status: 'HEALTHY' };
    ctx.events.publish('service.metrics', { metrics: [{ name: 'running', value: units.filter((x) => x.sub === 'running').length, unit: 'count' }, { name: 'failed', value: now.size, unit: 'count' }] });
  }

  return {
    async initialize(c) {
      ctx = c;
      const R = { permission: 'services.read' };
      ctx.http.get('/services', list, R);
      ctx.http.get('/summary', async () => {
        const l = await list();
        return { running: l.filter((u) => u.sub === 'running').length, failed: l.filter((u) => u.active === 'failed').map((u) => u.unit), total: l.length, enabled: l.filter((u) => u.enabled === 'enabled').length };
      }, R);
      ctx.http.get('/services/:unit', (req) => show(unit(req.params.unit)), R);
      ctx.http.get('/services/:unit/logs', async (req) => {
        const u = unit(req.params.unit);
        const lines = Math.min(Math.max(Number(req.query.lines) || 200, 1), 5000);
        const args = ['-u', u, '-o', 'json', '-n', String(lines), '--no-pager'];
        if (req.query.priority && /^[0-7]$/.test(req.query.priority)) args.push('-p', req.query.priority);
        if (req.query.since && /^[0-9A-Za-z :.+-]{1,40}$/.test(req.query.since)) args.push('--since', req.query.since);
        const r = await ctx.process.execute({ command: 'journalctl', args, timeoutMs: 20_000, maxOutputBytes: 16 * 1024 * 1024 });
        if (r.exitCode !== 0 && !r.stdout) throw new HttpError(502, r.stderr.trim() || 'journalctl failed (is the service user in the systemd-journal group?)');
        return parseJournal(r.stdout);
      }, R);

      for (const action of ['start', 'stop', 'restart', 'enable', 'disable'] as const) {
        ctx.http.post(`/services/:unit/${action}`, async (req) => {
          const u = unit(req.params.unit);
          const destructive = action === 'stop' || action === 'disable' || action === 'restart';
          if (destructive && SELF_UNITS.includes(u)) throw new HttpError(403, 'Server Control cannot stop or disable itself from its own interface');
          if (destructive && CRITICAL_UNITS.includes(u) && (req.body as any)?.confirm !== true)
            throw new HttpError(428, `${u} may be needed for remote access. Confirm to ${action} it.`, { reason: 'confirmation-required' });
          const r = await ctx.process.privileged(`service.${action}`, { unit: u }, { user: req.user });
          if (r.exitCode !== 0) throw new HttpError(502, r.stderr.trim() || `systemctl ${action} ${u} failed`);
          const evt = { start: 'started', stop: 'stopped', restart: 'restarted', enable: 'enabled', disable: 'disabled' }[action];
          ctx.events.publish(`service.${evt}`, { unit: u, by: req.user.username });
          return show(u).catch(() => ({ Id: u }));
        }, { permission: 'services.write', audit: `service.${action}` });
      }
      ctx.services.provide('services.systemd', {
        status: (name: string) => show(unit(name)),
        restart: async (name: string) => (await ctx.process.privileged('service.restart', { unit: unit(name) })).exitCode === 0,
        start: async (name: string) => (await ctx.process.privileged('service.start', { unit: unit(name) })).exitCode === 0,
        stop: async (name: string) => (await ctx.process.privileged('service.stop', { unit: unit(name) })).exitCode === 0,
        logs: async (name: string, lines = 200) => parseJournal((await ctx.process.execute({ command: 'journalctl', args: ['-u', unit(name), '-o', 'json', '-n', String(lines), '--no-pager'] })).stdout),
      });
      ctx.health.register(() => health);
    },
    async start() {
      await checkFailures();
      ctx.tasks.interval('failures', 30_000, checkFailures);
    },
  };
});
