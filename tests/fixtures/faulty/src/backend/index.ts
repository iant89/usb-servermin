import { defineModule } from '@servermin/sdk';

export default defineModule(() => {
  let ctx: any;
  return {
    initialize(c) {
      ctx = c;
      c.http.get('/ok', () => ({ ok: true, pid: process.pid }), { permission: 'faulty.use' });
      // An uncaught exception inside the module's thread.
      c.http.post('/crash', () => {
        setTimeout(() => {
          throw new Error('boom');
        }, 10);
        return { crashing: true };
      }, { permission: 'faulty.use' });
      c.http.post('/leak', () => {
        const hog: number[][] = [];
        for (;;) hog.push(new Array(1e6).fill(1));
      }, { permission: 'faulty.use' });
      // The core refuses commands the manifest does not declare; the module must see that status.
      c.http.get('/undeclared', () => c.process.execute({ command: 'ls' }), { permission: 'faulty.use' });
      c.http.get('/slow', () => new Promise(() => undefined), { permission: 'faulty.use', timeoutMs: 500 });
    },
    start() {
      if (ctx.config.get().failOnStart) throw new Error('configured to fail on start');
    },
  };
});
