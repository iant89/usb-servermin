import { describe, expect, it } from 'vitest';
import { createTestContext } from '@servermin/sdk/testing';
import manifest from '../module.json';
import logs from '../src/backend/index';
import { journalArgs, parseJournalLine, toText } from '../src/backend/journal';

const LINE = (msg: string, prio = 6, unit = 'nginx.service') => JSON.stringify({ __REALTIME_TIMESTAMP: '1700000000000000', PRIORITY: String(prio), _SYSTEMD_UNIT: unit, _PID: '42', MESSAGE: msg });

describe('journal helpers', () => {
  it('builds safe journalctl arguments', () => {
    expect(journalArgs({ unit: 'nginx.service', priority: '3', search: 'a.b(c)', lines: 10 })).toEqual(['-o', 'json', '--no-pager', '-u', 'nginx.service', '-p', '3', '--grep', 'a\\.b\\(c\\)', '--case-sensitive=false', '-n', '10']);
    expect(() => journalArgs({ unit: 'x; rm -rf /' })).toThrow('Invalid unit');
    expect(() => journalArgs({ since: '$(id)' })).toThrow('Invalid since');
    expect(journalArgs({}, true).at(-1)).toBe('-f');
  });
  it('parses and exports entries', () => {
    const l = parseJournalLine(LINE('hello', 3))!;
    expect(l).toMatchObject({ priority: 'err', source: 'nginx.service', pid: 42, message: 'hello' });
    expect(toText([l])).toBe('2023-11-14T22:13:20.000Z ERR     nginx.service[42]: hello\n');
  });
});

describe('logs module', () => {
  it('queries the journal and exports a download', async () => {
    const t = createTestContext(manifest as any, { commands: { journalctl: () => [LINE('started'), LINE('failed', 3)].join('\n') } });
    await t.start(logs);
    const r = await t.request<any[]>('GET', '/journal', { query: { unit: 'nginx.service', priority: '3' } });
    expect(r.body.map((x) => x.message)).toEqual(['started', 'failed']);
    expect(t.executed[0].args).toContain('-p');
    expect((await t.request('GET', '/journal', { query: { unit: 'bad unit' } })).status).toBe(400);
    const ex = await t.request<string>('GET', '/export', { query: { unit: 'nginx.service' } });
    expect(ex.headers['content-disposition']).toMatch(/attachment; filename="logs-nginx.service-/);
    expect(ex.body).toContain('ERR     nginx.service[42]: failed');
    await t.stop();
  });

  it('reads container logs through the optional docker.engine service', async () => {
    const t = createTestContext(manifest as any, { services: { 'docker.engine': { containerLogs: () => ['2024-01-01T00:00:00Z ERROR boom', '2024-01-01T00:00:01Z ok'], listContainers: () => [] } } });
    await t.start(logs);
    const r = await t.request<any[]>('GET', '/docker/abc');
    expect(r.body.map((l) => l.priority)).toEqual(['err', 'info']);
    await t.stop();
    const t2 = createTestContext(manifest as any);
    await t2.start(logs);
    expect((await t2.request('GET', '/docker/abc')).status).toBe(503);
    await t2.stop();
  });
});
