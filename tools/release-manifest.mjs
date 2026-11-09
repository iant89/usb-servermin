/**
 * The signed release manifest (release.json + release.json.sig). Servers verify the signature
 * with the public key of the release they run, then check every downloaded file against the
 * SHA-256 listed here.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

export const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

export function describeFile(file) {
  return { file: basename(file), sha256: sha256(file), size: statSync(file).size };
}

export function keyFingerprint(publicKeyPem) {
  return createHash('sha256').update(createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

/** Writes release.json and, with a private key, release.json.sig (base64 Ed25519 over the exact bytes). */
export function writeManifest(path, manifest, { privateKeyPem, publicKeyPem } = {}) {
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(path, bytes);
  if (!privateKeyPem) return null;
  const key = createPrivateKey(privateKeyPem);
  // Refuse to sign with a key servers would not accept.
  const derived = createPublicKey(key).export({ type: 'spki', format: 'pem' });
  if (!publicKeyPem || createPublicKey(publicKeyPem).export({ type: 'spki', format: 'pem' }) !== derived)
    throw new Error('RELEASE_SIGNING_KEY does not match deploy/release-signing.pub');
  const signature = sign(null, bytes, key).toString('base64');
  writeFileSync(`${path}.sig`, signature + '\n');
  if (!verify(null, bytes, createPublicKey(publicKeyPem), Buffer.from(signature, 'base64'))) throw new Error('Signature self-check failed');
  return signature;
}
