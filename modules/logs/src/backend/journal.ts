export const PRIORITIES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'] as const;

export interface LogLine {
  time: string;
  priority: (typeof PRIORITIES)[number];
  source: string;
  pid: number | null;
  message: string;
  cursor?: string;
}

export function parseJournalLine(line: string): LogLine | null {
  try {
    const e = JSON.parse(line);
    const message = Array.isArray(e.MESSAGE) ? Buffer.from(e.MESSAGE).toString('utf8') : String(e.MESSAGE ?? '');
    return {
      time: new Date(Number(e.__REALTIME_TIMESTAMP) / 1000).toISOString(),
      priority: PRIORITIES[Number(e.PRIORITY ?? 6)] ?? 'info',
      source: e._SYSTEMD_UNIT ?? e.SYSLOG_IDENTIFIER ?? e._COMM ?? 'kernel',
      pid: e._PID ? Number(e._PID) : null,
      message,
      cursor: e.__CURSOR,
    };
  } catch {
    return null;
  }
}

export interface JournalQuery {
  unit?: string;
  priority?: string;
  since?: string;
  until?: string;
  search?: string;
  lines?: number;
  boot?: boolean;
}

const UNIT_RE = /^[A-Za-z0-9@_.:\\-]{1,200}$/;
const TIME_RE = /^[0-9A-Za-z :.+-]{1,40}$/;

/** Builds journalctl arguments from user input. Everything is validated; nothing reaches a shell. */
export function journalArgs(q: JournalQuery, follow = false): string[] {
  const args = ['-o', 'json', '--no-pager'];
  if (q.unit) {
    if (!UNIT_RE.test(q.unit)) throw new Error('Invalid unit');
    args.push('-u', q.unit);
  }
  if (q.priority) {
    if (!/^[0-7]$/.test(q.priority)) throw new Error('Invalid priority');
    args.push('-p', q.priority);
  }
  for (const [flag, v] of [['--since', q.since], ['--until', q.until]] as const) {
    if (!v) continue;
    if (!TIME_RE.test(v)) throw new Error(`Invalid ${flag.slice(2)}`);
    args.push(flag, v);
  }
  if (q.search) {
    if (q.search.length > 200) throw new Error('Search is too long');
    // --grep takes a regular expression; escape it so users search literally, case-insensitively.
    args.push('--grep', q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), '--case-sensitive=false');
  }
  if (q.boot) args.push('-b');
  args.push('-n', String(q.lines ?? 500));
  if (follow) args.push('-f');
  return args;
}

export function toText(lines: LogLine[]) {
  return lines.map((l) => `${l.time} ${l.priority.toUpperCase().padEnd(7)} ${l.source}${l.pid ? `[${l.pid}]` : ''}: ${l.message}`).join('\n') + '\n';
}
