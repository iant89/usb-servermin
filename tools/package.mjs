#!/usr/bin/env node
/**
 * Builds release directories and archives:
 *
 *   release/servermin-<version>[-linux-<arch>]/
 *     server/   core (server.js, module-host.js)      shell/   web interface
 *     modules/  bundled modules (module.json, dist, integrity.json)
 *     cli/      serverctl.js, verify.js                bin/     launchers
 *     deploy/   systemd unit, sudoers, privilege helper, default config
 *     node/     Node.js runtime (with --bundle-node or --node)
 *     install.sh
 *   release/servermin-<version>[-linux-<arch>].tar.gz (+ .sha256)
 *   release/modules/<id>-<version>.tgz               installable module packages
 *
 *   npm run package                                   no runtime: the server needs Node.js 22.13+
 *   npm run package -- --bundle-node                  bundle the pinned Node.js for this machine's architecture
 *   npm run package -- --bundle-node --arch x64,arm64 one release per architecture
 *   npm run package -- --node /path/to/node-dir       bundle a runtime you already have (bin/node)
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pack } from './build-module.mjs';
import { hostArch, nodeRuntime, runtimeInfo } from './node-runtime.mjs';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const bundle = args.includes('--bundle-node');
const localNode = opt('--node') ? resolve(opt('--node')) : null;
const nodeVersion = opt('--node-version') ?? pkg.servermin?.nodeVersion;
const arches = bundle ? (opt('--arch') ?? hostArch()).split(',').map((a) => a.trim()) : [null];

execFileSync(process.execPath, [join(root, 'tools/build.mjs')], { stdio: 'inherit' });
rmSync(join(root, 'release', 'modules'), { recursive: true, force: true });

function release(arch, runtimeDir) {
  const name = `servermin-${version}${arch ? `-linux-${arch}` : ''}`;
  const out = join(root, 'release', name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const copy = (from, to) => cpSync(join(root, from), join(out, to), { recursive: true });

  mkdirSync(join(out, 'server'));
  for (const f of ['server.js', 'server.js.map', 'module-host.js', 'module-host.js.map']) copy(`packages/core/dist/${f}`, `server/${f}`);
  copy('packages/shell/dist', 'shell');
  mkdirSync(join(out, 'cli'));
  copy('packages/cli/dist/serverctl.js', 'cli/serverctl.js');
  copy('packages/cli/dist/verify.js', 'cli/verify.js');
  mkdirSync(join(out, 'bin'));
  for (const f of ['server-control', 'serverctl', 'servermin-verify', 'node-launcher.sh']) copy(`deploy/${f}`, `bin/${f}`);
  mkdirSync(join(out, 'deploy'));
  for (const f of ['server-control.service', 'sudoers', 'servermin-privileged', 'config.json']) copy(`deploy/${f}`, `deploy/${f}`);
  copy('deploy/install.sh', 'install.sh');
  copy('README.md', 'README.md');
  copy('docs/hardware-checklist.md', 'HARDWARE-CHECKLIST.md');
  writeFileSync(join(out, 'VERSION'), version + '\n');

  for (const id of readdirSync(join(root, 'modules'))) {
    const dir = join(root, 'modules', id);
    if (!existsSync(join(dir, 'module.json'))) continue;
    const { files } = JSON.parse(readFileSync(join(dir, 'integrity.json'), 'utf8'));
    for (const f of [...Object.keys(files), 'integrity.json']) {
      mkdirSync(join(out, 'modules', id, f, '..'), { recursive: true });
      cpSync(join(dir, f), join(out, 'modules', id, f));
    }
  }
  if (runtimeDir) {
    if (!existsSync(join(runtimeDir, 'bin/node'))) throw new Error(`${runtimeDir}/bin/node not found`);
    mkdirSync(join(out, 'node', 'bin'), { recursive: true });
    cpSync(join(runtimeDir, 'bin/node'), join(out, 'node/bin/node'));
    for (const f of ['LICENSE', 'VERSION']) if (existsSync(join(runtimeDir, f))) cpSync(join(runtimeDir, f), join(out, 'node', f));
  }
  const archive = join(root, 'release', `${name}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '--owner=0', '--group=0', '-C', join(root, 'release'), name]);
  const sha = createHash('sha256').update(readFileSync(archive)).digest('hex');
  writeFileSync(`${archive}.sha256`, `${sha}  ${name}.tar.gz\n`);
  return { archive, out };
}

const built = [];
for (const arch of arches) {
  let runtime = localNode;
  if (bundle) {
    console.log(`Node.js ${nodeVersion} for linux-${arch}`);
    runtime = await nodeRuntime(nodeVersion, arch, join(root, '.cache', 'node'));
  }
  const r = release(arch, runtime);
  // A runtime for this machine's architecture can be smoke-tested right away.
  if (runtime && (!arch || arch === hostArch())) {
    const v = execFileSync(join(r.out, 'node/bin/node'), ['-e', "require('node:sqlite'); process.stdout.write(process.version)"]).toString();
    console.log(`  bundled runtime ${v} loads node:sqlite`);
  }
  built.push(`${r.archive.replace(root + '/', '')}${runtime ? ` (Node.js ${existsSync(join(runtime, 'VERSION')) ? runtimeInfo(runtime).split(' ')[0] : 'local'})` : ''}`);
}
for (const id of readdirSync(join(root, 'modules'))) if (existsSync(join(root, 'modules', id, 'module.json'))) pack(join(root, 'modules', id), join(root, 'release', 'modules'));
console.log(`\n${built.map((b) => `✓ ${b}`).join('\n')}\n✓ release/modules/*.tgz`);
