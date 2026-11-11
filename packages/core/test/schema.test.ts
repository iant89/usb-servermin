import { describe, expect, it } from 'vitest';
import { ACCOUNT_SCHEMA, AUDIT_SCHEMA, CORE_MIGRATIONS, Database, KV_SCHEMA } from '../src/database/database';

/** The core schema is assembled from shared fragments; an installed server must see no difference. */
describe('core schema', () => {
  it('creates exactly the tables and indexes of version 1.0.0', () => {
    const db = new Database(':memory:');
    db.migrate(CORE_MIGRATIONS);
    const objects = db.all<{ type: string; name: string }>("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").map((o) => `${o.type} ${o.name}`);
    expect(objects).toEqual([
      'index audit_log_timestamp',
      'index logs_module',
      'index logs_timestamp',
      'table _migrations',
      'table api_tokens',
      'table audit_log',
      'table kv',
      'table logs',
      'table module_config',
      'table module_registry',
      'table notifications',
      'table sessions',
      'table users',
    ]);
    const cols = (t: string) => db.all<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => c.name);
    expect(cols('users')).toEqual(['id', 'username', 'display_name', 'password_hash', 'permissions', 'disabled', 'notification_cursor', 'created_at', 'last_login_at']);
    expect(cols('sessions')).toEqual(['id_hash', 'user_id', 'created_at', 'expires_at', 'last_seen_at', 'ip', 'user_agent']);
    expect(cols('api_tokens')).toEqual(['id', 'user_id', 'name', 'token_hash', 'prefix', 'created_at', 'last_used_at', 'expires_at']);
    expect(cols('audit_log')).toEqual(['id', 'timestamp', 'user', 'action', 'module', 'target', 'result', 'metadata', 'ip']);
    db.close();
  });

  it('offers the account, audit and key-value tables on their own', () => {
    const db = new Database(':memory:');
    db.exec(ACCOUNT_SCHEMA + AUDIT_SCHEMA + KV_SCHEMA);
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((t) => t.name);
    expect(tables).toEqual(['api_tokens', 'audit_log', 'kv', 'sessions', 'users']);
    db.close();
  });
});
