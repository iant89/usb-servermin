# Module development

A module extends the platform without modifying the core. The built-in modules use exactly the
same API described here (§58).

## Layout

```
my-module/
  module.json
  src/backend/index.ts      → dist/backend.js   (ESM, runs in a worker thread)
  src/frontend/index.tsx    → dist/frontend.js  (IIFE, loaded by the shell)
  test/my-module.test.ts
```

Build with `node tools/build-module.mjs my-module` (add `--watch --dev` while developing, or
`--pack` to produce `release/modules/<id>-<version>.tgz` with an `integrity.json`).

## Manifest (`module.json`)

| Field | Meaning |
| --- | --- |
| `id` | `^[a-z][a-z0-9-]{1,47}$`, unique |
| `name`, `description`, `author`, `license`, `homepage` | Shown in the Module Manager |
| `version` | Semantic version of the module |
| `apiVersion` | Module API major version; this core implements `1` |
| `coreVersion` | Semver range of supported core versions |
| `dependencies` | `{ "<module-id>": "<range>" }` |
| `requires` | `[{ "capability": "docker.engine", "optional": true }]` |
| `provides` | Services this module offers through `ctx.services.provide` |
| `capabilities` | Descriptive tags |
| `permissions` | `[{ "id": "my-module.read", "description": "…" }]`; core namespaces (`modules`, `users`, `audit`, `platform`, `core`, `auth`) are reserved |
| `channels` | `[{ "name": "live", "permission": "my-module.read" }]` → clients subscribe to `my-module.live` |
| `events.publishes` | Extra event namespaces besides the module id |
| `host.commands` | Executables the module may run (`"ip"`, `"/usr/bin/foo"`) |
| `host.privileged` | Catalogued privileged operations the module may request |
| `config` | Settings schema: `{ key, type: string|number|boolean|enum|secret, label, description, default, required, min, max, options, pattern }` |
| `backend` | `{ "entry": "dist/backend.js", "maxMemoryMb": 128 }` |
| `frontend` | `{ "entry": "dist/frontend.js", "style": "dist/frontend.css" }` |

The installer validates the manifest, compatibility, dependencies (including cycles),
permissions, referenced files and package integrity before any module code runs.

## Backend

```ts
import { HttpError, defineModule, type ModuleContext } from '@servermin/sdk';

export default defineModule(() => {
  let ctx: ModuleContext;
  return {
    async initialize(c) {
      ctx = c;
      await ctx.database.migrate([{ version: 1, name: 'items', sql: 'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)' }]);
      ctx.http.get('/items', () => ctx.database.all('SELECT * FROM items'), { permission: 'my-module.read' });
      ctx.http.post('/items', async (req) => {
        if (!req.body?.name) throw new HttpError(400, 'name is required');
        await ctx.database.run('INSERT INTO items (name) VALUES (?)', [req.body.name]);
        ctx.events.publish('my-module.item.created', { name: req.body.name });
      }, { permission: 'my-module.write', audit: 'my-module.item.create' });
    },
    start() {
      ctx.tasks.interval('refresh', 60_000, async () => { /* background work */ });
    },
    stop() { /* optional: ctx.signal is aborted and intervals are cleared for you */ },
  };
});
```

### `ModuleContext`

