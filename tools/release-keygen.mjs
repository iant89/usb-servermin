#!/usr/bin/env node
/**
 * Creates the Ed25519 key pair that signs releases (run once, on your own machine).
 *
 *   npm run release:keygen
 *
 * Writes the public key to deploy/release-signing.pub (commit it: every release ships it, and
 * servers only install updates signed with the matching private key). Prints the private key:
 * store it as the GitHub Actions secret RELEASE_SIGNING_KEY and in a password manager. It is
 * never written to disk.
 */
import { generateKeyPairSync, createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const unknown = process.argv.slice(2).filter((a) => a !== '--force');
if (unknown.length) {
  console.error('usage: npm run release:keygen [-- --force]\n\nCreates the release signing key pair. See docs/releases.md.');
  process.exit(unknown.some((a) => a === '--help' || a === '-h') ? 0 : 2);
}

const root = resolve(import.meta.dirname, '..');
const pubFile = join(root, 'deploy', 'release-signing.pub');
if (existsSync(pubFile) && !process.argv.includes('--force')) {
  console.error(`${pubFile} already exists. Servers trust that key; replacing it means servers on older releases reject new updates.\nUse --force only if you mean to rotate the key.`);
  process.exit(1);
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'pem' });
writeFileSync(pubFile, pub);
const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
console.log(`Public key written to deploy/release-signing.pub (fingerprint ${fingerprint}). Commit it.

Private key — add it as the GitHub Actions secret RELEASE_SIGNING_KEY
(repository Settings → Secrets and variables → Actions → New repository secret),
and keep a copy in a password manager. Anyone with it can publish updates your servers will install.

${privateKey.export({ type: 'pkcs8', format: 'pem' })}`);
