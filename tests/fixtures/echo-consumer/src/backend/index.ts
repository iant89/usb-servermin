import { defineModule } from '@servermin/sdk';

export default defineModule({
  initialize(ctx) {
    ctx.http.get('/echo', (req) => ctx.services.call('demo.echo', 'echo', req.query.v ?? 'hi'), { permission: 'echo-consumer.use' });
  },
});
