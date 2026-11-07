/** Parsers for lsblk/findmnt JSON and smartctl output. */

export interface BlockDevice {
  name: string;
  path: string;
  type: string;
  size: number;
  fstype: string | null;
  label: string | null;
  uuid: string | null;
  mountpoints: string[];
  model: string | null;
  serial: string | null;
  transport: string | null;
  removable: boolean;
  readOnly: boolean;
  rotational: boolean;
  fsSize: number | null;
  fsUsed: number | null;
  fsAvail: number | null;
  children: BlockDevice[];
}

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
const bool = (v: unknown) => v === true || v === 1 || v === '1';

export function parseLsblk(json: string): BlockDevice[] {
  const data = JSON.parse(json);
  const map = (d: any): BlockDevice => ({
    name: d.name,
    path: d.path ?? `/dev/${d.kname ?? d.name}`,
    type: d.type,
    size: Number(d.size) || 0,
    fstype: d.fstype ?? null,
    label: d.label ?? null,
    uuid: d.uuid ?? null,
    mountpoints: (d.mountpoints ?? (d.mountpoint ? [d.mountpoint] : [])).filter(Boolean),
    model: d.model?.trim() || null,
    serial: d.serial?.trim() || null,
    transport: d.tran ?? null,
    removable: bool(d.rm) || bool(d.hotplug),
    readOnly: bool(d.ro),
    rotational: bool(d.rota),
    fsSize: num(d.fssize),
    fsUsed: num(d.fsused),
    fsAvail: num(d.fsavail),
    children: (d.children ?? []).map(map),
  });
  return (data.blockdevices ?? []).map(map);
}

export function flatten(devices: BlockDevice[]): BlockDevice[] {
  return devices.flatMap((d) => [d, ...flatten(d.children)]);
}

const PSEUDO = new Set(['proc', 'sysfs', 'devtmpfs', 'devpts', 'securityfs', 'cgroup', 'cgroup2', 'pstore', 'bpf', 'debugfs', 'tracefs', 'hugetlbfs', 'mqueue', 'configfs', 'fusectl', 'autofs', 'binfmt_misc', 'efivarfs', 'rpc_pipefs', 'nsfs', 'ramfs', 'squashfs', 'fuse.lxcfs', 'tmpfs', 'overlay', 'nfsd', 'fuse.portal', 'fuse.gvfsd-fuse']);

export interface Mount {
  target: string;
  source: string;
  fstype: string;
  options: string;
  size: number | null;
  used: number | null;
  avail: number | null;
  usePercent: number | null;
}

export function parseFindmnt(json: string, includePseudo = false): Mount[] {
  const out: Mount[] = [];
  const walk = (fs: any[]) => {
    for (const f of fs ?? []) {
      const m: Mount = {
        target: f.target,
        source: f.source,
        fstype: f.fstype,
        options: f.options ?? '',
        size: num(f.size),
        used: num(f.used),
        avail: num(f.avail),
        usePercent: f['use%'] ? parseInt(String(f['use%']), 10) : null,
      };
      if (includePseudo || !PSEUDO.has(m.fstype)) out.push(m);
      walk(f.children);
    }
  };
  walk(JSON.parse(json).filesystems);
  return out;
}

/** Mount points the platform refuses to unmount: the system would break or lose access. */
export const PROTECTED_MOUNTS = ['/', '/boot', '/boot/efi', '/usr', '/var', '/var/lib', '/etc', '/home', '/opt', '/var/lib/servermin', '/opt/servermin', '/var/lib/docker'];

export function isProtectedMount(target: string, extra: string[] = []) {
  const t = target.replace(/\/+$/, '') || '/';
  return [...PROTECTED_MOUNTS, ...extra].includes(t);
}

export function isAllowedMountTarget(target: string, roots: string[]) {
  if (!/^\/[A-Za-z0-9/_.@:+-]+$/.test(target) || target.split('/').includes('..')) return false;
  return roots.some((r) => {
    const root = r.trim().replace(/\/+$/, '');
    return root && target.startsWith(root + '/') && target.length > root.length + 1;
  });
}

export function parseSmart(json: string) {
  const d = JSON.parse(json);
  const attrs: Record<string, number> = {};
  for (const a of d.ata_smart_attributes?.table ?? []) attrs[a.name] = a.raw?.value;
  return {
    passed: d.smart_status?.passed ?? null,
    model: d.model_name ?? null,
    temperature: d.temperature?.current ?? null,
    powerOnHours: d.power_on_time?.hours ?? null,
    reallocatedSectors: attrs.Reallocated_Sector_Ct ?? null,
    pendingSectors: attrs.Current_Pending_Sector ?? null,
    nvmePercentageUsed: d.nvme_smart_health_information_log?.percentage_used ?? null,
    messages: (d.smartctl?.messages ?? []).map((m: any) => m.string),
  };
}
