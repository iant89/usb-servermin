/** Application model and validation (§32.6). */

export type AppType = 'docker' | 'compose' | 'static' | 'node' | 'service';

export interface AppSpec {
  /** docker: image reference without tag. */
  image?: string;
  /** compose: compose.yaml content. */
  compose?: string;
  /** Installed from the app catalogue. */
  catalog?: { id: string; web?: { port?: string; fixedPort?: number; path?: string; scheme?: string } };
  /** static/node: directory on the host. */
  directory?: string;
  /** node: start command and runtime version. */
  command?: string;
  nodeVersion?: string;
  /** service: systemd unit. */
  unit?: string;
  volumes?: string[];
  restart?: 'no' | 'always' | 'unless-stopped' | 'on-failure';
}

export interface Application {
  id: string;
  name: string;
  description: string;
  type: AppType;
  spec: AppSpec;
  environment: Record<string, string>;
  ports: string[];
  domains: string[];
  /** Version to deploy: image tag, git ref, or a label. */
  version: string;
  deployedVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export const APP_ID_RE = /^[a-z][a-z0-9-]{1,40}$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._\-/:]{0,200}$/i;
const PORT_RE = /^(?:(\d{1,3}(?:\.\d{1,3}){3}):)?(\d{1,5}):(\d{1,5})(\/(tcp|udp))?$/;
const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,100}$/;
const VERSION_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const UNIT_RE = /^[A-Za-z0-9@_.:\\-]{1,200}\.service$/;

export function validateApp(a: Partial<Application>, isNew: boolean): string[] {
  const p: string[] = [];
  if (isNew && (!a.id || !APP_ID_RE.test(a.id))) p.push('id: 2-41 lowercase letters, digits or hyphens, starting with a letter');
  if (isNew && a.id === 'catalog') p.push('id: "catalog" is reserved');
  if (!a.name?.trim() || a.name.length > 80) p.push('name: 1-80 characters');
  if (!['docker', 'compose', 'static', 'node', 'service'].includes(a.type as string)) p.push('type must be docker, compose, static, node or service');
  if (!a.version || !VERSION_RE.test(a.version)) p.push('version: letters, digits, ., _ or - (e.g. 1.2.0 or latest)');
  const s = a.spec ?? {};
  switch (a.type) {
    case 'docker':
      if (!s.image || !IMAGE_RE.test(s.image) || s.image.includes('@')) p.push('spec.image: an image name such as nginx or ghcr.io/org/app');
      break;
    case 'compose':
      if (!s.compose?.trim() || !/^\s*services\s*:/m.test(s.compose)) p.push('spec.compose: a compose file with a services: section');
      if ((s.compose?.length ?? 0) > 200_000) p.push('spec.compose is too large');
      break;
    case 'static':
    case 'node':
      if (!s.directory || !/^\/(?!.*\.\.)[A-Za-z0-9/_.@+-]{1,250}$/.test(s.directory)) p.push('spec.directory: an absolute path on the server');
      if (a.type === 'node' && s.nodeVersion && !/^\d{2}(\.\d+){0,2}$/.test(s.nodeVersion)) p.push('spec.nodeVersion: e.g. 22');
      if (a.type === 'node' && s.command && s.command.length > 300) p.push('spec.command is too long');
      break;
    case 'service':
      if (!s.unit || !UNIT_RE.test(s.unit)) p.push('spec.unit: a systemd unit such as myapp.service');
      break;
  }
  for (const v of s.volumes ?? []) if (!/^([A-Za-z0-9][A-Za-z0-9_.-]{0,62}|\/[A-Za-z0-9/_.@+-]{1,250}):\/[A-Za-z0-9/_.@+-]{1,250}(:ro)?$/.test(v) || v.includes('..')) p.push(`volume "${v}" must be name:/path or /host/path:/path`);
  const hostPorts = new Set<string>();
  for (const port of a.ports ?? []) {
    const m = PORT_RE.exec(port);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535 || Number(m[3]) < 1 || Number(m[3]) > 65535) p.push(`port "${port}" must be host:container, e.g. 8080:80`);
    else if (hostPorts.has(m[2] + (m[5] ?? 'tcp'))) p.push(`host port ${m[2]} is used twice`);
    else hostPorts.add(m[2] + (m[5] ?? 'tcp'));
  }
  for (const d of a.domains ?? []) if (!DOMAIN_RE.test(d)) p.push(`domain "${d}" is not a valid host name`);
  for (const k of Object.keys(a.environment ?? {})) if (!ENV_RE.test(k)) p.push(`environment variable "${k}" has an invalid name`);
  if (Object.values(a.environment ?? {}).some((v) => typeof v !== 'string' || v.length > 10_000)) p.push('environment values must be text');
  // Compose applications get their environment as a .env file, which cannot hold these.
  if (a.type === 'compose') for (const [k, v] of Object.entries(a.environment ?? {})) if (typeof v === 'string' && /[\n\r'\0]/.test(v)) p.push(`environment variable "${k}" must be one line without single quotes`);
  return p;
}

/** Docker Engine container spec for the image-based types. */
export function containerSpec(app: Application, version: string) {
  const ports = app.ports.map((p) => PORT_RE.exec(p)!);
  const exposed: Record<string, object> = {};
  const bindings: Record<string, { HostIp: string; HostPort: string }[]> = {};
  for (const m of ports) {
    const key = `${m[3]}/${m[5] ?? 'tcp'}`;
    exposed[key] = {};
    bindings[key] = [{ HostIp: m[1] ?? '', HostPort: m[2] }];
  }
  let image: string;
  let cmd: string[] | undefined;
  let workdir: string | undefined;
  const binds = [...(app.spec.volumes ?? [])];
  switch (app.type) {
    case 'docker':
      image = `${app.spec.image}:${version}`;
      break;
    case 'static':
      image = 'nginx:alpine';
      binds.push(`${app.spec.directory}:/usr/share/nginx/html:ro`);
      break;
    case 'node':
      image = `node:${app.spec.nodeVersion || '22'}-alpine`;
      binds.push(`${app.spec.directory}:/app`);
      workdir = '/app';
      cmd = ['sh', '-c', app.spec.command || 'npm ci --omit=dev && npm start'];
      break;
    default:
      throw new Error(`No container spec for ${app.type}`);
  }
  return {
    image,
    spec: {
      Image: image,
      Cmd: cmd,
      WorkingDir: workdir,
      Env: Object.entries({ ...app.environment, ...(app.type === 'node' ? { NODE_ENV: 'production' } : {}) }).map(([k, v]) => `${k}=${v}`),
      ExposedPorts: exposed,
      Labels: { 'servermin.app': app.id, 'servermin.version': version, ...(app.domains.length ? { 'servermin.domains': app.domains.join(',') } : {}) },
      HostConfig: { PortBindings: bindings, Binds: binds, RestartPolicy: { Name: app.spec.restart ?? 'unless-stopped' } },
    },
  };
}

/** Prepares a compose file for deployment: `${APP_VERSION}` is replaced with the version being deployed. */
export function composeWithVersion(app: Application, version: string) {
  const header = `# Application ${app.id}, version ${version}. Managed by Server Control.\n`;
  return header + app.spec.compose!.replace(/\$\{APP_VERSION\}/g, version);
}
