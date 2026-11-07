#!/usr/bin/env node
/**
 * Builds a module: backend → dist/backend.js (ESM, Node), frontend → dist/frontend.js (IIFE,
 * browser), then writes integrity.json. With --pack also writes release/modules/<id>-<v>.tgz.
 *
 *   node tools/build-module.mjs modules/docker [--watch] [--pack] [--dev]
 *
 * Frontend bundles never include React, ENTERPRISE-UI or @servermin/client: those resolve to
 * the instances the shell exposes on `window.__SERVERMIN_SHARED__`, so module UI shares the
 * shell's theme, contexts and router.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import * as esbuild from 'esbuild';

export const SHARED = ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@enterprise-ui/react', '@servermin/client'];

const sharedPlugin = {
  name: 'servermin-shared',
  setup(build) {
    const filter = new RegExp(`^(${SHARED.map((s) => s.replace(/[/.]/g, '\\$&')).join('|')})$`);
    build.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'servermin-shared' }));
    build.onLoad({ filter: /.*/, namespace: 'servermin-shared' }, (args) => ({
      contents: `var s = window.__SERVERMIN_SHARED__ && window.__SERVERMIN_SHARED__[${JSON.stringify(args.path)}];
if (!s) throw new Error('Shared module ${args.path} is not provided by the shell');
module.exports = s;`,
      loader: 'js',
    }));
  },
};

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export function writeIntegrity(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'module.json'), 'utf8'));
  const files = ['module.json'];
  if (existsSync(join(root, 'dist'))) files.push(...walk(join(root, 'dist')).map((f) => relative(root, f).split(sep).join('/')).filter((f) => !f.endsWith('.map')));
  for (const extra of ['README.md', 'LICENSE']) if (existsSync(join(root, extra))) files.push(extra);
  const integrity = { algorithm: 'sha256', files: {} };
  for (const f of files.sort()) integrity.files[f] = createHash('sha256').update(readFileSync(join(root, f))).digest('hex');
  writeFileSync(join(root, 'integrity.json'), JSON.stringify(integrity, null, 2) + '\n');
  return { manifest, files };
}

export function pack(root, outDir) {
  const { manifest, files } = writeIntegrity(root);
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${manifest.id}-${manifest.version}.tgz`);
  execFileSync('tar', ['-czf', out, '--owner=0', '--group=0', '-C', root, ...files, 'integrity.json']);
  const sha = createHash('sha256').update(readFileSync(out)).digest('hex');
  writeFileSync(out + '.sha256', `${sha}  ${manifest.id}-${manifest.version}.tgz\n`);
  return { file: out, sha256: sha };
}

export async function buildModule(dir, { watch = false, dev = false, log = console.log } = {}) {
  const root = resolve(dir);
  const manifest = JSON.parse(readFileSync(join(root, 'module.json'), 'utf8'));
  const contexts = [];
  const common = { bundle: true, sourcemap: dev ? 'inline' : 'linked', logLevel: 'warning', legalComments: 'none', minify: !dev, absWorkingDir: root };
  const afterBuild = {
    name: 'integrity',
    setup(b) {
      b.onEnd((r) => {
        if (!r.errors.length) {
          writeIntegrity(root);
          if (watch) log(`  rebuilt ${manifest.id}`);
        }
      });
    },
  };
  if (!watch) rmSync(join(root, 'dist'), { recursive: true, force: true });

  if (manifest.backend && existsSync(join(root, 'src/backend/index.ts'))) {
    contexts.push(
      await esbuild.context({
        ...common,
        entryPoints: { backend: join(root, 'src/backend/index.ts') },
        outdir: join(root, 'dist'),
        platform: 'node',
        format: 'esm',
        target: 'node22',
        minify: false,
        banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
        plugins: [afterBuild],
      }),
    );
  }
  if (manifest.frontend && existsSync(join(root, 'src/frontend/index.tsx'))) {
    contexts.push(
      await esbuild.context({
        ...common,
        entryPoints: { frontend: join(root, 'src/frontend/index.tsx') },
        outdir: join(root, 'dist'),
        platform: 'browser',
        format: 'iife',
        target: 'es2022',
        jsx: 'automatic',
        loader: { '.css': 'css', '.svg': 'dataurl', '.png': 'dataurl' },
        define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
        plugins: [sharedPlugin, afterBuild],
      }),
    );
  }
  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
    return contexts;
  }
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
  writeIntegrity(root);
  for (const e of [manifest.backend?.entry, manifest.frontend?.entry, manifest.frontend?.style]) {
    if (e && !existsSync(join(root, e))) throw new Error(`${manifest.id}: manifest entry ${e} was not produced by the build`);
  }
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dirs = args.filter((a) => !a.startsWith('--'));
  const watch = args.includes('--watch');
  for (const d of dirs) {
    const m = await buildModule(d, { watch, dev: args.includes('--dev') });
    if (!watch) {
      console.log(`built ${m.id ?? d}`);
      if (args.includes('--pack')) console.log('  packed', pack(d, resolve('release/modules')).file);
    }
  }
  void statSync;
}
