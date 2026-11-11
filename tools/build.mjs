#!/usr/bin/env node
/**
 * Production build: core server + worker host + CLI (esbuild), the React shell (Vite) and every
 * module in modules/ (plus examples/ with --examples).
 */
import { readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as esbuild from 'esbuild';
import { buildModule } from './build-module.mjs';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const modulesOnly = args.includes('--modules-only');

export async function buildCore(outdir = join(root, 'packages/core/dist')) {
  mkdirSync(outdir, { recursive: true });
  const banner = { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" };
  await esbuild.build({
    entryPoints: { server: join(root, 'packages/core/src/main.ts'), 'module-host': join(root, 'packages/core/src/modules/worker-host.ts'), 'storage-host': join(root, 'packages/core/src/storage/storage-host.ts') },
    outdir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: 'linked',
    banner,
    logLevel: 'warning',
    external: ['bufferutil', 'utf-8-validate'],
  });
  await esbuild.build({
    entryPoints: { manager: join(root, 'packages/manager/src/main.ts') },
    outdir: join(root, 'packages/manager/dist'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: 'linked',
    banner,
    logLevel: 'warning',
    external: ['bufferutil', 'utf-8-validate'],
  });
  await esbuild.build({
    entryPoints: { serverctl: join(root, 'packages/cli/src/main.ts'), verify: join(root, 'packages/cli/src/verify.ts'), 'servermin-agent': join(root, 'packages/cli/src/agent-main.ts') },
    outdir: join(root, 'packages/cli/dist'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: { js: '#!/usr/bin/env node\n' + banner.js },
    logLevel: 'warning',
  });
}

function moduleDirs(base) {
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(base, e.name, 'module.json')))
    .map((e) => join(base, e.name));
}

if (process.argv[1] === import.meta.filename) {
  const started = Date.now();
  if (!modulesOnly) {
    await buildCore();
    console.log('✓ core, worker host, Manager and CLI');
    execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', join(root, 'packages/shell/vite.config.ts')], { stdio: 'inherit', cwd: root });
    console.log('✓ shell');
  }
  const dirs = [...moduleDirs(join(root, 'modules')), ...(args.includes('--examples') || modulesOnly ? moduleDirs(join(root, 'examples')) : [])];
  for (const d of dirs) await buildModule(d);
  console.log(`✓ ${dirs.length} modules`);
  console.log(`Build finished in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
