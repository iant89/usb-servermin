import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomToken } from './passwords';

/**
 * First-run setup token: creating the first administrator needs a secret that only someone with
 * access to the machine can read, so nobody on the network can claim a fresh installation.
 */
export class SetupToken {
  constructor(readonly file: string) {}

  /** Creates the token if needed and returns it. Call only while no user exists. */
  ensure(): string {
    if (!existsSync(this.file)) writeFileSync(this.file, randomToken(12) + '\n', { mode: 0o600 });
    return readFileSync(this.file, 'utf8').trim();
  }

  check(token: string): boolean {
    return existsSync(this.file) && readFileSync(this.file, 'utf8').trim() === token.trim();
  }

  consume() {
    rmSync(this.file, { force: true });
  }
}
