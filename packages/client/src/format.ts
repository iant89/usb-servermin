export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = Math.abs(bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) (v /= 1024), i++;
  return `${bytes < 0 ? '-' : ''}${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '–';
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function formatPercent(v: number | null | undefined, digits = 0) {
  return v === null || v === undefined || !Number.isFinite(v) ? '–' : `${v.toFixed(digits)} %`;
}

export function formatDate(v: string | number | Date | null | undefined) {
  if (v === null || v === undefined || v === '') return '–';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

export function formatRelative(v: string | number | Date | null | undefined) {
  if (!v) return '–';
  const diff = (Date.now() - new Date(v).getTime()) / 1000;
  if (!Number.isFinite(diff)) return '–';
  const abs = Math.abs(diff);
  const r = (n: number, u: string) => `${Math.round(n)} ${u}${Math.round(n) === 1 ? '' : 's'} ${diff >= 0 ? 'ago' : 'from now'}`;
  if (abs < 45) return diff >= 0 ? 'just now' : 'in a moment';
  if (abs < 3600) return r(abs / 60, 'minute');
  if (abs < 86400) return r(abs / 3600, 'hour');
  return r(abs / 86400, 'day');
}

/** Map a lifecycle state to an ENTERPRISE-UI tone. */
export function stateTone(state: string): 'neutral' | 'information' | 'success' | 'warning' | 'error' {
  switch (state) {
    case 'ACTIVE':
    case 'HEALTHY':
    case 'running':
    case 'active':
      return 'success';
    case 'ERROR':
    case 'failed':
    case 'dead':
      return 'error';
    case 'BLOCKED':
    case 'DEGRADED':
    case 'UPDATING':
    case 'RELOADING':
    case 'paused':
    case 'restarting':
      return 'warning';
    case 'LOADING':
    case 'LOADED':
    case 'INSTALLING':
    case 'STOPPING':
    case 'activating':
      return 'information';
    default:
      return 'neutral';
  }
}
