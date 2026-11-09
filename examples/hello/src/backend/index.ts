import { HttpError, defineModule, type ModuleContext } from '@servermin/sdk';

/** The smallest useful module: one table, two routes, one channel, one event. */
export default defineModule(() => {
  let ctx: ModuleContext;
  let count = 0;
  return {
    async initialize(context) {
      ctx = context;
      await ctx.database.migrate([{ version: 1, name: 'greetings', sql: 'CREATE TABLE greetings (id INTEGER PRIMARY KEY, name TEXT NOT NULL, at TEXT NOT NULL)' }]);

      ctx.http.get('/greeting', async () => {
        const last = await ctx.database.all<{ name: string; at: string }>('SELECT name, at FROM greetings ORDER BY id DESC LIMIT 10');
        return { message: `${ctx.config.get().greeting}, world`, recent: last };
      }, { permission: 'hello.read' });

      ctx.http.post('/greeting', async (req) => {
        const name = (req.body as { name?: unknown })?.name;
        if (typeof name !== 'string' || !name.trim() || name.length > 60) throw new HttpError(400, 'name must be 1-60 characters');
        await ctx.database.run('INSERT INTO greetings (name, at) VALUES (?, ?)', [name.trim(), new Date().toISOString()]);
        ctx.events.publish('hello.greeted', { name: name.trim(), by: req.user.username });
        return { message: `${ctx.config.get().greeting}, ${name.trim()}!` };
      }, { permission: 'hello.write', audit: 'hello.greet' });

      ctx.channels.handle('ticks', { onSubscribe: (sub) => ctx.channels.send(sub.id, { count }) });
      ctx.health.register(() => ({ status: 'HEALTHY', details: { count } }));
    },
    start() {
      const schedule = () => ctx.tasks.interval('tick', Number(ctx.config.get().tickMs), () => ctx.channels.broadcast('ticks', { count: ++count }));
      schedule();
      ctx.config.onChange((_, keys) => keys.includes('tickMs') && schedule());
      ctx.logger.info('Hello module started');
    },
    stop() {
      ctx.logger.info('Hello module stopping');
    },
  };
});
