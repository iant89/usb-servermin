import { HttpError, defineModule, type ModuleContext, type ProcessHandle } from '@servermin/sdk';
import { journalArgs, parseJournalLine, toText, type JournalQuery, type LogLine } from './journal';

export default defineModule(() => {
  let ctx: ModuleContext;
  const streams = new Map<string, ProcessHandle>();

  function query(q: Record<string, string>): JournalQuery {
    return {
      unit: q.unit || undefined,
      priority: q.priority || undefined,
      since: q.since || undefined,
      until: q.until || undefined,
      search: q.search || undefined,
      boot: q.boot === 'true',
      lines: Math.min(Math.max(Number(q.lines) || 500, 1), Number(ctx.config.get().maxLines)),
    };
  }

  async function journal(q: JournalQuery): Promise<LogLine[]> {
    let args: string[];
    try {
      args = journalArgs(q);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const r = await ctx.process.execute({ command: 'journalctl', args, timeoutMs: 30_000, maxOutputBytes: 32 * 1024 * 1024 });
    if (r.exitCode !== 0 && !r.stdout) {
      if (r.exitCode === 1 && !r.stderr.trim()) return [];
      throw new HttpError(502, r.stderr.trim() || 'journalctl failed. Add the service user to the systemd-journal group to read all logs.');
    }
    return r.stdout.split('\n').filter(Boolean).map(parseJournalLine).filter((l): l is LogLine => !!l);
  }

  async function dockerLogs(id: string, tail: number, search?: string) {
    if (!(await ctx.services.available('docker.engine'))) throw new HttpError(503, 'The Docker module is not active', { reason: 'dependency-unavailable' });
    const lines = await ctx.services.call<string[]>('docker.engine', 'containerLogs', id, tail);
    const s = search?.toLowerCase();
    return lines
      .map((l) => {
        const i = l.indexOf(' ');
        return { time: l.slice(0, i), priority: /\b(error|fatal|panic|exception)\b/i.test(l) ? 'err' : /\bwarn(ing)?\b/i.test(l) ? 'warning' : 'info', source: id.slice(0, 12), pid: null, message: l.slice(i + 1) } as LogLine;
      })
      .filter((l) => !s || l.message.toLowerCase().includes(s));
  }

  return {
    async initialize(c) {
      ctx = c;
      const R = { permission: 'logs.read' };
      ctx.http.get('/journal', (req) => journal(query(req.query)), { ...R, timeoutMs: 45_000 });
      ctx.http.get('/units', async () => {
        const r = await ctx.process.execute({ command: 'journalctl', args: ['-F', '_SYSTEMD_UNIT', '--no-pager'], timeoutMs: 20_000 });
        return r.stdout.split('\n').filter((u) => u && u.length < 200).sort();
      }, R);
      ctx.http.get('/containers', async () => ((await ctx.services.available('docker.engine')) ? ctx.services.call<any[]>('docker.engine', 'listContainers') : []), R);
      ctx.http.get('/docker/:id', (req) => dockerLogs(req.params.id, Math.min(Number(req.query.lines) || 500, 10_000), req.query.search), R);
      ctx.http.get('/export', async (req) => {
        const lines = req.query.container ? await dockerLogs(req.query.container, 10_000, req.query.search) : await journal({ ...query(req.query), lines: Number(ctx.config.get().maxLines) });
        const json = req.query.format === 'json';
        const name = `logs-${(req.query.unit || req.query.container || 'system').replace(/[^A-Za-z0-9_.-]/g, '_')}-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.${json ? 'json' : 'log'}`;
        return { status: 200, raw: true, body: json ? JSON.stringify(lines, null, 1) : toText(lines), headers: { 'content-type': json ? 'application/json' : 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` } };
      }, { ...R, timeoutMs: 60_000 });

      ctx.channels.handle('stream', {
        onSubscribe: async (sub) => {
          let args: string[];
          try {
            args = journalArgs({ unit: sub.params.unit as string | undefined, priority: sub.params.priority as string | undefined, lines: 50 }, true);
          } catch (e) {
            throw new HttpError(400, (e as Error).message);
          }
          let buf = '';
          const handle = await ctx.process.spawn({ command: 'journalctl', args }, {
            onStdout: (chunk) => {
              buf += chunk;
              const parts = buf.split('\n');
              buf = parts.pop() ?? '';
              const entries = parts.map(parseJournalLine).filter(Boolean);
              if (entries.length) ctx.channels.send(sub.id, entries);
            },
            onExit: () => ctx.channels.close(sub.id, 'stream-ended'),
          });
          streams.set(sub.id, handle);
        },
        onUnsubscribe: (sub) => {
          streams.get(sub.id)?.kill();
          streams.delete(sub.id);
        },
      });
      ctx.health.register(async () => ((await ctx.process.which('journalctl')) ? { status: 'HEALTHY' } : { status: 'DEGRADED', message: 'journalctl is not installed' }));
    },
    stop() {
      for (const s of streams.values()) s.kill();
      streams.clear();
    },
  };
});
