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
  let username = knownUser;
  if (!username) {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    username = (await rl.question('Username: ')).trim();
    rl.close();
  }
  return [username, await readHidden('Password: ')];
}

/**
 * Reads one line from the terminal without echoing it, using raw mode (public API only).
 * Enter finishes, Backspace deletes, Ctrl+C aborts, Ctrl+D finishes like Enter.
 */
export function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let value = '';
    const finish = (abort = false) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      if (abort) process.exit(130);
      resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish();
        if (ch === '\u0003') return finish(true);
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
  });
}
