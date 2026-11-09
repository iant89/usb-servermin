#!/usr/bin/env node
/**
 * Development workflow (§52): builds the core, starts it with module hot reload, rebuilds
 * modules on change (the core reloads only the changed module, no core restart) and runs the
 * Vite dev server with HMR for the shell.
 *
 *   npm run dev            → http://localhost:5173 (shell with HMR), core on :8080
 *   npm run dev -- --no-ui → core only (uses the built shell at packages/shell/dist)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildCore } from './build.mjs';
import { buildModule } from './build-module.mjs';

const root = resolve(import.meta.dirname, '..');
const dev = join(root, '.dev');
const args = process.argv.slice(2);
mkdirSync(dev, { recursive: true });

export function devConfig(port = 8080) {
  return {
    http: { host: '127.0.0.1', port, trustProxy: false },
    paths: { app: root, data: join(dev, 'data'), modules: join(dev, 'data/modules'), logs: join(dev, 'logs'), tmp: join(dev, 'tmp'), shell: join(root, 'packages/shell/dist') },
    modules: { preinstall: [join(root, 'modules')], sources: [join(root, 'modules'), join(root, 'examples')], watch: true, maxMemoryMb: 512, lifecycleTimeoutMs: 15000, healthIntervalMs: 15000 },
    privileged: { mode: process.env.SERVERMIN_PRIVILEGED_MODE ?? 'simulate', helper: join(root, 'deploy/servermin-privileged') },
    logging: { level: 'DEBUG', retentionDays: 3, stdout: true },
    dev: true,
  };
}

const configFile = join(dev, 'config.json');
writeFileSync(configFile, JSON.stringify(devConfig(), null, 2));

if (process.argv[1] === import.meta.filename) {
  await buildCore();
  const moduleDirs = readdirSync(join(root, 'modules'))
    .map((d) => join(root, 'modules', d))
    .filter((d) => existsSync(join(d, 'module.json')));
  for (const d of moduleDirs) await buildModule(d, { dev: true });
  // Watch modules: each rebuild changes dist/, which the core's watcher turns into a module reload.
  for (const d of moduleDirs) await buildModule(d, { dev: true, watch: true });

  const children = [];
  const run = (cmd, argv, env = {}) => {
    const c = spawn(cmd, argv, { stdio: 'inherit', cwd: root, env: { ...process.env, ...env } });
    children.push(c);
    return c;
  };
  run(process.execPath, ['--enable-source-maps', 'packages/core/dist/server.js'], { SERVERMIN_CONFIG: configFile, SERVERMIN_DEV: '1' });
  if (!args.includes('--no-ui')) run(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'packages/shell/vite.config.ts'], {});
  const stop = () => {
    for (const c of children) c.kill('SIGTERM');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.log('\n  Core:  http://127.0.0.1:8080\n  Shell: http://localhost:5173 (HMR)\n  Edit any module under modules/: it rebuilds and hot-reloads without restarting the core.\n');
}
