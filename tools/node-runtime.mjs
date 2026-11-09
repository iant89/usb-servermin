/**
 * Downloads an official Node.js Linux build, verifies it against the SHA-256 published in
 * nodejs.org's SHASUMS256.txt, and extracts the runtime (bin/node and LICENSE only) into a cache.
 * Used by `npm run package -- --bundle-node` so a portable installation does not depend on the
 * host having a recent Node.js (Ubuntu's packages are too old for node:sqlite).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MIRROR = process.env.NODE_DIST_MIRROR ?? 'https://nodejs.org/dist';

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Parses SHASUMS256.txt into a map of file name → hash. */
export function parseShasums(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

/**
 * Returns the directory of a verified runtime: <cache>/<version>-linux-<arch>/{bin/node,LICENSE}.
 */
export async function nodeRuntime(version, arch, cacheDir, log = console.log) {
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid Node.js version ${version}`);
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported architecture ${arch} (use x64 or arm64)`);
  const name = `node-${version}-linux-${arch}`;
  const target = join(cacheDir, `${version}-linux-${arch}`);
  const marker = join(target, '.verified');
  if (existsSync(marker)) return target;

  log(`  downloading ${name}.tar.xz`);
  const sums = parseShasums((await fetchBuffer(`${MIRROR}/${version}/SHASUMS256.txt`)).toString('utf8'));
  const expected = sums.get(`${name}.tar.xz`);
  if (!expected) throw new Error(`${name}.tar.xz is not listed in SHASUMS256.txt`);
  const archive = await fetchBuffer(`${MIRROR}/${version}/${name}.tar.xz`);
  const actual = createHash('sha256').update(archive).digest('hex');
  if (actual !== expected) throw new Error(`Checksum mismatch for ${name}.tar.xz: expected ${expected}, got ${actual}`);
  log(`  verified sha256 ${actual.slice(0, 16)}…`);

  const work = join(cacheDir, `.extract-${name}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const file = join(work, `${name}.tar.xz`);
  writeFileSync(file, archive);
  execFileSync('tar', ['-xJf', file, '-C', work, `${name}/bin/node`, `${name}/LICENSE`]);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(join(target, 'bin'), { recursive: true });
  copyFileSync(join(work, name, 'bin/node'), join(target, 'bin/node'));
  chmodSync(join(target, 'bin/node'), 0o755);
  copyFileSync(join(work, name, 'LICENSE'), join(target, 'LICENSE'));
  writeFileSync(join(target, 'VERSION'), `${version} linux-${arch} sha256:${actual}\n`);
  rmSync(work, { recursive: true, force: true });
  writeFileSync(marker, actual + '\n');
  return target;
}

export function hostArch() {
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

export function runtimeInfo(dir) {
  return readFileSync(join(dir, 'VERSION'), 'utf8').trim();
}
