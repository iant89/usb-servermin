import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  PRIVILEGED_OPERATIONS,
  validatePrivilegedArgs,
  type ExecuteOptions,
  type Logger,
  type PrivilegedOperationId,
  type ProcessResult,
  type RequestUser,
  type SpawnHandlers,
} from '@servermin/sdk';
import type { AuditLog } from '../audit/audit';
import type { PrivilegedMode } from '../config/config';

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const BLOCKED_ENV = /^(LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$|PYTHONPATH$|PYTHONSTARTUP$|PERL5OPT$|IFS$)/;
const MAX_PER_OWNER = 16;
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024;

interface Running {
  id: string;
  owner: string;
  command: string;
  args: string[];
  startedAt: number;
  child: ChildProcess;
  longRunning: boolean;
}

/**
 * Controlled process execution (§21). Modules can only run executables declared in their
 * manifest; no shell is involved (arguments are passed as an array), the environment is
 * sanitised, output is bounded, every run has a timeout and can be cancelled, and every
 * process a module started is killed when it unloads.
 */
export class ProcessService {
  private running = new Map<string, Running>();
  private whichCache = new Map<string, string | null>();

  constructor(
    private readonly opts: {
      logger: Logger;
      audit: AuditLog;
      privilegedMode: PrivilegedMode;
      helper: string;
      /** Extra PATH entries (development). */
      path?: string;
    },
  ) {}

  private searchPath() {
    return (this.opts.path ?? process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin').split(delimiter);
  }

  async which(command: string): Promise<string | null> {
    if (this.whichCache.has(command)) return this.whichCache.get(command)!;
    let found: string | null = null;
    if (isAbsolute(command)) {
      found = (await access(command, constants.X_OK).then(() => true, () => false)) ? command : null;
    } else if (/^[A-Za-z0-9_.+-]+$/.test(command)) {
      for (const dir of this.searchPath()) {
        const candidate = join(dir, command);
        if (await access(candidate, constants.X_OK).then(() => true, () => false)) {
          found = candidate;
          break;
        }
      }
    }
    this.whichCache.set(command, found);
    setTimeout(() => this.whichCache.delete(command), 60_000).unref();
    return found;
  }

  private async resolve(owner: string, allowed: readonly string[], command: string): Promise<string> {
    if (!allowed.includes(command)) throw new ProcessError(`Command "${command}" is not declared by ${owner}`, 403);
    const path = await this.which(command);
    if (!path) throw new ProcessError(`Command "${command}" is not installed on this host`, 424);
    return path;
  }

  private env(extra?: Record<string, string>) {
    const env: Record<string, string> = {
      PATH: this.searchPath().join(delimiter),
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      HOME: process.env.HOME ?? '/var/lib/servermin',
      TERM: 'xterm-256color',
    };
    for (const [k, v] of Object.entries(extra ?? {})) if (!BLOCKED_ENV.test(k) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env[k] = String(v);
    return env;
  }

  private guardCapacity(owner: string) {
    const n = [...this.running.values()].filter((r) => r.owner === owner).length;
    if (n >= MAX_PER_OWNER) throw new ProcessError(`${owner} already has ${n} running processes`, 429);
  }

  async execute(owner: string, allowed: readonly string[], options: ExecuteOptions): Promise<ProcessResult> {
    const path = await this.resolve(owner, allowed, options.command);
    return this.run(owner, path, options);
  }

  private run(owner: string, path: string, options: ExecuteOptions, logName = options.command): Promise<ProcessResult> {
    this.guardCapacity(owner);
    const args = (options.args ?? []).map(String);
    const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT, 30 * 60_000);
    const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const started = Date.now();
    return new Promise<ProcessResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(path, args, { cwd: options.cwd, env: this.env(options.env), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      } catch (e) {
        reject(new ProcessError(`Failed to start ${logName}: ${(e as Error).message}`, 500));
        return;
      }
      const id = randomUUID();
      this.running.set(id, { id, owner, command: logName, args, startedAt: started, child, longRunning: false });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outLen = 0;
      let errLen = 0;
      let timedOut = false;
      let cancelled = false;
      child.stdout!.on('data', (d: Buffer) => {
        if (outLen < max) out.push(d.subarray(0, max - outLen));
        outLen += d.length;
      });
      child.stderr!.on('data', (d: Buffer) => {
        if (errLen < max) err.push(d.subarray(0, max - errLen));
        errLen += d.length;
      });
      const kill = () => {
        child.kill('SIGTERM');
        setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL'), 3000).unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      const onAbort = () => {
        cancelled = true;
        kill();
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => {
        clearTimeout(timer);
        this.running.delete(id);
        reject(new ProcessError(`Failed to run ${logName}: ${e.message}`, 500));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        this.running.delete(id);
        const result: ProcessResult = {
          exitCode: code,
          signal: signal ?? null,
          stdout: Buffer.concat(out).toString('utf8') + (outLen > max ? '\n[output truncated]' : ''),
          stderr: Buffer.concat(err).toString('utf8') + (errLen > max ? '\n[output truncated]' : ''),
          timedOut,
          cancelled,
          durationMs: Date.now() - started,
        };
        this.opts.logger.debug(`exec ${logName} ${args.join(' ')}`.slice(0, 500), { owner, exitCode: code, durationMs: result.durationMs, timedOut });
        resolve(result);
      });
      if (options.input !== undefined) child.stdin!.end(options.input);
      else child.stdin!.end();
    });
  }

