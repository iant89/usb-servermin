/** Parsers for systemctl and journalctl output. */

export interface Unit {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
  enabled: string | null;
}

/** `systemctl list-units --plain --no-legend`: UNIT LOAD ACTIVE SUB DESCRIPTION… */
export function parseListUnits(text: string): Unit[] {
  const out: Unit[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[●*]\s*/, '').trim();
    if (!line) continue;
    const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (m) out.push({ unit: m[1], load: m[2], active: m[3], sub: m[4], description: m[5], enabled: null });
  }
  return out;
}

/** `systemctl list-unit-files --no-legend`: UNIT STATE [PRESET] */
export function parseUnitFiles(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^(\S+)\s+(\S+)/.exec(line.trim());
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

export function mergeUnits(units: Unit[], files: Map<string, string>): Unit[] {
  const byName = new Map(units.map((u) => [u.unit, { ...u, enabled: files.get(u.unit) ?? null }]));
  for (const [unit, state] of files) {
    if (unit.includes('@.')) continue; // templates
    if (!byName.has(unit)) byName.set(unit, { unit, load: 'not-loaded', active: 'inactive', sub: 'dead', description: '', enabled: state });
  }
  return [...byName.values()].sort((a, b) => a.unit.localeCompare(b.unit));
}

export function parseShow(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

const PRIORITY = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];

export function parseJournal(text: string) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        const e = JSON.parse(l);
        const msg = Array.isArray(e.MESSAGE) ? Buffer.from(e.MESSAGE).toString('utf8') : String(e.MESSAGE ?? '');
        return {
          time: new Date(Number(e.__REALTIME_TIMESTAMP) / 1000).toISOString(),
          priority: PRIORITY[Number(e.PRIORITY ?? 6)] ?? 'info',
          unit: e._SYSTEMD_UNIT ?? e.SYSLOG_IDENTIFIER ?? null,
          pid: e._PID ? Number(e._PID) : null,
          message: msg,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export const UNIT_RE = /^[A-Za-z0-9@_.:\\-]{1,200}\.service$/;
/** Units this module refuses to stop or disable. */
export const SELF_UNITS = ['server-control.service', 'servermin.service'];
/** Units whose stop/disable can cut remote access: allowed only with confirmation. */
export const CRITICAL_UNITS = ['ssh.service', 'sshd.service', 'systemd-networkd.service', 'NetworkManager.service', 'systemd-resolved.service', 'dbus.service', 'systemd-journald.service', 'systemd-logind.service', 'networking.service'];
