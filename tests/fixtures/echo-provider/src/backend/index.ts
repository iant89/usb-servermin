import { defineModule } from '@servermin/sdk';

export default defineModule({
  initialize(ctx) {
    ctx.services.provide('demo.echo', { echo: (v: unknown) => ({ echoed: v, by: ctx.module.id }) });
  },
});
