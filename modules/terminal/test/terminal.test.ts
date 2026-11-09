import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestContext, testUser } from '@servermin/sdk/testing';
import manifest from '../module.json';
import terminal from '../src/backend/index';
import { PTY_BRIDGE } from '../src/backend/pty-bridge';

describe('pty bridge', () => {
  it('runs a shell on a real pseudo-terminal and applies resize messages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-'));
    const file = join(dir, 'bridge.py');
    writeFileSync(file, PTY_BRIDGE);
    const child = spawn('python3', [file, '/bin/sh', '30', '100'], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const wait = (re: RegExp) =>
      new Promise<void>((resolve, reject) => {
        const t = setInterval(() => re.test(out) && (clearInterval(t), resolve()), 20);
        setTimeout(() => (clearInterval(t), reject(new Error(`timeout waiting for ${re}; got ${JSON.stringify(out)}`))), 5000);
      });
    child.stdin.write('stty size; tty\n');
    // Output arrives in chunks: wait for each expected line instead of assuming they come together.
    await wait(/30 100/);
    await wait(/\/dev\/pts\/\d+/);
    (child.stdio[3] as NodeJS.WritableStream).write(JSON.stringify({ type: 'resize', rows: 40, cols: 120 }) + '\n');
    await new Promise((r) => setTimeout(r, 100));
    child.stdin.write('stty size\n');
    await wait(/40 120/);
    child.stdin.write('exit\n');
    const code = await new Promise((r) => child.on('exit', r));
    expect(code).toBe(0);
  });
});

describe('terminal module', () => {
  it('requires the terminal.access permission and audits sessions', async () => {
    const t = createTestContext(manifest as any, { dataDir: mkdtempSync(join(tmpdir(), 'term-')), commands: { python3: () => '' } });
    await t.start(terminal);
    expect((await t.request('GET', '/status', { user: testUser(['system.read']) })).status).toBe(403);
    const sub = await t.subscribe('session', { rows: 24, cols: 80 });
    expect(t.executed[0].command).toBe('python3');
    expect(t.audit[0]).toMatchObject({ action: 'terminal.session.start' });
    sub.unsubscribe();
    expect(t.audit.some((a) => a.action === 'terminal.session.end')).toBe(true);
    await t.stop();
  });
});
