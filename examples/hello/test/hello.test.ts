import { describe, expect, it } from 'vitest';
import { createTestContext, testUser } from '@servermin/sdk/testing';
import manifest from '../module.json';
import hello from '../src/backend/index';

describe('hello module', () => {
  it('stores greetings, publishes an event and enforces permissions', async () => {
    const t = createTestContext(manifest as any);
    await t.start(hello);
    const r = await t.request<{ message: string }>('POST', '/greeting', { body: { name: 'Ada' } });
    expect(r.status).toBe(200);
    expect(r.body.message).toBe('Hello, Ada!');
    expect(t.published[0]).toMatchObject({ type: 'hello.greeted', payload: { name: 'Ada' } });
    const list = await t.request<{ recent: { name: string }[] }>('GET', '/greeting');
    expect(list.body.recent.map((x) => x.name)).toEqual(['Ada']);
    expect((await t.request('POST', '/greeting', { body: { name: 'x' }, user: testUser(['hello.read']) })).status).toBe(403);
    expect((await t.request('POST', '/greeting', { body: { name: '' } })).status).toBe(400);
    t.setConfig({ greeting: 'Hi' });
    expect((await t.request<{ message: string }>('GET', '/greeting')).body.message).toBe('Hi, world');
    await t.stop();
  });

  it('sends the current count to new channel subscribers', async () => {
    const t = createTestContext(manifest as any);
    await t.start(hello);
    const sub = await t.subscribe('ticks');
    expect(sub.messages).toEqual([{ count: 0 }]);
    await t.tick();
    expect(sub.messages.at(-1)).toEqual({ count: 1 });
    await t.stop();
  });
});
