import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, EventBus } from '@servermin/core';
import { Inventory, InventoryError, MANAGER_MIGRATIONS, defaultManagerConfig, loadManagerConfig } from '../src/index';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'manager-test-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('manager configuration', () => {
  const load = (content: unknown, env: Record<string, string> = {}) => {
    const file = join(dir, 'config.json');
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return loadManagerConfig({ SERVERMIN_MANAGER_CONFIG: file, ...env });
  };

  it('works without a file and keeps away from the agent: other port, other data directory', () => {
    const c = loadManagerConfig({ SERVERMIN_MANAGER_CONFIG: join(dir, 'missing.json') });
    expect(c).toEqual(defaultManagerConfig());
    expect(c.http.port).toBe(8480);
    expect(c.paths.data).toBe('/var/lib/servermin-manager');
  });

  it('merges the file over the defaults and lets the environment win', () => {
    const c = load({ http: { port: 9000 }, logging: { level: 'DEBUG' } }, { SERVERMIN_MANAGER_PORT: '9100', SERVERMIN_MANAGER_DATA_DIR: dir });
    expect(c.http).toMatchObject({ port: 9100, host: '0.0.0.0', trustProxy: false });
    expect(c.logging.level).toBe('DEBUG');
    expect(c.paths.data).toBe(dir);
  });

  it.each([
    [{ http: { port: 70000 } }, /http\.port/],
    [{ http: { port: 'eighty' } }, /http\.port/],
    [{ paths: { data: 'relative/dir' } }, /paths\.data/],
    [{ logging: { level: 'LOUD' } }, /logging\.level/],
    [{ auth: { sessionHours: 0 } }, /auth\.sessionHours/],
    [{ http: { tls: { cert: 'cert.pem', key: '/k.pem' } } }, /http\.tls/],
    ['{ not json', /not valid JSON/],
    ['[]', /must contain a JSON object/],
  ])('rejects %j with a message that names the setting', (content, message) => {
    expect(() => load(content)).toThrow(message);
  });
});

describe('inventory', () => {
  let db: Database;
  let inventory: Inventory;
  let events: string[];
  beforeEach(() => {
    db = new Database(join(dir, 'manager.db'));
    db.migrate(MANAGER_MIGRATIONS);
    const bus = new EventBus();
    events = [];
    bus.subscribe('inventory.**', (e) => events.push(`${e.type}:${(e.payload as any).server.name}`), 'test');
    inventory = new Inventory(db, bus);
  });
  afterEach(() => db.close());

  it('adds a server in state UNKNOWN with a generated id, and announces it', () => {
    const s = inventory.create({ name: '  Saturn ', hostname: 'Saturn.LAN', description: 'compute' });
    expect(s).toMatchObject({ name: 'Saturn', hostname: 'saturn.lan', description: 'compute', state: 'UNKNOWN', agentId: null, agentVersion: null, lastSeenAt: null });
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(inventory.get(s.id)).toEqual(s);
    expect(inventory.count()).toEqual({ total: 1, byState: { UNKNOWN: 1 } });
    expect(events).toEqual(['inventory.server.created:Saturn']);
  });

  it('accepts the server id an agent reports, once', () => {
    const id = '0b9f3c1e-2d4a-4f6b-8c7d-9e0f1a2b3c4d';
    expect(inventory.create({ name: 'Jupiter', id }).id).toBe(id);
    expect(() => inventory.create({ name: 'Other', id })).toThrow(/id already exists/);
    expect(() => inventory.create({ name: 'Other', id: 'jupiter' })).toThrow(/UUID/);
    expect(inventory.list().map((s) => s.name)).toEqual(['Jupiter']);
  });

  it.each([
    [{ name: '' }, /name/],
    [{ name: '   ' }, /name/],
    [{ name: 'x'.repeat(65) }, /name/],
    [{ name: 'bad\u0000name' }, /name/],
    [{ name: 42 }, /name/],
    [{ name: 'ok', hostname: 'not a host' }, /hostname/],
    [{ name: 'ok', hostname: '-leading.example' }, /hostname/],
    [{ name: 'ok', hostname: 'a'.repeat(64) }, /hostname/],
    [{ name: 'ok', description: 'x'.repeat(501) }, /description/],
    [{ name: 'ok', description: { html: true } }, /description/],
  ])('refuses %j and stores nothing', (input, message) => {
    expect(() => inventory.create(input as any)).toThrow(message);
    expect(inventory.list()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('keeps names unique regardless of case', () => {
    const a = inventory.create({ name: 'Pluto' });
    const b = inventory.create({ name: 'Earth' });
    expect(() => inventory.create({ name: 'pluto' })).toThrow(/already exists/);
    expect(() => inventory.update(b.id, { name: 'PLUTO' })).toThrow(/already exists/);
    expect(inventory.update(a.id, { name: 'PLUTO' }).name).toBe('PLUTO');
  });

  it('updates only the given fields, clears a hostname with null, and stays silent when nothing changes', () => {
    const s = inventory.create({ name: 'Saturn', hostname: 'saturn.lan', description: 'compute' });
    events.length = 0;
    expect(inventory.update(s.id, { description: 'gpu' })).toMatchObject({ name: 'Saturn', hostname: 'saturn.lan', description: 'gpu' });
    expect(inventory.update(s.id, { hostname: null })).toMatchObject({ hostname: null, description: 'gpu' });
    const before = inventory.get(s.id)!;
    expect(inventory.update(s.id, { description: 'gpu' })).toEqual(before);
    expect(events).toEqual(['inventory.server.updated:Saturn', 'inventory.server.updated:Saturn']);
  });

  it('answers 404 for an unknown or malformed id on read, update and remove', () => {
    for (const id of ['0b9f3c1e-2d4a-4f6b-8c7d-9e0f1a2b3c4d', "' OR 1=1 --", '']) {
      for (const fn of [() => inventory.require(id), () => inventory.update(id, { name: 'x' }), () => inventory.remove(id)]) {
        expect(fn).toThrow(expect.objectContaining({ status: 404 }) as InventoryError);
      }
    }
  });

  it('removes a server and announces it', () => {
    const s = inventory.create({ name: 'Saturn' });
    expect(inventory.remove(s.id).id).toBe(s.id);
    expect(inventory.get(s.id)).toBeUndefined();
    expect(events.at(-1)).toBe('inventory.server.removed:Saturn');
  });

  it('never reports a state it does not know', () => {
    const s = inventory.create({ name: 'Saturn' });
    db.run("UPDATE servers SET state = 'HACKED' WHERE id = ?", [s.id]);
    expect(inventory.get(s.id)!.state).toBe('UNKNOWN');
  });
});