| API | Purpose |
| --- | --- |
| `module` | `{ id, version, manifest, dataDir }` |
| `logger` | `debug/info/warn/error(message, metadata)` — stored centrally, visible after a crash |
| `events` | `publish(type, payload)` (own namespace only), `subscribe(pattern, handler)` |
| `config` | `get()`, `onChange(handler)` |
| `database` | `migrate`, `run`, `get`, `all`, `transaction` on the module's own SQLite file |
| `process` | `execute` (bounded output, timeout, cancellation), `spawn` (streaming; `control: true` opens fd 3), `privileged(op, args, { confirmed, user })`, `which` |
| `http` | `get/post/put/patch/delete(path, handler, { permission, audit, timeoutMs })` — paths like `/items/:id` or `/files/*` |
| `channels` | `handle(name, { onSubscribe, onMessage, onUnsubscribe })`, `send`, `broadcast`, `close`, `subscriberCount` |
| `services` | `provide(name, impl)`, `call(name, method, ...args)`, `available(name)` |
| `notifications` | `notify({ title, message, tone, permission })` |
| `audit` | `record({ action, target, result, user, metadata })` |
| `health` | `register(() => ({ status: 'HEALTHY' | 'DEGRADED' | 'ERROR', message }))` |
| `tasks` | `interval(name, ms, fn, { immediate })` — errors are logged, timers cleared on stop |
| `permissions` | `declared`, `has(user, permission)` |
| `system` | `{ hostname, platform, arch, simulated, coreVersion }` |
| `signal` | `AbortSignal` aborted when the module stops |

Route handlers receive `{ method, path, params, query, body, headers, user, requestId, remoteAddress, host }`
and return a JSON value, `undefined` (204), or `{ status, headers, body, raw }`. Throw `HttpError(status, message, details)` for errors.

## Frontend

```tsx
import { Page } from '@enterprise-ui/react';
import { QueryView, registerFrontend, useModuleApi, useQuery } from '@servermin/client';

function ItemsPage() {
  const api = useModuleApi();                       // bound to /api/v1/modules/my-module
  const items = useQuery(() => api.get('/items'), [api]);
  return <Page title="Items"><QueryView query={items}>{(list) => <pre>{JSON.stringify(list)}</pre>}</QueryView></Page>;
}

registerFrontend('my-module', {
  routes: [{ path: '/', component: ItemsPage, permission: 'my-module.read' }, { path: '/:id', component: ItemPage }],
  navigation: [{ id: 'items', label: 'Items', icon: 'list', order: 100, permission: 'my-module.read' }],
  widgets: [{ id: 'count', title: 'Items', component: CountWidget, span: 1 }],
  commands: [{ id: 'new', label: 'Create an item', path: '/new', permission: 'my-module.write' }],
  statusIndicators: [{ id: 'state', component: HeaderIndicator }],
});
```

Use ENTERPRISE-UI for all UI. `@servermin/client` provides `useModuleApi`, `useQuery`,
`useChannel(channel, params, onData)`, `usePermission`, `usePlatform`, `useConfirm`, `navigate`,
`modulePath`, `linkHandler`, `QueryView`, `ErrorMessage`, `Guard`, `PermissionDenied` and formatters.

## Testing

```ts
import { createTestContext, testUser } from '@servermin/sdk/testing';
import manifest from '../module.json';
import myModule from '../src/backend/index';

const t = createTestContext(manifest as any, {
  commands: { ip: (args) => '[]' },                       // fake host commands
  services: { 'docker.engine': { listContainers: () => [] } },
  config: { interval: 5 },
});
await t.start(myModule);
const r = await t.request('GET', '/items', { user: testUser(['my-module.read']) });
expect(r.status).toBe(200);
t.emit('docker.container.started', { id: 'x' });          // deliver an event
const sub = await t.subscribe('live');                     // channel messages in sub.messages
await t.tick();                                            // run interval tasks once
expect(t.privileged).toEqual([]);                          // privileged calls are recorded, never run
await t.stop();
```

## Development loop

`npm run dev` builds every module in watch mode and starts the core with `modules.watch`. Saving a
file rebuilds the bundle; the core sees the change, reloads only that module, and the shell reloads
its UI. No core restart (§52).

## Distribution

- Directory: `serverctl module install /path/to/my-module` (copies `module.json`, the built entries and
  files listed in `integrity.json`).
- Package: `node tools/build-module.mjs my-module --pack` → `.tgz` + `.sha256`. Archives must contain an
  `integrity.json` that lists the SHA-256 of every file; unlisted or modified files are rejected.
- Git: `serverctl module install https://github.com/org/repo.git --ref v1.2.0` (the repository must
  contain the built module).
- A remote registry is anticipated by the installer's source abstraction (`InstallSource`) but not
  part of version 1.0.
