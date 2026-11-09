import { HttpError, defineModule, hasPermission, type ModuleContext, type RequestUser } from '@servermin/sdk';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { totalmem } from 'node:os';
import { CATALOG, findTemplate, resolveParams, templatePorts } from './catalog';
import { APP_ID_RE, composeWithVersion, containerSpec, validateApp, type Application } from './model';

interface Row {
  id: string;
  name: string;
  description: string;
  type: string;
  spec: string;
  environment: string;
  ports: string;
  domains: string;
  version: string;
  deployed_version: string | null;
  created_at: string;
  updated_at: string;
}

const toApp = (r: Row): Application => ({
  id: r.id,
  name: r.name,
  description: r.description,
  type: r.type as Application['type'],
  spec: JSON.parse(r.spec),
  environment: JSON.parse(r.environment),
  ports: JSON.parse(r.ports),
  domains: JSON.parse(r.domains),
  version: r.version,
  deployedVersion: r.deployed_version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const SECRET_RE = /(pass|secret|token|key)/i;

export default defineModule(() => {
  let ctx: ModuleContext;
  const running = new Set<string>();

  const docker = <T = any>(method: string, ...args: unknown[]) => ctx.services.call<T>('docker.engine', method, ...args);
  const systemd = <T = any>(method: string, ...args: unknown[]) => ctx.services.call<T>('services.systemd', method, ...args);
  const containerName = (app: Application) => `${ctx.config.get().containerPrefix ?? 'app-'}${app.id}`;
  const project = (app: Application) => `${String(ctx.config.get().containerPrefix ?? 'app-').replace(/-$/, '')}-${app.id}`.replace(/^-/, '');

  async function requireCapability(app: Application) {
    const needed = app.type === 'service' ? 'services.systemd' : 'docker.engine';
    if (!(await ctx.services.available(needed)))
      throw new HttpError(503, app.type === 'service' ? 'The Services module is not active, so system services cannot be managed.' : 'The Docker module is not active. Enable it to deploy container-based applications.', { reason: 'dependency-unavailable', capability: needed });
  }

  async function get(id: string) {
    const r = await ctx.database.get<Row>('SELECT * FROM applications WHERE id = ?', [id]);
    if (!r) throw new HttpError(404, `Application ${id} does not exist`);
    return toApp(r);
  }

  async function status(app: Application): Promise<{ state: string; detail: string; containers?: any[] }> {
    if (running.has(app.id)) return { state: 'deploying', detail: 'Deploying…' };
    try {
      switch (app.type) {
        case 'service': {
          if (!(await ctx.services.available('services.systemd'))) return { state: 'unknown', detail: 'Services module unavailable' };
          const s = await systemd('status', app.spec.unit);
          return { state: s.ActiveState === 'active' ? 'running' : s.ActiveState === 'failed' ? 'failed' : 'stopped', detail: `${s.ActiveState} (${s.SubState})` };
        }
        case 'compose': {
          if (!(await ctx.services.available('docker.engine'))) return { state: 'unknown', detail: 'Docker module unavailable' };
          const list = await docker<any[]>('composeContainers', project(app));
          if (!list.length) return { state: 'not-deployed', detail: 'No containers' };
          const up = list.filter((c) => c.state === 'running').length;
          return { state: up === list.length ? 'running' : up ? 'degraded' : 'stopped', detail: `${up} of ${list.length} containers running`, containers: list };
        }
        default: {
          if (!(await ctx.services.available('docker.engine'))) return { state: 'unknown', detail: 'Docker module unavailable' };
          const [c] = await docker<any[]>('listContainers', { label: [`servermin.app=${app.id}`] });
          if (!c) return { state: 'not-deployed', detail: 'Not deployed' };
          return { state: c.state === 'running' ? 'running' : c.state === 'restarting' ? 'degraded' : 'stopped', detail: c.status, containers: [c] };
        }
      }
    } catch (e) {
      return { state: 'unknown', detail: (e as Error).message };
    }
  }

  /** Deploy a version (§32.6). Each deployment is recorded with its log. */
  async function deploy(app: Application, version: string, user: RequestUser) {
    if (running.has(app.id)) throw new HttpError(409, 'A deployment of this application is already running');
    await requireCapability(app);
    running.add(app.id);
    const started = new Date().toISOString();
    const { lastInsertRowid: depId } = await ctx.database.run("INSERT INTO deployments (app_id, version, status, log, started_at, user) VALUES (?, ?, 'running', '', ?, ?)", [app.id, version, started, user.username]);
    const log: string[] = [];
    const step = (m: string) => log.push(`${new Date().toISOString()} ${m}`);
    ctx.events.publish('applications.deployment.started', { app: app.id, version, deployment: depId });
    try {
      switch (app.type) {
        case 'compose': {
          step(`docker compose up for project ${project(app)}`);
          const r = await docker<{ output: string }>('composeUp', project(app), composeWithVersion(app, version), app.environment);
          step(r.output || 'done');
          break;
        }
        case 'service': {
          step(`restarting ${app.spec.unit}`);
          if (!(await systemd<boolean>('restart', app.spec.unit))) throw new Error(`systemctl restart ${app.spec.unit} failed`);
          break;
        }
        default: {
          const { image, spec } = containerSpec(app, version);
          step(`pulling ${image}`);
          await docker('pullImage', image);
          const previous = await docker<any[]>('listContainers', { label: [`servermin.app=${app.id}`] });
          for (const c of previous) {
            step(`removing previous container ${c.name} (${c.labels['servermin.version'] ?? 'unknown version'})`);
            await docker('removeContainer', c.id);
          }
          step(`creating ${containerName(app)}`);
          const created = await docker<{ Id: string }>('createContainer', containerName(app), spec);
          step('starting');
          await docker('startContainer', created.Id);
          await new Promise((r) => setTimeout(r, 1500));
          const inspect = await docker<any>('inspectContainer', created.Id);
          if (!inspect.State.Running) {
            const tail = await docker<string[]>('containerLogs', created.Id, 30).catch(() => []);
            throw new Error(`The container exited (code ${inspect.State.ExitCode}).\n${tail.join('\n')}`);
          }
          step(`running as ${created.Id.slice(0, 12)}`);
        }
      }
      await ctx.database.transaction([
        { sql: "UPDATE deployments SET status = 'succeeded', log = ?, finished_at = ? WHERE id = ?", params: [log.join('\n'), new Date().toISOString(), depId] },
        { sql: 'UPDATE applications SET deployed_version = ?, updated_at = ? WHERE id = ?', params: [version, new Date().toISOString(), app.id] },
      ]);
      ctx.events.publish('applications.deployment.succeeded', { app: app.id, version });
      return { deployment: depId, status: 'succeeded', log };
    } catch (e) {
      step(`FAILED: ${(e as Error).message}`);
      await ctx.database.run("UPDATE deployments SET status = 'failed', log = ?, finished_at = ? WHERE id = ?", [log.join('\n'), new Date().toISOString(), depId]);
      ctx.events.publish('applications.deployment.failed', { app: app.id, version, error: (e as Error).message });
      ctx.notifications.notify({ title: `Deployment of ${app.name} failed`, message: (e as Error).message.split('\n')[0], tone: 'error', permission: 'applications.read' });
      throw new HttpError(502, `Deployment failed: ${(e as Error).message}`, { deployment: depId, log });
    } finally {
      running.delete(app.id);
      const keep = Number(ctx.config.get().keepDeployments);
      await ctx.database.run('DELETE FROM deployments WHERE app_id = ? AND id NOT IN (SELECT id FROM deployments WHERE app_id = ? ORDER BY id DESC LIMIT ?)', [app.id, app.id, keep]);
    }
  }

  async function control(app: Application, action: 'start' | 'stop' | 'restart') {
    await requireCapability(app);
    if (app.type === 'service') {
      if (!(await systemd<boolean>(action, app.spec.unit))) throw new HttpError(502, `systemctl ${action} failed`);
      return;
    }
    if (running.has(app.id)) throw new HttpError(409, 'The application is being deployed');
    const s = await status(app);
    const containers = s.containers ?? [];
    if (!containers.length) throw new HttpError(409, 'The application is not deployed yet');
    for (const c of containers) await docker(`${action}Container`, c.id);
  }

  // ── App catalogue ──────────────────────────────────────────────────────────────

  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const timezone = () => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  };

  /** Can a TCP port be bound on all addresses right now? Ports below 1024 cannot be tested without root. */
  function portFree(port: number) {
    if (port < 1024) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const srv = createServer();
      srv.once('error', () => resolve(false));
      srv.listen({ port, host: '0.0.0.0', exclusive: true }, () => srv.close(() => resolve(true)));
    });
  }

  const hostPort = (p: string) => {
    const m = /^(?:[\d.]+:)?(\d+):\d+(\/(tcp|udp))?$/.exec(p);
    return m ? `${m[1]}/${m[3] ?? 'tcp'}` : null;
  };

  /** Host ports already published by other applications. */
  async function usedPorts(exceptId?: string) {
    const used = new Map<string, string>();
    for (const a of (await ctx.database.all<Row>('SELECT * FROM applications')).map(toApp)) {
      if (a.id === exceptId) continue;
      for (const p of a.ports) {
        const hp = hostPort(p);
        if (hp) used.set(hp, a.name);
      }
    }
    return used;
  }

  async function portProblems(ports: string[]) {
    const problems: string[] = [];
    const used = await usedPorts();
    for (const p of ports) {
      const hp = hostPort(p);
      if (!hp) continue;
      const owner = used.get(hp);
      if (owner) problems.push(`Port ${hp} is already used by ${owner}`);
      else if (hp.endsWith('/tcp') && !(await portFree(Number(hp.split('/')[0])))) problems.push(`Port ${hp.split('/')[0]} is already in use on this server`);
    }
    return problems;
  }

  async function installedFromCatalog() {
    const out = new Map<string, string[]>();
    for (const a of (await ctx.database.all<Row>('SELECT * FROM applications')).map(toApp)) if (a.spec.catalog) out.set(a.spec.catalog.id, [...(out.get(a.spec.catalog.id) ?? []), a.id]);
    return out;
  }

  /** Values to prefill the install form: free ports, an unused id, the server time zone. */
  async function suggestions(id: string) {
    const t = findTemplate(id)!;
    const used = await usedPorts();
    const values: Record<string, string> = {};
    for (const p of t.params) {
      if (p.type === 'port') {
        let port = Number(p.default);
        for (let i = 0; i < 50; i++, port++) if (!used.has(`${port}/${p.protocol ?? 'tcp'}`) && (await portFree(port))) break;
        values[p.key] = String(port);
      } else if (p.generate === 'timezone') values[p.key] = timezone();
      else if (p.default !== undefined) values[p.key] = p.default;
    }
    let appId = t.id;
    for (let n = 2; await ctx.database.get('SELECT id FROM applications WHERE id = ?', [appId]); n++) appId = `${t.id}-${n}`;
    return { appId, values };
  }

  function redact(app: Application) {
    return { ...app, environment: Object.fromEntries(Object.entries(app.environment).map(([k, v]) => [k, SECRET_RE.test(k) && v ? '••••••••' : v])) };
  }

  function fromBody(body: any, existing?: Application): Application {
    const now = new Date().toISOString();
    const env: Record<string, string> = { ...(body.environment ?? existing?.environment ?? {}) };
    // Unchanged secrets come back redacted from the browser.
    if (existing) for (const [k, v] of Object.entries(env)) if (v === '••••••••') env[k] = existing.environment[k];
    return {
      id: existing?.id ?? String(body.id ?? ''),
      name: String(body.name ?? existing?.name ?? '').trim(),
      description: String(body.description ?? existing?.description ?? '').slice(0, 500),
      type: existing?.type ?? body.type,
      spec: { ...(existing?.spec ?? {}), ...(body.spec ?? {}) },
      environment: env,
      ports: (body.ports ?? existing?.ports ?? []).map((p: unknown) => String(p).trim()).filter(Boolean),
      domains: (body.domains ?? existing?.domains ?? []).map((d: unknown) => String(d).trim().toLowerCase()).filter(Boolean),
      version: String(body.version ?? existing?.version ?? 'latest').trim(),
      deployedVersion: existing?.deployedVersion ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  return {
    async initialize(c) {
      ctx = c;
      await ctx.database.migrate([
        {
          version: 1,
          name: 'applications and deployments',
          sql: `CREATE TABLE applications (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, spec TEXT NOT NULL, environment TEXT NOT NULL, ports TEXT NOT NULL, domains TEXT NOT NULL, version TEXT NOT NULL, deployed_version TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE deployments (id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL, log TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, user TEXT);
                CREATE INDEX deployments_app ON deployments(app_id, id);`,
        },
      ]);
      const R = { permission: 'applications.read' };

      ctx.http.get('/capabilities', async () => ({ docker: await ctx.services.available('docker.engine'), systemd: await ctx.services.available('services.systemd') }), R);
      ctx.http.get('/apps', async () => {
        const apps = (await ctx.database.all<Row>('SELECT * FROM applications ORDER BY name')).map(toApp);
        return Promise.all(apps.map(async (a) => ({ ...redact(a), status: await status(a) })));
      }, R);
      ctx.http.get('/apps/:id', async (req) => {
        const app = await get(req.params.id);
        return { ...redact(app), status: await status(app) };
      }, R);
      ctx.http.get('/apps/:id/deployments', async (req) => ctx.database.all('SELECT * FROM deployments WHERE app_id = ? ORDER BY id DESC LIMIT 100', [req.params.id]), R);
      ctx.http.get('/apps/:id/logs', async (req) => {
        const app = await get(req.params.id);
        const tail = Math.min(Number(req.query.tail) || 300, 5000);
        if (app.type === 'service') {
          await requireCapability(app);
          return (await systemd<any[]>('logs', app.spec.unit, tail)).map((l) => `${l.time} ${l.message}`);
        }
        await requireCapability(app);
        const s = await status(app);
        const out: string[] = [];
        for (const c of (s as any).containers ?? []) out.push(...(await docker<string[]>('containerLogs', c.id, tail)).map((l) => (app.type === 'compose' ? `[${c.service ?? c.name}] ${l}` : l)));
        return out.sort().slice(-tail);
      }, R);

      ctx.http.get('/catalog', async () => {
        const installed = await installedFromCatalog();
        return {
          arch,
          memoryMb: Math.round(totalmem() / 1024 / 1024),
          docker: await ctx.services.available('docker.engine'),
          templates: CATALOG.map(({ compose: _c, ...t }) => ({ ...t, installed: installed.get(t.id) ?? [], supported: t.arch.includes(arch) })),
        };
      }, R);
      ctx.http.get('/catalog/:id', async (req) => {
        const t = findTemplate(req.params.id);
        if (!t) throw new HttpError(404, `The catalogue has no template ${req.params.id}`);
        return { ...t, supported: t.arch.includes(arch), installed: (await installedFromCatalog()).get(t.id) ?? [], suggested: await suggestions(t.id) };
      }, R);
      ctx.http.post('/catalog/:id/install', async (req) => {
        const t = findTemplate(req.params.id);
        if (!t) throw new HttpError(404, `The catalogue has no template ${req.params.id}`);
        if (!t.arch.includes(arch)) throw new HttpError(409, `${t.name} is not available for ${arch} processors`);
        const body = (req.body ?? {}) as { id?: string; name?: string; version?: string; values?: Record<string, unknown>; deploy?: boolean };
        const { env, problems } = resolveParams(t, body.values ?? {}, { random: (n) => randomBytes(n), timezone: timezone() });
        const app = fromBody({
          id: body.id ?? t.id,
          name: body.name || t.name,
          description: t.description,
          type: 'compose',
          version: body.version || t.version,
          spec: { compose: t.compose, catalog: { id: t.id, ...(t.web ? { web: t.web } : {}) } },
          environment: env,
          ports: templatePorts(t, env),
          domains: [],
        });
        problems.push(...validateApp(app, true));
        if (app.id && APP_ID_RE.test(app.id) && (await ctx.database.get('SELECT id FROM applications WHERE id = ?', [app.id]))) problems.push(`An application with id ${app.id} exists`);
        if (!problems.length) problems.push(...(await portProblems(app.ports)));
        if (problems.length) throw new HttpError(400, `${t.name} cannot be installed`, problems);
        if (body.deploy !== false) {
          if (!hasPermission(req.user.permissions, 'applications.deploy')) throw new HttpError(403, 'Installing and starting an application needs the applications.deploy permission; install it without deploying instead');
          await requireCapability(app);
        }
        await ctx.database.run('INSERT INTO applications VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)', [app.id, app.name, app.description, app.type, JSON.stringify(app.spec), JSON.stringify(app.environment), JSON.stringify(app.ports), JSON.stringify(app.domains), app.version, app.createdAt, app.updatedAt]);
        ctx.events.publish('applications.created', { app: app.id, type: app.type, catalog: t.id });
        ctx.logger.info(`Installed ${t.name} from the catalogue as ${app.id}`);
        // Pulling images can take minutes on a slow connection: deploy in the background. The
        // deployment is recorded with its log, and a failure is reported as a notification.
        if (body.deploy !== false) void deploy(app, app.version, req.user).catch((e) => ctx.logger.warn(`Deploying ${app.id} failed: ${(e as Error).message.split('\n')[0]}`));
        return { app: redact(app), deploying: body.deploy !== false };
      }, { permission: 'applications.write', audit: 'applications.catalog.install' });

      ctx.http.post('/apps', async (req) => {
        const app = fromBody(req.body ?? {});
        const problems = validateApp(app, true);
        if (problems.length) throw new HttpError(400, 'The application is not valid', problems);
        if (await ctx.database.get('SELECT id FROM applications WHERE id = ?', [app.id])) throw new HttpError(409, `An application with id ${app.id} exists`);
        await ctx.database.run('INSERT INTO applications VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)', [app.id, app.name, app.description, app.type, JSON.stringify(app.spec), JSON.stringify(app.environment), JSON.stringify(app.ports), JSON.stringify(app.domains), app.version, app.createdAt, app.updatedAt]);
        ctx.events.publish('applications.created', { app: app.id, type: app.type });
        return redact(app);
      }, { permission: 'applications.write', audit: 'applications.create' });

      ctx.http.put('/apps/:id', async (req) => {
        const existing = await get(req.params.id);
        const app = fromBody(req.body ?? {}, existing);
        const problems = validateApp(app, false);
        if (problems.length) throw new HttpError(400, 'The application is not valid', problems);
        await ctx.database.run('UPDATE applications SET name = ?, description = ?, spec = ?, environment = ?, ports = ?, domains = ?, version = ?, updated_at = ? WHERE id = ?', [app.name, app.description, JSON.stringify(app.spec), JSON.stringify(app.environment), JSON.stringify(app.ports), JSON.stringify(app.domains), app.version, app.updatedAt, app.id]);
        return redact(app);
      }, { permission: 'applications.write', audit: 'applications.update' });

      ctx.http.post('/apps/:id/deploy', async (req) => {
        const app = await get(req.params.id);
        const version = (req.body as any)?.version ? String((req.body as any).version) : app.version;
        if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(version)) throw new HttpError(400, 'Invalid version');
        return deploy(app, version, req.user);
      }, { permission: 'applications.deploy', audit: 'applications.deploy', timeoutMs: 20 * 60_000 });

      for (const action of ['start', 'stop', 'restart'] as const)
        ctx.http.post(`/apps/:id/${action}`, async (req) => {
          const app = await get(req.params.id);
          await control(app, action);
          ctx.events.publish(`applications.${action === 'stop' ? 'stopped' : action === 'start' ? 'started' : 'restarted'}`, { app: app.id });
          return { ...redact(app), status: await status(app) };
        }, { permission: 'applications.deploy', audit: `applications.${action}`, timeoutMs: 120_000 });

      ctx.http.delete('/apps/:id', async (req) => {
        const app = await get(req.params.id);
        if (req.query.removeContainers !== 'false' && app.type !== 'service' && (await ctx.services.available('docker.engine'))) {
          if (app.type === 'compose') await docker('composeDown', project(app)).catch((e) => ctx.logger.warn(`compose down failed: ${(e as Error).message}`));
          else for (const c of await docker<any[]>('listContainers', { label: [`servermin.app=${app.id}`] })) await docker('removeContainer', c.id);
        }
        await ctx.database.transaction([{ sql: 'DELETE FROM deployments WHERE app_id = ?', params: [app.id] }, { sql: 'DELETE FROM applications WHERE id = ?', params: [app.id] }]);
        ctx.events.publish('applications.removed', { app: app.id });
        return { removed: app.id };
      }, { permission: 'applications.write', audit: 'applications.remove', timeoutMs: 300_000 });

      // Keep application status in sync with container events (§17), without importing the Docker module.
      ctx.events.subscribe('docker.container.*', (e) => {
        const name = (e.payload as any)?.name ?? '';
        if (String(name).startsWith(String(ctx.config.get().containerPrefix ?? 'app-'))) ctx.events.publish('applications.status.changed', { container: name, event: e.type });
      });
      ctx.health.register(async () => {
        const failed = await ctx.database.all<{ app_id: string }>("SELECT app_id FROM deployments d WHERE id = (SELECT MAX(id) FROM deployments WHERE app_id = d.app_id) AND status = 'failed'");
        return failed.length ? { status: 'DEGRADED', message: `Last deployment failed: ${failed.map((f) => f.app_id).join(', ')}` } : { status: 'HEALTHY' };
      });
    },
  };
});
