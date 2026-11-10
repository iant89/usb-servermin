import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../../..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

/** A launcher that is installed but whose program is not in the release fails only on a real server. */
describe('release contents', () => {
  const launchers = readdirSync(join(root, 'deploy')).filter((f) => /\$APP\/(cli|server|bin|manager)\//.test(read(`deploy/${f}`)) && !f.endsWith('.mjs') && !f.endsWith('.service'));
  const packaging = read('tools/package.mjs');

  it.each(launchers)('ships the launcher %s and the program it starts', (launcher) => {
    expect(packaging).toContain(`'${launcher}'`);
    const target = read(`deploy/${launcher}`).match(/\$APP\/((?:cli|server|bin|manager)\/[A-Za-z0-9._-]+)/)![1];
    // Copied either by destination path ('cli/verify.js', 'bin/servermin-update.mjs') or by name from a list ('server.js').
    expect(packaging.includes(`'${target}'`) || packaging.includes(`'${target.split('/')[1]}'`), target).toBe(true);
  });

  it('ships the unit the installer installs, and the unit starts a launcher that is shipped', () => {
    const installer = read('deploy/install.sh');
    const unit = installer.match(/\$SRC\/deploy\/([a-z-]+\.service)/)![1];
    expect(packaging).toContain(`'${unit}'`);
    const exec = read(`deploy/${unit}`).match(/^ExecStart=\/opt\/servermin\/bin\/(\S+)$/m)![1];
    expect(launchers).toContain(exec);
    // Installed releases reinstall and start the unit under this file name when they roll back.
    expect(unit).toBe('server-control.service');
    expect(read(`deploy/${unit}`)).toMatch(/^Alias=servermin-agent\.service$/m);
  });
});
