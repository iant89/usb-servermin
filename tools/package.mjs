#!/usr/bin/env node
/**
 * Builds a release directory and archive:
 *
 *   release/servermin-<version>/
 *     server/   core (server.js, module-host.js)    shell/   web interface
 *     modules/  bundled modules (module.json, dist, integrity.json)
 *     cli/      serverctl.js     bin/  launcher     deploy/  systemd, sudoers, helper, config
 *     install.sh
 *   release/servermin-<version>.tar.gz
 *   release/modules/<id>-<version>.tgz   installable module packages
 *
 *   npm run package [-- --node /path/to/node-v22-linux-x64]   bundle a Node.js runtime (portable USB installs)
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pack } from './build-module.mjs';

const root = resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const args = process.argv.slice(2);
const nodeDir = args.includes('--node') ? resolve(args[args.indexOf('--node') + 1]) : null;

execFileSync(process.execPath, [join(root, 'tools/build.mjs')], { stdio: 'inherit' });

const out = join(root, 'release', `servermin-${version}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const copy = (from, to) => cpSync(join(root, from), join(out, to), { recursive: true });

mkdirSync(join(out, 'server'));
for (const f of ['server.js', 'server.js.map', 'module-host.js', 'module-host.js.map']) copy(`packages/core/dist/${f}`, `server/${f}`);
copy('packages/shell/dist', 'shell');
mkdirSync(join(out, 'cli'));
copy('packages/cli/dist/serverctl.js', 'cli/serverctl.js');
mkdirSync(join(out, 'bin'));
copy('deploy/server-control', 'bin/server-control');
mkdirSync(join(out, 'deploy'));
for (const f of ['server-control.service', 'sudoers', 'servermin-privileged', 'config.json']) copy(`deploy/${f}`, `deploy/${f}`);
copy('deploy/install.sh', 'install.sh');
copy('README.md', 'README.md');
writeFileSync(join(out, 'VERSION'), version + '\n');

for (const id of readdirSync(join(root, 'modules'))) {
  const dir = join(root, 'modules', id);
  if (!existsSync(join(dir, 'module.json'))) continue;
  const { files } = JSON.parse(readFileSync(join(dir, 'integrity.json'), 'utf8'));
  for (const f of [...Object.keys(files), 'integrity.json']) {
    mkdirSync(join(out, 'modules', id, f, '..'), { recursive: true });
    cpSync(join(dir, f), join(out, 'modules', id, f));
  }
  pack(dir, join(root, 'release', 'modules'));
}

if (nodeDir) {
  if (!existsSync(join(nodeDir, 'bin/node'))) throw new Error(`${nodeDir}/bin/node not found`);
  cpSync(nodeDir, join(out, 'node'), { recursive: true });
}

execFileSync('tar', ['-czf', join(root, 'release', `servermin-${version}.tar.gz`), '--owner=0', '--group=0', '-C', join(root, 'release'), `servermin-${version}`]);
console.log(`\n✓ release/servermin-${version}.tar.gz${nodeDir ? ' (with Node.js runtime)' : ''}\n✓ release/modules/*.tgz`);
