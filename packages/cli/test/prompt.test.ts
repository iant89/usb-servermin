import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const prompt = join(import.meta.dirname, '../src/prompt.ts');

/**
 * Runs promptCredentials in a child process attached to a real pseudo-terminal (Python's pty
 * module), types the given keystrokes, and returns what the terminal showed.
 */
function onTerminal(keys: string[], knownUser?: string) {
  const program = `import('${prompt}').then(async (m) => { const r = await m.promptCredentials(${knownUser ? JSON.stringify(knownUser) : ''}); process.stdout.write('RESULT=' + JSON.stringify(r) + '\\n'); process.exit(0); }).catch((e) => { process.stdout.write('ERROR=' + e.message + '\\n'); process.exit(1); });`;
  const driver = `
import os, pty, sys, time, json, select
keys = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], [sys.argv[2], '-e', sys.argv[3]])
out = b''
def drain(t):
    global out
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                out += os.read(fd, 4096)
            except OSError:
                return
for k in keys:
    drain(0.6)
    os.write(fd, k.encode())
drain(2)
sys.stdout.write(out.decode(errors='replace'))
`;
  const r = spawnSync('python3', ['-c', driver, JSON.stringify(keys), process.execPath, program], { encoding: 'utf8', timeout: 20_000 });
  // Drop terminal control sequences (cursor moves) so assertions see the visible text.
  return r.stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

describe('credential prompt on a real terminal', () => {
  it('reads the username and a hidden password', () => {
    const screen = onTerminal(['admin\r', 's3cret-pass\r']);
    expect(screen).toContain('Username: admin');
    expect(screen).toContain('Password:');
    expect(screen).toContain('RESULT=["admin","s3cret-pass"]');
    expect(screen.split('RESULT=')[0]).not.toContain('s3cret-pass');
  });

  it('asks only for the password when the user is known, and supports backspace', () => {
    const screen = onTerminal(['passx\x7fword\r'], 'admin');
    expect(screen).not.toContain('Username:');
    expect(screen).toContain('RESULT=["admin","password"]');
    expect(screen.split('RESULT=')[0]).not.toContain('pas');
  });

  it('ignores bracketed-paste markers and arrow keys', () => {
    const screen = onTerminal(['\x1b[200~pa55word\x1b[201~\x1b[D\r'], 'admin');
    expect(screen).toContain('RESULT=["admin","pa55word"]');
  });
});
