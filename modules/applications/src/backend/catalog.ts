/**
 * App catalogue: curated Docker Compose templates that install as ordinary Compose applications.
 *
 * A template's compose file refers to its parameters as `${KEY}`. The values are stored as the
 * application's environment and written next to the compose file as `.env`, so Docker Compose
 * substitutes them at deploy time and they can be changed later (Edit) without touching the
 * compose file. `${APP_VERSION}` is the version being deployed, as for any Compose application.
 *
 * Secrets are generated on the server when left empty and are hidden in the UI (their keys
 * contain PASS, SECRET, TOKEN or KEY).
 */

export type ParamType = 'string' | 'password' | 'port' | 'path' | 'select';

export interface CatalogParam {
  /** Variable name used in the compose file. */
  key: string;
  label: string;
  description?: string;
  type: ParamType;
  default?: string;
  /** Filled in on the server when left empty. */
  generate?: 'password' | 'timezone';
  required?: boolean;
  options?: { value: string; label: string }[];
  /** port: the container port it is published to, and the protocol. */
  containerPort?: number;
  protocol?: 'tcp' | 'udp';
  /** path: mounted read-only (shown in the form). */
  readOnly?: boolean;
}

export interface CatalogTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  website: string;
  /** Default version: the tag of the main image. */
  version: string;
  versionHint: string;
  compose: string;
  params: CatalogParam[];
  /** The port parameter that serves the web interface, for the Open button. */
  web?: { port?: string; fixedPort?: number; path?: string; scheme?: 'http' | 'https' };
  /** Ports used with host networking (not changeable). */
  hostPorts?: number[];
  /** Recommended free memory, in MB. */
  memoryMb: number;
  arch: ('amd64' | 'arm64')[];
  /** Shown before installing. */
  warnings?: string[];
  /** Shown after installing. */
  notes?: string;
}

const tz: CatalogParam = { key: 'TZ', label: 'Time zone', type: 'string', generate: 'timezone', description: 'IANA name such as Europe/Berlin. Defaults to the server time zone.' };
const port = (key: string, label: string, def: number, containerPort: number, protocol: 'tcp' | 'udp' = 'tcp', description?: string): CatalogParam => ({ key, label, type: 'port', default: String(def), containerPort, protocol, required: true, description });
const password = (key: string, label: string, description = 'Leave empty to generate a strong password.'): CatalogParam => ({ key, label, type: 'password', generate: 'password', description });

