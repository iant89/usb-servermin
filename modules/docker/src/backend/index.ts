import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError, defineModule, type HealthResult, type ModuleContext, type RouteOptions } from '@servermin/sdk';
import { Demuxer, DockerClient, DockerError, ID_RE, cpuPercent, demux, memoryUsage, q, summarizeContainer } from './docker-client';

const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._\-/:@]{0,254}$/i;

function id(v: string | undefined, what = 'id') {
  if (!v || !ID_RE.test(v)) throw new HttpError(400, `Invalid ${what}`);
  return encodeURIComponent(v);
}

/** Converts Docker errors into HTTP errors with the Docker status. */
async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DockerError) throw new HttpError(e.status === 304 ? 409 : e.status, e.message);
    throw e;
  }
}

export default defineModule(() => {
  let ctx: ModuleContext;
  let docker: DockerClient;
  let health: HealthResult = { status: 'DEGRADED', message: 'Connecting to Docker Engine' };
  let stopEvents: (() => void) | null = null;
  let reconnect: NodeJS.Timeout | null = null;
  let retryMs = 2000;
  /** Incremented on every (re)connect, so callbacks of a superseded connection are ignored. */
  let generation = 0;
  const logStreams = new Map<string, () => void>();

  const containers = async (all = true) => (await docker.json<any[]>('GET', `/containers/json${q({ all: all ? 1 : 0 })}`)).map(summarizeContainer);

  async function logs(cid: string, tail: number, timestamps = true) {
    const { status, data } = await docker.raw('GET', `/containers/${cid}/logs${q({ stdout: 1, stderr: 1, tail, timestamps: timestamps ? 1 : 0 })}`);
    if (status >= 400) throw new DockerError(status, data.toString() || 'Could not read logs');
    const { stdout, stderr } = demux(data);
    return (stdout + stderr)
      .split('\n')
      .filter(Boolean)
      .sort();
  }

  async function exec(cid: string, cmd: string[], timeoutMs = 60_000) {
    const created = await docker.json<{ Id: string }>('POST', `/containers/${cid}/exec`, { AttachStdout: true, AttachStderr: true, Tty: false, Cmd: cmd });
    const { data } = await docker.raw('POST', `/exec/${created.Id}/start`, { Detach: false, Tty: false }, timeoutMs);
    const out = demux(data);
    const inspect = await docker.json<{ ExitCode: number }>('GET', `/exec/${created.Id}/json`);
    return { exitCode: inspect.ExitCode, ...out };
  }

  async function pull(image: string) {
    if (!IMAGE_RE.test(image)) throw new HttpError(400, 'Invalid image reference');
    const [name, tag] = image.includes('@') ? [image, undefined] : splitTag(image);
    const { status, data } = await docker.raw('POST', `/images/create${q({ fromImage: name, tag: tag ?? 'latest' })}`, undefined, 15 * 60_000);
    const lines = data.toString().split('\n').filter(Boolean).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { status: l };
      }
    });
    const error = lines.find((l) => l.error)?.error;
    if (status >= 400 || error) throw new HttpError(status >= 400 ? status : 502, error ?? 'Pull failed');
    return { image: `${name}:${tag ?? 'latest'}`, status: lines.at(-1)?.status ?? 'done' };
  }

  function splitTag(image: string): [string, string | undefined] {
    const i = image.lastIndexOf(':');
    return i > image.lastIndexOf('/') ? [image.slice(0, i), image.slice(i + 1)] : [image, undefined];
  }

  function composeDir() {
    return ctx.config.get().composeDirectory ? String(ctx.config.get().composeDirectory) : join(ctx.module.dataDir, 'compose');
  }

  async function compose(project: string, args: string[], file?: string) {
    if (!PROJECT_RE.test(project)) throw new HttpError(400, 'Project names use lowercase letters, digits, - and _');
    if (!(await ctx.process.which('docker'))) throw new HttpError(424, 'The docker CLI with the compose plugin is required for Compose');
    const r = await ctx.process.execute({
      command: 'docker',
      args: ['compose', '-p', project, ...(file ? ['-f', file] : []), ...args],
      timeoutMs: 15 * 60_000,
      env: { DOCKER_HOST: `unix://${docker.socketPath}` },
    });
    if (r.exitCode !== 0) throw new HttpError(502, (r.stderr || r.stdout).trim().slice(-2000) || 'docker compose failed');
    return { output: (r.stdout + r.stderr).trim().slice(-4000) };
  }

  async function writeProject(project: string, yaml: string) {
    if (!PROJECT_RE.test(project)) throw new HttpError(400, 'Invalid project name');
    if (typeof yaml !== 'string' || !yaml.trim() || yaml.length > 200_000) throw new HttpError(400, 'Provide the compose file content');
    const dir = join(composeDir(), project);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'compose.yaml');
    await writeFile(file, yaml);
    return file;
  }

  async function projects() {
    const byProject = new Map<string, { name: string; services: Set<string>; running: number; total: number; workingDir: string | undefined; configFiles: string | undefined }>();
    for (const c of await containers()) {
      if (!c.project) continue;
      const p = byProject.get(c.project) ?? { name: c.project as string, services: new Set<string>(), running: 0, total: 0, workingDir: undefined as string | undefined, configFiles: undefined as string | undefined };
      p.services.add(c.service ?? c.name);
      p.total++;
      if (c.state === 'running') p.running++;
      p.workingDir ??= c.labels['com.docker.compose.project.working_dir'];
      p.configFiles ??= c.labels['com.docker.compose.project.config_files'];
      byProject.set(c.project, p);
    }
    return [...byProject.values()].map((p) => ({ ...p, services: [...p.services] }));
  }

  /** Follow /events: publish platform events (§17) and broadcast to the channel. */
  async function connectEvents() {
    if (reconnect) clearTimeout(reconnect);
    const gen = ++generation;
    try {
      await docker.ping();
      if (gen !== generation) return;
      let buf = '';
      const stop = await docker.stream(
        `/events${q({ since: Math.floor(Date.now() / 1000) })}`,
        (chunk) => {
          buf += chunk.toString();
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            try {
              handleEvent(JSON.parse(line));
            } catch {
              /* partial line */
            }
          }
        },
        () => {
          if (gen !== generation) return;
          stopEvents = null;
          if (!ctx.signal.aborted) scheduleReconnect('Docker event stream ended');
        },
      );
      if (gen !== generation) {
        stop();
        return;
      }
      stopEvents = stop;
      if (health.status !== 'HEALTHY') ctx.logger.info('Connected to Docker Engine');
      health = { status: 'HEALTHY' };
      retryMs = 2000;
      ctx.events.publish('docker.engine.connected', {});
    } catch (e) {
      if (gen === generation) scheduleReconnect((e as Error).message);
    }
  }

  function scheduleReconnect(reason: string) {
    if (health.status === 'HEALTHY') {
      ctx.logger.error(`Docker Engine unavailable: ${reason}`);
      ctx.events.publish('docker.engine.disconnected', { reason });
    }
    health = { status: 'ERROR', message: reason.startsWith('Unable') || reason.startsWith('Permission') ? reason : `Unable to communicate with Docker Engine. ${reason}` };
    if (ctx.signal.aborted) return;
    reconnect = setTimeout(() => void connectEvents(), retryMs);
    retryMs = Math.min(retryMs * 2, 60_000);
  }

  function handleEvent(e: any) {
    ctx.channels.broadcast('events', { type: e.Type, action: e.Action, id: e.Actor?.ID, name: e.Actor?.Attributes?.name, image: e.Actor?.Attributes?.image, time: e.time });
    if (e.Type !== 'container') return;
    const map: Record<string, string> = { start: 'started', stop: 'stopped', die: 'died', pause: 'paused', unpause: 'unpaused', destroy: 'removed', create: 'created', restart: 'restarted' };
    const action = map[e.Action];
    if (action) ctx.events.publish(`docker.container.${action}`, { id: e.Actor?.ID, name: e.Actor?.Attributes?.name, image: e.Actor?.Attributes?.image });
  }

  const R: RouteOptions = { permission: 'docker.read' };
  const W = (audit: string, timeoutMs?: number): RouteOptions => ({ permission: 'docker.write', audit, timeoutMs });

  return {
    async initialize(c) {
      ctx = c;
      docker = new DockerClient(String(ctx.config.get().socketPath));
      const http = ctx.http;

      http.get('/status', async () => {
        try {
          const [version, info] = await Promise.all([docker.json('GET', '/version'), docker.json('GET', '/info')]);
          return {
            available: true,
            version: version.Version,
            apiVersion: version.ApiVersion,
            os: info.OperatingSystem,
            storageDriver: info.Driver,
            rootDir: info.DockerRootDir,
            cpus: info.NCPU,
            memory: info.MemTotal,
            containers: { total: info.Containers, running: info.ContainersRunning, paused: info.ContainersPaused, stopped: info.ContainersStopped },
            images: info.Images,
            warnings: info.Warnings ?? [],
          };
        } catch (e) {
          return { available: false, error: (e as Error).message, socketPath: docker.socketPath };
        }
      }, R);

      // Containers
      http.get('/containers', (req) => wrap(() => containers(req.query.all !== 'false')), R);
      http.get('/containers/:id', (req) => wrap(() => docker.json('GET', `/containers/${id(req.params.id)}/json`)), R);
      http.get('/containers/:id/logs', (req) => wrap(() => logs(id(req.params.id), Math.min(Number(req.query.tail) || Number(ctx.config.get().logTail), 10_000))), R);
      http.get('/containers/:id/stats', (req) =>
        wrap(async () => {
          const s = await docker.json('GET', `/containers/${id(req.params.id)}/stats${q({ stream: 'false' })}`);
          const net = Object.values(s.networks ?? {}).reduce((a: any, n: any) => ({ rx: a.rx + n.rx_bytes, tx: a.tx + n.tx_bytes }), { rx: 0, tx: 0 });
          return { cpuPercent: cpuPercent(s), memory: memoryUsage(s), network: net, pids: s.pids_stats?.current ?? null };
        }),
      R);
      for (const action of ['start', 'stop', 'restart', 'pause', 'unpause', 'kill'] as const) {
        http.post(`/containers/:id/${action}`, (req) =>
          wrap(async () => {
            await docker.json('POST', `/containers/${id(req.params.id)}/${action}`, undefined, 60_000);
            return summarizeContainer((await docker.json<any[]>('GET', `/containers/json${q({ all: 1, filters: JSON.stringify({ id: [req.params.id] }) })}`))[0] ?? { Id: req.params.id });
          }),
        W(`docker.container.${action}`, 90_000));
      }
      http.delete('/containers/:id', (req) => wrap(() => docker.json('DELETE', `/containers/${id(req.params.id)}${q({ force: req.query.force === 'true', v: req.query.volumes === 'true' })}`)), W('docker.container.remove'));
      http.post('/containers/:id/exec', async (req) => {
        const cmd = (req.body as { command?: unknown })?.command;
        const argv = typeof cmd === 'string' ? ['sh', '-c', cmd] : cmd;
        if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== 'string') || argv.join(' ').length > 4000) throw new HttpError(400, 'command must be a string or an array of strings');
        return wrap(() => exec(id(req.params.id), argv as string[]));
      }, { permission: 'docker.execute', audit: 'docker.container.exec', timeoutMs: 90_000 });

      // Images
      http.get('/images', () =>
        wrap(async () =>
          (await docker.json<any[]>('GET', '/images/json')).map((i) => ({ id: i.Id, shortId: String(i.Id).replace('sha256:', '').slice(0, 12), tags: i.RepoTags ?? [], size: i.Size, created: new Date(i.Created * 1000).toISOString(), containers: i.Containers })),
        ),
      R);
      http.post('/images/pull', (req) => wrap(() => pull(String((req.body as any)?.image ?? ''))), W('docker.image.pull', 16 * 60_000));
      http.delete('/images/:id', (req) => wrap(() => docker.json('DELETE', `/images/${id(req.params.id)}${q({ force: req.query.force === 'true' })}`)), W('docker.image.remove'));
      http.post('/images/prune', () => wrap(() => docker.json('POST', '/images/prune')), W('docker.image.prune', 300_000));

      // Networks
      http.get('/networks', () => wrap(async () => (await docker.json<any[]>('GET', '/networks')).map((n) => ({ id: n.Id, name: n.Name, driver: n.Driver, scope: n.Scope, internal: n.Internal, subnets: (n.IPAM?.Config ?? []).map((c: any) => c.Subnet).filter(Boolean), containers: Object.keys(n.Containers ?? {}).length }))), R);
      http.post('/networks', (req) => {
        const { name, driver = 'bridge', internal = false } = (req.body ?? {}) as any;
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name ?? '')) throw new HttpError(400, 'Invalid network name');
        if (!['bridge', 'overlay', 'macvlan', 'ipvlan'].includes(driver)) throw new HttpError(400, 'Unsupported driver');
        return wrap(() => docker.json('POST', '/networks/create', { Name: name, Driver: driver, Internal: !!internal }));
      }, W('docker.network.create'));
      http.delete('/networks/:id', (req) => wrap(() => docker.json('DELETE', `/networks/${id(req.params.id)}`)), W('docker.network.remove'));

      // Volumes
      http.get('/volumes', () => wrap(async () => ((await docker.json('GET', '/volumes')).Volumes ?? []).map((v: any) => ({ name: v.Name, driver: v.Driver, mountpoint: v.Mountpoint, created: v.CreatedAt, project: v.Labels?.['com.docker.compose.project'] ?? null }))), R);
      http.post('/volumes', (req) => {
        const name = (req.body as any)?.name;
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name ?? '')) throw new HttpError(400, 'Invalid volume name');
        return wrap(() => docker.json('POST', '/volumes/create', { Name: name }));
      }, W('docker.volume.create'));
      http.delete('/volumes/:name', (req) => wrap(() => docker.json('DELETE', `/volumes/${id(req.params.name, 'volume')}`)), W('docker.volume.remove'));

      // Compose
      http.get('/compose', () => wrap(projects), R);
      http.post('/compose', async (req) => {
        const { name, yaml } = (req.body ?? {}) as { name?: string; yaml?: string };
        const file = await writeProject(String(name), String(yaml));
        return compose(String(name), ['up', '-d', '--remove-orphans'], file);
      }, W('docker.compose.create', 16 * 60_000));
      for (const action of ['up', 'down', 'restart', 'stop', 'pull'] as const) {
        http.post(`/compose/:project/${action}`, async (req) => {
          const p = (await projects()).find((x) => x.name === req.params.project);
          const files = p?.configFiles?.split(',').filter(Boolean) ?? [];
          const args = action === 'up' ? ['up', '-d'] : [action];
          if (files.length) return compose(req.params.project, [...files.slice(1).flatMap((f) => ['-f', f]), ...args], files[0]);
          return compose(req.params.project, args, join(composeDir(), req.params.project, 'compose.yaml'));
        }, W(`docker.compose.${action}`, 16 * 60_000));
      }

      // Live logs: follow one container (params.id).
      ctx.channels.handle('logs', {
        onSubscribe: async (sub) => {
          const cid = id(String(sub.params.id ?? ''));
          const tail = Math.min(Number(sub.params.tail) || 100, 2000);
          const demuxer = new Demuxer((stream, text) => ctx.channels.send(sub.id, { stream, lines: text.split('\n').filter(Boolean) }));
          const stop = await wrap(() =>
            docker.stream(`/containers/${cid}/logs${q({ follow: 1, stdout: 1, stderr: 1, tail, timestamps: 1 })}`, (c) => demuxer.push(c), () => ctx.channels.close(sub.id, 'stream-ended')),
          );
          logStreams.set(sub.id, stop);
        },
        onUnsubscribe: (sub) => {
          logStreams.get(sub.id)?.();
          logStreams.delete(sub.id);
        },
      });
      ctx.channels.handle('events', {});

      // Service for other modules (Applications), declared in `provides` (§56).
      ctx.services.provide('docker.engine', {
        status: async () => ({ available: health.status === 'HEALTHY' }),
        listContainers: (filters?: Record<string, string[]>) => docker.json<any[]>('GET', `/containers/json${q({ all: 1, filters: filters ? JSON.stringify(filters) : undefined })}`).then((l) => l.map(summarizeContainer)),
        inspectContainer: (cid: string) => docker.json('GET', `/containers/${id(cid)}/json`),
        pullImage: (image: string) => pull(image),
        createContainer: async (name: string, spec: any) => {
          if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name)) throw new HttpError(400, 'Invalid container name');
          return docker.json('POST', `/containers/create${q({ name })}`, spec);
        },
        startContainer: (cid: string) => docker.json('POST', `/containers/${id(cid)}/start`),
        stopContainer: (cid: string) => docker.json('POST', `/containers/${id(cid)}/stop`, undefined, 60_000).catch((e) => (e.status === 304 ? null : Promise.reject(e))),
        restartContainer: (cid: string) => docker.json('POST', `/containers/${id(cid)}/restart`, undefined, 60_000),
        removeContainer: (cid: string) => docker.json('DELETE', `/containers/${id(cid)}${q({ force: true })}`).catch((e) => (e.status === 404 ? null : Promise.reject(e))),
        containerLogs: (cid: string, tail = 200) => logs(id(cid), tail),
        composeUp: async (project: string, yaml: string) => compose(project, ['up', '-d', '--remove-orphans'], await writeProject(project, yaml)),
        composeDown: (project: string) => compose(project, ['down'], join(composeDir(), project, 'compose.yaml')),
        composeRestart: (project: string) => compose(project, ['restart'], join(composeDir(), project, 'compose.yaml')),
        composeContainers: (project: string) => containers().then((l) => l.filter((x) => x.project === project)),
      });

      ctx.health.register(() => health);
      ctx.config.onChange((values, keys) => {
        if (!keys.includes('socketPath')) return;
        docker.socketPath = String(values.socketPath);
        // The old connection no longer says anything about the new socket.
        generation++;
        stopEvents?.();
        stopEvents = null;
        health = { status: 'DEGRADED', message: `Connecting to Docker Engine at ${values.socketPath}` };
        retryMs = 2000;
        void connectEvents();
      });
    },
    async start() {
      await connectEvents();
      ctx.tasks.interval('metrics', 30_000, async () => {
        if (health.status !== 'HEALTHY') return;
        const list = await containers();
        ctx.events.publish('docker.metrics', {
          metrics: [
            { name: 'containers.running', value: list.filter((c) => c.state === 'running').length, unit: 'count' },
            { name: 'containers.total', value: list.length, unit: 'count' },
          ],
        });
      });
    },
    stop() {
      if (reconnect) clearTimeout(reconnect);
      stopEvents?.();
      for (const s of logStreams.values()) s();
    },
  };
});
