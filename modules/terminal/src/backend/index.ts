import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError, defineModule, type ChannelSubscription, type ModuleContext, type ProcessHandle } from '@servermin/sdk';
import { PTY_BRIDGE } from './pty-bridge';

interface Session {
  sub: ChannelSubscription;
  handle: ProcessHandle;
  startedAt: number;
  lastActivity: number;
}

export default defineModule(() => {
  let ctx: ModuleContext;
  let bridge = '';
  const sessions = new Map<string, Session>();

  function end(id: string, reason: string) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    s.handle.kill('SIGHUP');
    ctx.audit.record({ action: 'terminal.session.end', user: s.sub.user, target: id.slice(0, 8), metadata: { reason, seconds: Math.round((Date.now() - s.startedAt) / 1000) } });
    ctx.events.publish('terminal.session.ended', { user: s.sub.user.username, reason });
  }

  return {
    async initialize(c) {
      ctx = c;
      bridge = join(ctx.module.dataDir, 'pty-bridge.py');
      await writeFile(bridge, PTY_BRIDGE, { mode: 0o600 });

      ctx.http.get('/sessions', () => [...sessions.values()].map((s) => ({ id: s.sub.id.slice(0, 8), user: s.sub.user.username, startedAt: new Date(s.startedAt).toISOString(), idleSeconds: Math.round((Date.now() - s.lastActivity) / 1000) })), { permission: 'terminal.access' });
      ctx.http.get('/status', async () => ({ available: !!(await ctx.process.which('python3')), shell: ctx.config.get().shell, sessions: sessions.size, maxSessions: ctx.config.get().maxSessions }), { permission: 'terminal.access' });

      ctx.channels.handle('session', {
        onSubscribe: async (sub) => {
          if (sessions.size >= Number(ctx.config.get().maxSessions)) throw new HttpError(429, 'Too many open terminal sessions');
          if (!(await ctx.process.which('python3'))) throw new HttpError(424, 'python3 is required for the terminal');
          const rows = Math.min(Math.max(Number(sub.params.rows) || 24, 5), 300);
          const cols = Math.min(Math.max(Number(sub.params.cols) || 80, 20), 500);
          const handle = await ctx.process.spawn(
            { command: 'python3', args: [bridge, String(ctx.config.get().shell), String(rows), String(cols)], control: true },
            {
              onStdout: (data) => {
                const s = sessions.get(sub.id);
                if (s) s.lastActivity = Date.now();
                ctx.channels.send(sub.id, { type: 'output', data });
              },
              onStderr: (data) => ctx.channels.send(sub.id, { type: 'output', data }),
              onExit: ({ exitCode }) => {
                ctx.channels.send(sub.id, { type: 'exit', code: exitCode });
                if (sessions.has(sub.id)) {
                  end(sub.id, 'shell-exited');
                  ctx.channels.close(sub.id, 'shell-exited');
                }
              },
            },
          );
          sessions.set(sub.id, { sub, handle, startedAt: Date.now(), lastActivity: Date.now() });
          ctx.audit.record({ action: 'terminal.session.start', user: sub.user, target: sub.id.slice(0, 8), metadata: { shell: ctx.config.get().shell } });
          ctx.events.publish('terminal.session.started', { user: sub.user.username });
        },
        onMessage: (sub, msg: any) => {
          const s = sessions.get(sub.id);
          if (!s || !msg || typeof msg !== 'object') return;
          s.lastActivity = Date.now();
          if (msg.type === 'input' && typeof msg.data === 'string' && msg.data.length <= 65536) s.handle.write(msg.data);
          else if (msg.type === 'resize') s.handle.control({ type: 'resize', rows: Number(msg.rows) || 24, cols: Number(msg.cols) || 80 });
        },
        onUnsubscribe: (sub) => end(sub.id, 'closed'),
      });
    },
    start() {
      ctx.tasks.interval('idle', 30_000, () => {
        const limit = Number(ctx.config.get().idleMinutes) * 60_000;
        for (const [id, s] of sessions)
          if (Date.now() - s.lastActivity > limit) {
            ctx.channels.send(id, { type: 'output', data: '\r\n[Session closed after inactivity]\r\n' });
            end(id, 'idle');
            ctx.channels.close(id, 'idle');
          }
      });
    },
    stop() {
      for (const id of [...sessions.keys()]) end(id, 'module-stopped');
    },
  };
});
