import { createInterface } from 'node:readline/promises';

/**
 * Reads a username and password from the terminal (password hidden) or from piped stdin
 * (one per line). When `knownUser` is given, only the password is read.
 */
export async function promptCredentials(knownUser?: string): Promise<[string, string]> {
  const needed = knownUser ? 1 : 2;
  if (!process.stdin.isTTY) {
    const lines: string[] = [];
    for await (const line of createInterface({ input: process.stdin })) if (lines.push(line) === needed) break;
    if (lines.length < needed) throw new Error(knownUser ? 'Expected a password on standard input' : 'Expected a username and a password on standard input');
    return knownUser ? [knownUser, lines[0]] : [lines[0].trim(), lines[1]];
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const username = knownUser ?? (await rl.question('Username: ')).trim();
  const output = rl as unknown as { _writeToOutput(s: string): void };
  const original = output._writeToOutput.bind(rl);
  process.stdout.write('Password: ');
  output._writeToOutput = (s: string) => (s.includes('\n') || s.includes('\r') ? original('\n') : undefined);
  const password = await rl.question('');
  output._writeToOutput = original;
  rl.close();
  return [username, password];
}