export const CATALOG: CatalogTemplate[] = [
  {
    id: 'uptime-kuma',
    name: 'Uptime Kuma',
    category: 'Monitoring',
    description: 'Watch websites, ports and services and get alerts when they go down. Status pages included.',
    website: 'https://github.com/louislam/uptime-kuma',
    version: '1',
    versionHint: 'Image tag of louislam/uptime-kuma, e.g. 1 or 1.23.16',
    memoryMb: 256,
    arch: ['amd64', 'arm64'],
    web: { port: 'HTTP_PORT' },
    params: [port('HTTP_PORT', 'Web port', 3001, 3001)],
    compose: `services:
  uptime-kuma:
    image: louislam/uptime-kuma:\${APP_VERSION}
    restart: unless-stopped
    ports:
      - "\${HTTP_PORT}:3001"
    volumes:
      - data:/app/data
volumes:
  data:
`,
    notes: 'Open the web interface to create the administrator account.',
  },
  {
    id: 'vaultwarden',
    name: 'Vaultwarden',
    category: 'Security',
    description: 'Password manager server compatible with the Bitwarden apps and browser extensions.',
    website: 'https://github.com/dani-garcia/vaultwarden',
    version: 'latest',
    versionHint: 'Image tag of vaultwarden/server, e.g. latest or 1.32.7',
    memoryMb: 128,
    arch: ['amd64', 'arm64'],
    web: { port: 'HTTP_PORT' },
    params: [
      port('HTTP_PORT', 'Web port', 8081, 80),
      { key: 'DOMAIN', label: 'Public address', type: 'string', description: 'The HTTPS address users reach it under, e.g. https://vault.example.com. Leave empty while testing.' },
      { key: 'SIGNUPS_ALLOWED', label: 'Allow new accounts', type: 'select', default: 'true', options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No — invitations only' }] },
      { key: 'ADMIN_TOKEN', label: 'Admin page token', type: 'password', generate: 'password', description: 'Opens /admin. Leave empty to generate one.' },
    ],
    compose: `services:
  vaultwarden:
    image: vaultwarden/server:\${APP_VERSION}
    restart: unless-stopped
    ports:
      - "\${HTTP_PORT}:80"
    environment:
      DOMAIN: "\${DOMAIN}"
      SIGNUPS_ALLOWED: "\${SIGNUPS_ALLOWED}"
      ADMIN_TOKEN: "\${ADMIN_TOKEN}"
    volumes:
      - data:/data
volumes:
  data:
`,
    warnings: ['Browsers only allow the web vault over HTTPS (or on localhost). Put it behind a reverse proxy with a certificate before using it for real.'],
    notes: 'Create your account in the web vault, then set "Allow new accounts" to No (Edit) so nobody else can register.',
  },
  {
    id: 'nextcloud',
    name: 'Nextcloud',
    category: 'Files & sync',
    description: 'Files, calendars, contacts and sharing on your own server, with a MariaDB database.',
    website: 'https://nextcloud.com',
    version: 'stable',
    versionHint: 'Image tag of nextcloud, e.g. stable or 30',
    memoryMb: 1024,
    arch: ['amd64', 'arm64'],
    web: { port: 'HTTP_PORT' },
    params: [
      port('HTTP_PORT', 'Web port', 8082, 80),
      { key: 'ADMIN_USER', label: 'Administrator name', type: 'string', default: 'admin', required: true },
      password('ADMIN_PASSWORD', 'Administrator password'),
      { key: 'TRUSTED_DOMAINS', label: 'Trusted host names', type: 'string', description: 'Space-separated names or IP addresses used to reach it, e.g. 192.168.1.20 cloud.example.com.' },
      password('DB_PASSWORD', 'Database password'),
      password('DB_ROOT_PASSWORD', 'Database root password'),
    ],
    compose: `services:
  db:
    image: mariadb:11
    restart: unless-stopped
    command: --transaction-isolation=READ-COMMITTED --log-bin=binlog --binlog-format=ROW
    environment:
      MARIADB_ROOT_PASSWORD: "\${DB_ROOT_PASSWORD}"
      MARIADB_DATABASE: nextcloud
      MARIADB_USER: nextcloud
      MARIADB_PASSWORD: "\${DB_PASSWORD}"
    volumes:
      - db:/var/lib/mysql
  app:
    image: nextcloud:\${APP_VERSION}
    restart: unless-stopped
    depends_on:
      - db
    ports:
      - "\${HTTP_PORT}:80"
    environment:
      MYSQL_HOST: db
      MYSQL_DATABASE: nextcloud
      MYSQL_USER: nextcloud
      MYSQL_PASSWORD: "\${DB_PASSWORD}"
      NEXTCLOUD_ADMIN_USER: "\${ADMIN_USER}"
      NEXTCLOUD_ADMIN_PASSWORD: "\${ADMIN_PASSWORD}"
      NEXTCLOUD_TRUSTED_DOMAINS: "\${TRUSTED_DOMAINS}"
    volumes:
      - data:/var/www/html
volumes:
  db:
  data:
`,
    warnings: ['The first start installs Nextcloud and takes a few minutes, longer on a USB stick.'],
    notes: 'Sign in with the administrator name and password. Add host names later in Edit (Trusted host names) and redeploy.',
  },
  {
    id: 'jellyfin',
    name: 'Jellyfin',
    category: 'Media',
    description: 'Media server for your films, series and music, streamed to browsers, TVs and phones.',
    website: 'https://jellyfin.org',
    version: 'latest',
    versionHint: 'Image tag of jellyfin/jellyfin, e.g. latest or 10.10.7',
    memoryMb: 1024,
    arch: ['amd64', 'arm64'],
    web: { port: 'HTTP_PORT' },
    params: [
      port('HTTP_PORT', 'Web port', 8096, 8096),
      { key: 'MEDIA_PATH', label: 'Media folder', type: 'path', required: true, readOnly: true, default: '/srv/media', description: 'Folder on the server with your media. Mounted read-only at /media.' },
    ],
    compose: `services:
  jellyfin:
    image: jellyfin/jellyfin:\${APP_VERSION}
    restart: unless-stopped
    ports:
      - "\${HTTP_PORT}:8096"
    volumes:
      - config:/config
      - cache:/cache
      - "\${MEDIA_PATH}:/media:ro"
volumes:
  config:
  cache:
`,
    notes: 'Open the web interface to run the setup wizard, and add /media as a library.',
  },
  {
    id: 'gitea',
    name: 'Gitea',
    category: 'Development',
    description: 'Lightweight Git hosting with pull requests, issues, packages and Actions, using PostgreSQL.',
    website: 'https://about.gitea.com',
    version: 'latest',
    versionHint: 'Image tag of gitea/gitea, e.g. latest or 1.24',
    memoryMb: 512,
    arch: ['amd64', 'arm64'],
    web: { port: 'HTTP_PORT' },
    params: [port('HTTP_PORT', 'Web port', 3000, 3000), port('SSH_PORT', 'Git SSH port', 2222, 22), password('DB_PASSWORD', 'Database password')],
    compose: `services:
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: gitea
      POSTGRES_PASSWORD: "\${DB_PASSWORD}"
      POSTGRES_DB: gitea
    volumes:
      - db:/var/lib/postgresql/data
  gitea:
    image: gitea/gitea:\${APP_VERSION}
    restart: unless-stopped
    depends_on:
      - db
    environment:
      USER_UID: "1000"
      USER_GID: "1000"
      GITEA__database__DB_TYPE: postgres
      GITEA__database__HOST: db:5432
      GITEA__database__NAME: gitea
      GITEA__database__USER: gitea
      GITEA__database__PASSWD: "\${DB_PASSWORD}"
      GITEA__server__SSH_PORT: "\${SSH_PORT}"
    ports:
      - "\${HTTP_PORT}:3000"
      - "\${SSH_PORT}:22"
    volumes:
      - data:/data
volumes:
  db:
  data:
`,
    notes: 'Open the web interface and finish the installation page; the first account you register becomes the administrator.',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    category: 'Databases',
    description: 'PostgreSQL database server for your own applications.',
    website: 'https://www.postgresql.org',
    version: '17',
    versionHint: 'Image tag of postgres, e.g. 17 or 17-alpine. Major upgrades need a dump and restore.',
    memoryMb: 256,
    arch: ['amd64', 'arm64'],
    params: [
      port('PG_PORT', 'Port', 5432, 5432),
      {
        key: 'LISTEN_ADDRESS',
        label: 'Reachable from',
        type: 'select',
        default: '127.0.0.1',
        options: [
          { value: '127.0.0.1', label: 'This server only' },
          { value: '0.0.0.0', label: 'The network' },
        ],
      },
      { key: 'PG_USER', label: 'User', type: 'string', default: 'postgres', required: true },
      password('PG_PASSWORD', 'Password'),
      { key: 'PG_DATABASE', label: 'Database', type: 'string', default: 'app', required: true },
    ],
    compose: `services:
  postgres:
    image: postgres:\${APP_VERSION}
    restart: unless-stopped
    environment:
      POSTGRES_USER: "\${PG_USER}"
      POSTGRES_PASSWORD: "\${PG_PASSWORD}"
      POSTGRES_DB: "\${PG_DATABASE}"
    ports:
      - "\${LISTEN_ADDRESS}:\${PG_PORT}:5432"
    volumes:
      - data:/var/lib/postgresql/data
volumes:
  data:
`,
    notes: 'Connect with the user, password and database you chose. The password is under Edit → Environment (hidden in lists).',
  },
  {
    id: 'mariadb',
    name: 'MariaDB',
    category: 'Databases',
    description: 'MariaDB (MySQL-compatible) database server for your own applications.',
    website: 'https://mariadb.org',
    version: '11',
    versionHint: 'Image tag of mariadb, e.g. 11 or 11.4',
    memoryMb: 256,
    arch: ['amd64', 'arm64'],
    params: [
      port('DB_PORT', 'Port', 3306, 3306),
      {
        key: 'LISTEN_ADDRESS',
        label: 'Reachable from',
        type: 'select',
        default: '127.0.0.1',
        options: [
          { value: '127.0.0.1', label: 'This server only' },
          { value: '0.0.0.0', label: 'The network' },
        ],
      },
      { key: 'DB_USER', label: 'User', type: 'string', default: 'app', required: true },
      password('DB_PASSWORD', 'Password'),
      { key: 'DB_DATABASE', label: 'Database', type: 'string', default: 'app', required: true },
      password('DB_ROOT_PASSWORD', 'Root password'),
    ],
    compose: `services:
  mariadb:
    image: mariadb:\${APP_VERSION}
    restart: unless-stopped
    environment:
      MARIADB_ROOT_PASSWORD: "\${DB_ROOT_PASSWORD}"
      MARIADB_USER: "\${DB_USER}"
      MARIADB_PASSWORD: "\${DB_PASSWORD}"
      MARIADB_DATABASE: "\${DB_DATABASE}"
    ports:
      - "\${LISTEN_ADDRESS}:\${DB_PORT}:3306"
    volumes:
      - data:/var/lib/mysql
volumes:
  data:
`,
  },
  {
    id: 'redis',
    name: 'Redis',
    category: 'Databases',
    description: 'In-memory key-value store for caches and queues, with a password and persistence turned on.',
    website: 'https://redis.io',
    version: '7-alpine',
    versionHint: 'Image tag of redis, e.g. 7-alpine',
    memoryMb: 128,
    arch: ['amd64', 'arm64'],
    params: [
      port('REDIS_PORT', 'Port', 6379, 6379),
      {
        key: 'LISTEN_ADDRESS',
        label: 'Reachable from',
        type: 'select',
        default: '127.0.0.1',
        options: [
          { value: '127.0.0.1', label: 'This server only' },
          { value: '0.0.0.0', label: 'The network' },
        ],
      },
      password('REDIS_PASSWORD', 'Password'),
    ],
    compose: `services:
  redis:
    image: redis:\${APP_VERSION}
    restart: unless-stopped
    command: ["redis-server", "--requirepass", "\${REDIS_PASSWORD}", "--appendonly", "yes"]
    ports:
      - "\${LISTEN_ADDRESS}:\${REDIS_PORT}:6379"
    volumes:
      - data:/data
volumes:
  data:
`,
  },
  {
    id: 'grafana',
    name: 'Grafana',
    category: 'Monitoring',
    description: 'Dashboards and alerting for metrics and logs from Prometheus, databases and many other sources.',
    website: 'https://grafana.com/oss/grafana/',
    version: 'latest',
    versionHint: 'Image tag of grafana/grafana-oss, e.g. latest or 11.6.0',
    memoryMb: 256,
    arch: ['amd64', 'arm64'],
    web: { port: 'HTTP_PORT' },
    params: [port('HTTP_PORT', 'Web port', 3002, 3000), password('ADMIN_PASSWORD', 'Password for the admin user')],
    compose: `services:
  grafana:
    image: grafana/grafana-oss:\${APP_VERSION}
    restart: unless-stopped
    ports:
      - "\${HTTP_PORT}:3000"
    environment:
      GF_SECURITY_ADMIN_PASSWORD: "\${ADMIN_PASSWORD}"
    volumes:
      - data:/var/lib/grafana
volumes:
  data:
`,
    notes: 'Sign in as admin with the password you chose (Edit → Environment if it was generated).',
  },
  {
    id: 'syncthing',
    name: 'Syncthing',
    category: 'Files & sync',
    description: 'Continuous peer-to-peer file synchronisation between this server and your devices.',
    website: 'https://syncthing.net',
    version: 'latest',
    versionHint: 'Image tag of syncthing/syncthing, e.g. latest or 1',
    memoryMb: 256,
    arch: ['amd64', 'arm64'],
    web: { port: 'HTTP_PORT' },
    params: [
      port('HTTP_PORT', 'Web port', 8384, 8384),
      port('SYNC_PORT', 'Sync port', 22000, 22000),
      { key: 'SYNC_PATH', label: 'Data folder', type: 'path', required: true, default: '/srv/syncthing', description: 'Folder on the server where synchronised folders live (mounted at /var/syncthing).' },
    ],
    compose: `services:
  syncthing:
    image: syncthing/syncthing:\${APP_VERSION}
    restart: unless-stopped
    hostname: syncthing
    environment:
      PUID: "1000"
      PGID: "1000"
    ports:
      - "\${HTTP_PORT}:8384"
      - "\${SYNC_PORT}:22000/tcp"
      - "\${SYNC_PORT}:22000/udp"
    volumes:
      - "\${SYNC_PATH}:/var/syncthing"
`,
    warnings: ['The data folder must be writable by user id 1000.'],
    notes: 'Set a GUI user and password in Actions → Settings → GUI before exposing the web port.',
  },
  {
    id: 'node-red',
    name: 'Node-RED',
    category: 'Home & automation',
    description: 'Flow-based programming for wiring together devices, APIs and online services.',
    website: 'https://nodered.org',
    version: 'latest',
    versionHint: 'Image tag of nodered/node-red, e.g. latest or 4.0',
    memoryMb: 256,
    arch: ['amd64', 'arm64'],
    web: { port: 'HTTP_PORT' },
    params: [port('HTTP_PORT', 'Web port', 1880, 1880), tz],
    compose: `services:
  node-red:
    image: nodered/node-red:\${APP_VERSION}
    restart: unless-stopped
    environment:
      TZ: "\${TZ}"
    ports:
      - "\${HTTP_PORT}:1880"
    volumes:
      - data:/data
volumes:
  data:
`,
    warnings: ['The editor has no password by default. Keep the port on your local network or enable adminAuth in settings.js.'],
  },
  {
    id: 'home-assistant',
    name: 'Home Assistant',
    category: 'Home & automation',
    description: 'Home automation that puts local control and privacy first, with thousands of integrations.',
    website: 'https://www.home-assistant.io',
    version: 'stable',
    versionHint: 'Image tag of ghcr.io/home-assistant/home-assistant, e.g. stable or 2025.6',
    memoryMb: 1024,
    arch: ['amd64', 'arm64'],
    web: { fixedPort: 8123 },
    hostPorts: [8123],
    params: [tz],
    compose: `services:
  homeassistant:
    image: ghcr.io/home-assistant/home-assistant:\${APP_VERSION}
    restart: unless-stopped
    network_mode: host
    privileged: true
    environment:
      TZ: "\${TZ}"
    volumes:
      - config:/config
      - /etc/localtime:/etc/localtime:ro
      - /run/dbus:/run/dbus:ro
volumes:
  config:
`,
    warnings: ['Runs privileged with host networking so it can discover devices on your network and use USB adapters.'],
    notes: 'Open the web interface to create your account; onboarding takes a minute on first start.',
  },
  {
    id: 'pihole',
    name: 'Pi-hole',
    category: 'Network',
    description: 'Network-wide DNS sinkhole that blocks ads and trackers for every device on your network.',
    website: 'https://pi-hole.net',
    version: 'latest',
    versionHint: 'Image tag of pihole/pihole, e.g. latest or 2025.06.0',
    memoryMb: 128,
    arch: ['amd64', 'arm64'],
    web: { port: 'HTTP_PORT', path: '/admin/' },
    params: [port('HTTP_PORT', 'Web port', 8053, 80), password('WEB_PASSWORD', 'Web interface password'), tz],
    compose: `services:
  pihole:
    image: pihole/pihole:\${APP_VERSION}
    restart: unless-stopped
    ports:
      - "53:53/tcp"
      - "53:53/udp"
      - "\${HTTP_PORT}:80/tcp"
    environment:
      TZ: "\${TZ}"
      FTLCONF_webserver_api_password: "\${WEB_PASSWORD}"
      FTLCONF_dns_listeningMode: all
    volumes:
      - config:/etc/pihole
volumes:
  config:
`,
    hostPorts: [53],
    warnings: ['Needs port 53. On Ubuntu, systemd-resolved listens there: set DNSStubListener=no in /etc/systemd/resolved.conf and restart it first, or the deployment fails.'],
    notes: 'Point your router\'s DNS setting (or individual devices) at this server\'s address.',
  },
  {
    id: 'paperless-ngx',
    name: 'Paperless-ngx',
    category: 'Documents',
    description: 'Scan, index and archive your paper documents with full-text search and OCR.',
    website: 'https://docs.paperless-ngx.com',
    version: 'latest',
    versionHint: 'Image tag of ghcr.io/paperless-ngx/paperless-ngx, e.g. latest or 2.16',
    memoryMb: 1024,
    arch: ['amd64', 'arm64'],
    web: { port: 'HTTP_PORT' },
    params: [
      port('HTTP_PORT', 'Web port', 8000, 8000),
      { key: 'ADMIN_USER', label: 'Administrator name', type: 'string', default: 'admin', required: true },
      password('ADMIN_PASSWORD', 'Administrator password'),
      { key: 'PUBLIC_URL', label: 'Public address', type: 'string', description: 'The address users reach it under, e.g. https://docs.example.com. Leave empty to use the server address.' },
      { key: 'OCR_LANGUAGE', label: 'OCR language', type: 'string', default: 'eng', description: 'Tesseract language codes, e.g. eng or deu+eng.' },
      tz,
      password('DB_PASSWORD', 'Database password'),
      { key: 'APP_SECRET_KEY', label: 'Secret key', type: 'password', generate: 'password', description: 'Signs sessions. Leave empty to generate one.' },
    ],
    compose: `services:
  broker:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis:/data
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_DB: paperless
      POSTGRES_USER: paperless
      POSTGRES_PASSWORD: "\${DB_PASSWORD}"
    volumes:
      - db:/var/lib/postgresql/data
  webserver:
    image: ghcr.io/paperless-ngx/paperless-ngx:\${APP_VERSION}
    restart: unless-stopped
    depends_on:
      - db
      - broker
    ports:
      - "\${HTTP_PORT}:8000"
    environment:
      PAPERLESS_REDIS: redis://broker:6379
      PAPERLESS_DBHOST: db
      PAPERLESS_DBPASS: "\${DB_PASSWORD}"
      PAPERLESS_SECRET_KEY: "\${APP_SECRET_KEY}"
      PAPERLESS_ADMIN_USER: "\${ADMIN_USER}"
      PAPERLESS_ADMIN_PASSWORD: "\${ADMIN_PASSWORD}"
      PAPERLESS_URL: "\${PUBLIC_URL}"
      PAPERLESS_OCR_LANGUAGE: "\${OCR_LANGUAGE}"
      PAPERLESS_TIME_ZONE: "\${TZ}"
    volumes:
      - data:/usr/src/paperless/data
      - media:/usr/src/paperless/media
      - consume:/usr/src/paperless/consume
volumes:
  redis:
  db:
  data:
  media:
  consume:
`,
  },
];

// ── Parameter handling ───────────────────────────────────────────────────────────

/** Host folders a template may not mount. */
const PROTECTED_PATHS = ['/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/opt', '/proc', '/root', '/run', '/sbin', '/sys', '/usr', '/var', '/var/lib', '/var/lib/docker', '/var/lib/servermin', '/var/lib/servermin-helper', '/home'];
const PATH_RE = /^\/(?!.*\.\.)[A-Za-z0-9/_.@+ -]{1,250}$/;
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function generatePassword(random: (n: number) => Uint8Array, length = 24) {
  const out: string[] = [];
  // Rejection sampling keeps every character equally likely.
  while (out.length < length) for (const b of random(length * 2)) if (b < 256 - (256 % PASSWORD_ALPHABET.length) && out.length < length) out.push(PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]);
  return out.join('');
}