  async spawn(
    owner: string,
    allowed: readonly string[],
    options: Omit<ExecuteOptions, 'input' | 'maxOutputBytes' | 'signal'> & { control?: boolean },
    handlers: SpawnHandlers,
  ) {
    const path = await this.resolve(owner, allowed, options.command);
    this.guardCapacity(owner);
    const args = (options.args ?? []).map(String);
    const child = spawn(path, args, {
      cwd: options.cwd,
      env: this.env(options.env),
      stdio: options.control ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    const id = randomUUID();
    this.running.set(id, { id, owner, command: options.command, args, startedAt: Date.now(), child, longRunning: true });
    child.stdout!.setEncoding('utf8').on('data', (d: string) => handlers.onStdout?.(d));
    child.stderr!.setEncoding('utf8').on('data', (d: string) => handlers.onStderr?.(d));
    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs) timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs);
    child.on('error', (e) => handlers.onStderr?.(`failed: ${e.message}\n`));
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      this.running.delete(id);
      handlers.onExit?.({ exitCode: code, signal: signal ?? null });
    });
    this.opts.logger.debug(`spawn ${options.command} ${args.join(' ')}`.slice(0, 500), { owner, id });
    return {
      id,
      write: (data: string) => {
        if (child.stdin?.writable) child.stdin.write(data);
      },
      kill: (signal: NodeJS.Signals = 'SIGTERM') => {
        child.kill(signal);
      },
      control: (message: unknown) => {
        const fd3 = child.stdio[3] as NodeJS.WritableStream | undefined;
        if (fd3 && 'writable' in fd3 && (fd3 as any).writable) fd3.write(JSON.stringify(message) + '\n');
      },
    };
  }

  /** Kill every process an owner started (module unload, §13). */
  killOwner(owner: string): number {
    let n = 0;
    for (const r of this.running.values()) {
      if (r.owner !== owner) continue;
      r.child.kill('SIGTERM');
      const child = r.child;
      setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL'), 2000).unref();
      n++;
    }
    return n;
  }

  list() {
    return [...this.running.values()].map((r) => ({ id: r.id, owner: r.owner, command: r.command, args: r.args, startedAt: new Date(r.startedAt).toISOString(), longRunning: r.longRunning, pid: r.child.pid }));
  }

  /**
   * Cross the privilege boundary (§22). The operation must be declared by the module, its
   * arguments must pass the catalogue's validation, and destructive operations need explicit
   * confirmation. Every attempt is audited.
   */
  async privileged(
    owner: string,
    allowed: readonly string[],
    operation: PrivilegedOperationId,
    args: Record<string, string> = {},
    opts: { confirmed?: boolean; user?: RequestUser | string } = {},
  ): Promise<ProcessResult> {
    const user = typeof opts.user === 'string' ? opts.user : opts.user?.username;
    const audit = (result: 'success' | 'failure', metadata: Record<string, unknown>) =>
      this.opts.audit.record({ user: user ?? `module:${owner}`, action: `privileged.${operation}`, module: owner, target: Object.values(args).join(' ') || undefined, result, metadata });
    const fail = (status: number, message: string) => {
      audit('failure', { reason: message });
      return new ProcessError(message, status);
    };
    const spec = PRIVILEGED_OPERATIONS[operation];
    if (!spec) throw fail(400, `Unknown privileged operation "${operation}"`);
    if (!allowed.includes(operation)) throw fail(403, `${owner} did not declare privileged operation "${operation}"`);
    const problems = validatePrivilegedArgs(operation, args);
    if (problems.length) throw fail(400, problems.join('; '));
    if ((spec as { confirm?: boolean }).confirm && !opts.confirmed) throw fail(428, `"${operation}" requires explicit confirmation`);
    if (this.opts.privilegedMode === 'disabled') throw fail(403, 'Privileged operations are disabled on this server');

    const argv = [operation, ...Object.entries(args).map(([k, v]) => `${k}=${v}`)];
    if (this.opts.privilegedMode === 'simulate') {
      this.opts.logger.info(`[simulated] privileged ${argv.join(' ')}`, { owner });
      audit('success', { simulated: true });
      return { exitCode: 0, signal: null, stdout: `simulated: ${argv.join(' ')}\n`, stderr: '', timedOut: false, cancelled: false, durationMs: 0 };
    }
    const sudo = await this.which('sudo');
    if (!sudo) throw fail(424, 'sudo is not installed');
    const result = await this.run(owner, sudo, { command: 'sudo', args: ['-n', this.opts.helper, ...argv], timeoutMs: operation === 'packages.upgrade' ? 30 * 60_000 : 120_000 }, `privileged ${operation}`);
    audit(result.exitCode === 0 ? 'success' : 'failure', { exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) });
    return result;
  }
}
