/**
 * Catalogue of privileged operations (§22). These are the only actions that cross the
 * privilege boundary: the core runs as an unprivileged service account and asks a small,
 * root-owned helper to perform exactly one of these operations with validated arguments.
 * Modules must list the operations they use in `host.privileged` in their manifest.
 */
export interface PrivilegedOperationSpec {
  description: string;
  /** Argument names and their validation pattern (enforced by core and by the helper). */
  args: Record<string, { pattern: RegExp; required?: boolean; description: string }>;
  /** Operations that are destructive or cut access require an explicit confirmation flag. */
  confirm?: boolean;
}

const UNIT = /^[A-Za-z0-9@_.:\\-]{1,200}\.(service|socket|timer|target|mount|path)$/;
const DEVICE = /^\/dev\/[A-Za-z0-9/_.:-]{1,120}$/;
const ABS_PATH = /^\/(?!.*\.\.)[A-Za-z0-9/_.@:+-]{0,250}$/;

export const PRIVILEGED_OPERATIONS = {
  'power.reboot': { description: 'Reboot the server', args: {}, confirm: true },
  'power.shutdown': { description: 'Power off the server', args: {}, confirm: true },
  'packages.refresh': { description: 'Refresh the package index (apt-get update)', args: {} },
  'packages.upgrade': { description: 'Install available package upgrades (apt-get upgrade)', args: {}, confirm: true },
  'system.set-hostname': {
    description: 'Change the static hostname',
    args: { hostname: { pattern: /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/, required: true, description: 'New hostname' } },
  },
  'system.set-timezone': {
    description: 'Change the system time zone',
    args: { timezone: { pattern: /^[A-Za-z0-9_+\-/]{1,64}$/, required: true, description: 'IANA time zone' } },
  },
  'system.set-ntp': {
    description: 'Enable or disable network time synchronisation',
    args: { enabled: { pattern: /^(true|false)$/, required: true, description: 'true or false' } },
  },
  'service.start': { description: 'Start a systemd unit', args: { unit: { pattern: UNIT, required: true, description: 'Unit name' } } },
  'service.stop': { description: 'Stop a systemd unit', args: { unit: { pattern: UNIT, required: true, description: 'Unit name' } } },
  'service.restart': { description: 'Restart a systemd unit', args: { unit: { pattern: UNIT, required: true, description: 'Unit name' } } },
  'service.enable': { description: 'Enable a systemd unit at boot', args: { unit: { pattern: UNIT, required: true, description: 'Unit name' } } },
  'service.disable': { description: 'Disable a systemd unit at boot', args: { unit: { pattern: UNIT, required: true, description: 'Unit name' } } },
  'storage.mount': {
    description: 'Mount a block device',
    args: {
      device: { pattern: DEVICE, required: true, description: 'Block device path' },
      target: { pattern: ABS_PATH, required: true, description: 'Mount point' },
      fstype: { pattern: /^[a-z0-9]{2,16}$/, description: 'File system type' },
      readonly: { pattern: /^(true|false)$/, description: 'Mount read-only' },
    },
  },
  'storage.unmount': {
    description: 'Unmount a file system',
    args: { target: { pattern: ABS_PATH, required: true, description: 'Mount point' } },
    confirm: true,
  },
  'storage.smart': {
    description: 'Read S.M.A.R.T. health of a disk',
    args: { device: { pattern: DEVICE, required: true, description: 'Block device path' } },
  },
  'network.apply': {
    description: 'Apply a netplan configuration with automatic rollback',
    args: {
      file: { pattern: ABS_PATH, required: true, description: 'Staged netplan YAML file' },
      rollback: { pattern: /^\d{2,4}$/, required: true, description: 'Seconds before automatic rollback' },
    },
    confirm: true,
  },
  'network.confirm': { description: 'Keep the applied network configuration (cancel rollback)', args: {} },
  'network.rollback': { description: 'Restore the previous network configuration', args: {} },
} satisfies Record<string, PrivilegedOperationSpec>;

export type PrivilegedOperationId = keyof typeof PRIVILEGED_OPERATIONS;

export function isPrivilegedOperation(id: string): id is PrivilegedOperationId {
  return Object.prototype.hasOwnProperty.call(PRIVILEGED_OPERATIONS, id);
}

/** Validates arguments against the catalogue. Returns a list of problems (empty when valid). */
export function validatePrivilegedArgs(id: PrivilegedOperationId, args: Record<string, string>): string[] {
  const spec: PrivilegedOperationSpec = PRIVILEGED_OPERATIONS[id];
  const problems: string[] = [];
  for (const [name, rule] of Object.entries(spec.args)) {
    const value = args[name];
    if (value === undefined || value === '') {
      if (rule.required) problems.push(`Missing argument "${name}"`);
      continue;
    }
    if (typeof value !== 'string' || !rule.pattern.test(value)) problems.push(`Invalid value for "${name}"`);
  }
  for (const name of Object.keys(args)) {
    if (!(name in spec.args)) problems.push(`Unknown argument "${name}"`);
  }
  return problems;
}