export const findTemplate = (id: string) => CATALOG.find((t) => t.id === id);

/** Compose variables a template uses (besides APP_VERSION). */
export function templateVariables(compose: string) {
  return [...new Set([...compose.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]).filter((v) => v !== 'APP_VERSION'))];
}

/**
 * Checks and completes the values for a template: defaults, generated secrets, validation.
 * Returns the environment for the application, or the problems.
 */
export function resolveParams(t: CatalogTemplate, input: Record<string, unknown>, opts: { random: (n: number) => Uint8Array; timezone: string }) {
  const env: Record<string, string> = {};
  const problems: string[] = [];
  for (const p of t.params) {
    let v = input[p.key] === undefined || input[p.key] === null ? '' : String(input[p.key]).trim();
    if (!v && p.default !== undefined && p.type !== 'password') v = p.default;
    if (!v && p.generate === 'password') v = generatePassword(opts.random);
    if (!v && p.generate === 'timezone') v = opts.timezone || 'UTC';
    if (!v) {
      if (p.required) problems.push(`${p.label} is required`);
      env[p.key] = '';
      continue;
    }
    if (/[\n\r'\0]/.test(v) || v.length > 500) {
      problems.push(`${p.label} must be one line without single quotes`);
      continue;
    }
    switch (p.type) {
      case 'port':
        if (!/^\d{1,5}$/.test(v) || Number(v) < 1 || Number(v) > 65535) problems.push(`${p.label} must be a port number (1-65535)`);
        break;
      case 'password':
        if (v.length < 8) problems.push(`${p.label} must be at least 8 characters`);
        if (/[$\s"`\\]/.test(v)) problems.push(`${p.label} must not contain spaces, $, quotes or backslashes`);
        break;
      case 'path': {
        const norm = v.replace(/\/+$/, '') || '/';
        if (!PATH_RE.test(v)) problems.push(`${p.label} must be an absolute path on the server`);
        else if (PROTECTED_PATHS.includes(norm) || norm.startsWith('/var/lib/servermin') || norm.startsWith('/etc/') || norm.startsWith('/proc/') || norm.startsWith('/sys/') || norm.startsWith('/boot/')) problems.push(`${p.label}: ${norm} is a system folder and cannot be mounted`);
        v = norm;
        break;
      }
      case 'select':
        if (!p.options?.some((o) => o.value === v)) problems.push(`${p.label} must be one of ${p.options?.map((o) => o.value).join(', ')}`);
        break;
      default:
        if (/[$`"\\]/.test(v)) problems.push(`${p.label} must not contain $, quotes or backslashes`);
    }
    env[p.key] = v;
  }
  if (t.params.some((p) => p.key === 'TZ') && env.TZ && !/^[A-Za-z]+(?:[/_+-][A-Za-z0-9_+-]+)*$/.test(env.TZ)) problems.push('Time zone must be a name such as Europe/Berlin');
  return { env, problems };
}

/** The host ports an installed template publishes, as `host:container[/udp]` entries for the application. */
export function templatePorts(t: CatalogTemplate, env: Record<string, string>) {
  const ports: string[] = [];
  for (const p of t.params) {
    if (p.type !== 'port' || !env[p.key]) continue;
    // Bound to one address (databases default to 127.0.0.1)?
    const address = t.compose.includes(`\${LISTEN_ADDRESS}:\${${p.key}}`) && env.LISTEN_ADDRESS && env.LISTEN_ADDRESS !== '0.0.0.0' ? `${env.LISTEN_ADDRESS}:` : '';
    ports.push(`${address}${env[p.key]}:${p.containerPort}${p.protocol === 'udp' ? '/udp' : ''}`);
  }
  for (const hp of t.hostPorts ?? []) if (!ports.some((x) => x.startsWith(`${hp}:`))) ports.push(`${hp}:${hp}`);
  // Templates that publish one port as TCP and UDP (Syncthing) list it once per protocol.
  for (const m of t.compose.matchAll(/"\$\{([A-Z_]+)\}:(\d+)\/udp"/g)) if (env[m[1]] && !ports.includes(`${env[m[1]]}:${m[2]}/udp`)) ports.push(`${env[m[1]]}:${m[2]}/udp`);
  return ports;
}
