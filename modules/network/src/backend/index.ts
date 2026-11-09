import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError, defineModule, type ModuleContext } from '@servermin/sdk';
import { parseIpAddr, parseResolvConf, parseResolvectl, parseRoutes, renderNetplan, validateConfig, type Interface, type InterfaceConfig } from './net';

export default defineModule(() => {
  let ctx: ModuleContext;
  let last = new Map<string, string>();
  let pending: { appliedAt: string; deadline: string; by: string; interfaces: string[]; previous: Record<string, InterfaceConfig> } | null = null;
  let pendingTimer: NodeJS.Timeout | null = null;

  async function ip(args: string[]) {
    const r = await ctx.process.execute({ command: 'ip', args: ['-j', ...args], timeoutMs: 10_000 });
    if (r.exitCode !== 0) throw new HttpError(502, `ip ${args.join(' ')} failed: ${r.stderr.trim()}`);
    return r.stdout;
  }

  async function interfaces(): Promise<Interface[]> {
    if (!(await ctx.process.which('ip'))) throw new HttpError(424, 'The ip command (iproute2) is not installed');
    const [addr, link] = await Promise.all([ip(['addr']), ip(['-s', 'link']).catch(() => undefined)]);
    return parseIpAddr(addr, link);
  }

  async function dns() {
    if (await ctx.process.which('resolvectl')) {
      const r = await ctx.process.execute({ command: 'resolvectl', args: ['dns'], timeoutMs: 5000 }).catch(() => null);
      if (r?.exitCode === 0) return { source: 'systemd-resolved', entries: parseResolvectl(r.stdout) };
    }
    const conf = parseResolvConf((await readFile('/etc/resolv.conf', 'utf8').catch(() => '')) ?? '');
    return { source: '/etc/resolv.conf', entries: [{ interface: null, servers: conf.servers }], search: conf.search };
  }

  async function managed(): Promise<Record<string, InterfaceConfig>> {
    const rows = await ctx.database.all<{ name: string; config: string }>('SELECT name, config FROM managed');
    return Object.fromEntries(rows.map((r) => [r.name, JSON.parse(r.config)]));
  }

  async function apply(configs: Record<string, InterfaceConfig>, by: string, changed: string[], previous: Record<string, InterfaceConfig>) {
    const file = join(ctx.module.dataDir, 'staged-netplan.yaml');
    await writeFile(file, renderNetplan(configs), { mode: 0o600 });
    const seconds = Number(ctx.config.get().rollbackSeconds);
    const r = await ctx.process.privileged('network.apply', { file, rollback: String(seconds) }, { confirmed: true, user: by });
    if (r.exitCode !== 0) throw new HttpError(502, `netplan rejected the configuration: ${(r.stderr || r.stdout).trim().slice(0, 1000)}`);
    pending = { appliedAt: new Date().toISOString(), deadline: new Date(Date.now() + seconds * 1000).toISOString(), by, interfaces: changed, previous };
    if (pendingTimer) clearTimeout(pendingTimer);
    // The helper rolls back on its own (a systemd timer), even if this process is gone.
    pendingTimer = setTimeout(async () => {
      if (!pending) return;
      ctx.logger.warn('Network change was not confirmed in time; the previous configuration was restored');
      await restoreRecords(pending.previous);
      ctx.notifications.notify({ title: 'Network change rolled back', message: 'It was not confirmed in time.', tone: 'warning', permission: 'network.read' });
      pending = null;
    }, seconds * 1000 + 2000);
  }

  async function restoreRecords(previous: Record<string, InterfaceConfig>) {
    await ctx.database.transaction([{ sql: 'DELETE FROM managed' }, ...Object.entries(previous).map(([name, c]) => ({ sql: 'INSERT INTO managed (name, config) VALUES (?, ?)', params: [name, JSON.stringify(c)] }))]);
  }

  async function poll() {
    const list = await interfaces().catch(() => []);
    const now = new Map(list.map((i) => [i.name, `${i.state}|${i.addresses.map((a) => `${a.address}/${a.prefix}`).join(',')}`]));
    if (last.size) {
      for (const [name, sig] of now) if (last.get(name) !== sig) ctx.events.publish('network.interface.changed', { name, change: last.has(name) ? 'updated' : 'added', state: sig.split('|')[0] });
      for (const name of last.keys()) if (!now.has(name)) ctx.events.publish('network.interface.changed', { name, change: 'removed' });
    }
    last = now;
    const rx = list.filter((i) => i.type !== 'loopback').reduce((a, i) => a + (i.stats?.rxBytes ?? 0), 0);
    const tx = list.filter((i) => i.type !== 'loopback').reduce((a, i) => a + (i.stats?.txBytes ?? 0), 0);
    ctx.events.publish('network.metrics', { metrics: [{ name: 'rx.bytes', value: rx, unit: 'bytes', counter: true }, { name: 'tx.bytes', value: tx, unit: 'bytes', counter: true }] });
  }

  return {
    async initialize(c) {
      ctx = c;
      await ctx.database.migrate([{ version: 1, name: 'managed interfaces', sql: 'CREATE TABLE managed (name TEXT PRIMARY KEY, config TEXT NOT NULL)' }]);
      const R = { permission: 'network.read' };

      ctx.http.get('/interfaces', async (req) => {
        const [list, cfg] = await Promise.all([interfaces(), managed()]);
        return list.map((i) => ({ ...i, managed: cfg[i.name] ?? null, servesThisSession: i.addresses.some((a) => a.address === req.host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')) }));
      }, R);
      ctx.http.get('/routes', async () => parseRoutes(await ip(['route'])).concat(parseRoutes(await ip(['-6', 'route']).catch(() => '[]'))), R);
      ctx.http.get('/dns', dns, R);
      ctx.http.get('/status', async () => {
        const routes = parseRoutes(await ip(['route']).catch(() => '[]'));
        const list = await interfaces().catch(() => []);
        return {
          gateway: routes.find((r: any) => r.destination === 'default') ?? null,
          up: list.filter((i) => i.state === 'up' && i.type !== 'loopback').map((i) => ({ name: i.name, addresses: i.addresses.filter((a) => a.scope === 'global').map((a) => `${a.address}/${a.prefix}`) })),
          pending,
        };
      }, R);
      ctx.http.get('/pending', () => pending, R);
      ctx.http.get('/preview', async () => ({ yaml: renderNetplan(await managed()) }), R);

      ctx.http.put('/interfaces/:name', async (req) => {
        if (pending) throw new HttpError(409, 'Confirm or roll back the pending network change first');
        const name = req.params.name;
        const list = await interfaces();
        const iface = list.find((i) => i.name === name);
        if (!iface) throw new HttpError(404, `No interface ${name}`);
        if (iface.type !== 'ethernet') throw new HttpError(400, `Only wired (ethernet) interfaces can be configured here; ${name} is ${iface.type}`);
        const body = (req.body ?? {}) as InterfaceConfig & { acknowledgeRisk?: boolean };
        const cfg: InterfaceConfig = {
          mode: body.mode,
          addresses: body.mode === 'static' ? (body.addresses ?? []).map((a) => String(a).trim()).filter(Boolean) : undefined,
          gateway: body.mode === 'static' && body.gateway ? String(body.gateway).trim() : undefined,
          dns: (body.dns ?? []).map((d) => String(d).trim()).filter(Boolean),
          dhcp6: !!body.dhcp6,
        };
        const problems = validateConfig(cfg);
        if (problems.length) throw new HttpError(400, 'The configuration is not valid', problems);
        // Protection against accidental loss of access (§32.4).
        const host = req.host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
        const carriesSession = iface.addresses.some((a) => a.address === host);
        const keepsAddress = cfg.mode === 'dhcp' || (cfg.addresses ?? []).some((a) => a.split('/')[0] === host);
        if (carriesSession && !keepsAddress && !body.acknowledgeRisk)
          throw new HttpError(409, `You are connected through ${name} (${host}). This change removes that address, so this page will lose its connection. Confirm the risk to continue; the change rolls back automatically unless you confirm it from the new address.`, { reason: 'connection-at-risk' });
        const previous = await managed();
        const next = { ...previous, [name]: cfg };
        await apply(next, req.user.username, [name], previous);
        await ctx.database.run('INSERT OR REPLACE INTO managed (name, config) VALUES (?, ?)', [name, JSON.stringify(cfg)]);
        ctx.events.publish('network.config.applied', { interface: name, mode: cfg.mode, by: req.user.username });
        return { pending, newAddress: cfg.mode === 'static' ? cfg.addresses?.[0]?.split('/')[0] : null };
      }, { permission: 'network.write', audit: 'network.configure', timeoutMs: 120_000 });

      ctx.http.delete('/interfaces/:name', async (req) => {
        if (pending) throw new HttpError(409, 'Confirm or roll back the pending network change first');
        const previous = await managed();
        if (!previous[req.params.name]) throw new HttpError(404, 'This interface is not managed by Server Control');
        const next = { ...previous };
        delete next[req.params.name];
        await apply(next, req.user.username, [req.params.name], previous);
        await ctx.database.run('DELETE FROM managed WHERE name = ?', [req.params.name]);
        return { pending };
      }, { permission: 'network.write', audit: 'network.unmanage', timeoutMs: 120_000 });

      ctx.http.post('/confirm', async (req) => {
        if (!pending) throw new HttpError(409, 'There is no pending network change');
        const r = await ctx.process.privileged('network.confirm', {}, { user: req.user });
        if (r.exitCode !== 0) throw new HttpError(502, r.stderr.trim() || 'Could not cancel the rollback');
        if (pendingTimer) clearTimeout(pendingTimer);
        pending = null;
        ctx.events.publish('network.config.confirmed', { by: req.user.username });
        return { confirmed: true };
      }, { permission: 'network.write', audit: 'network.confirm' });

      ctx.http.post('/rollback', async (req) => {
        const r = await ctx.process.privileged('network.rollback', {}, { user: req.user });
        if (r.exitCode !== 0) throw new HttpError(502, r.stderr.trim() || 'Rollback failed');
        if (pending) await restoreRecords(pending.previous);
        if (pendingTimer) clearTimeout(pendingTimer);
        pending = null;
        return { rolledBack: true };
      }, { permission: 'network.write', audit: 'network.rollback', timeoutMs: 120_000 });

      ctx.health.register(async () => {
        const list = await interfaces().catch(() => null);
        if (!list) return { status: 'DEGRADED', message: 'Cannot read interfaces' };
        return list.some((i) => i.state === 'up' && i.type !== 'loopback' && i.addresses.some((a) => a.scope === 'global'))
          ? { status: 'HEALTHY' }
          : { status: 'DEGRADED', message: 'No interface has a global address' };
      });
    },
    async start() {
      await poll();
      ctx.tasks.interval('poll', 10_000, poll);
    },
    stop() {
      if (pendingTimer) clearTimeout(pendingTimer);
    },
  };
});
