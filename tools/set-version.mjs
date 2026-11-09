#!/usr/bin/env node
/** Sets the core/release version: npm run set-version -- 1.1.0 (then commit, tag v1.1.0 and push the tag). */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('Usage: npm run set-version -- <major.minor.patch>');
  process.exit(1);
}
const pkgFile = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
const previous = pkg.version;
pkg.version = version;
writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
const versionFile = join(root, 'packages/core/src/version.ts');
writeFileSync(versionFile, readFileSync(versionFile, 'utf8').replace(/CORE_VERSION = '[^']+'/, `CORE_VERSION = '${version}'`));
console.log(`Version ${previous} → ${version}. Next:\n  git commit -am "Release ${version}" && git tag v${version} && git push origin main v${version}`);
