/**
 * Permission model (§19). Permissions are dotted strings such as `docker.read`.
 * Users hold permissions independently of modules; modules declare the permissions their
 * routes and channels require. A user permission may use a trailing wildcard (`docker.*`)
 * or the global wildcard `*` (administrator).
 */

/** Permissions owned by the core platform. Module manifests may not declare these namespaces. */
export const CORE_PERMISSIONS = {
  'modules.read': 'View installed modules, their status and logs',
  'modules.install': 'Install and update modules',
  'modules.remove': 'Remove modules',
  'modules.configure': 'Enable, disable, reload and configure modules',
  'users.manage': 'Create, edit and delete users',
  'audit.read': 'Read the audit log',
  'platform.logs.read': 'Read platform and module logs',
  'platform.config': 'Change core platform configuration',
} as const;

export type CorePermission = keyof typeof CORE_PERMISSIONS;

/** Namespaces reserved for the core. */
export const RESERVED_PERMISSION_NAMESPACES = ['modules', 'users', 'audit', 'platform', 'core', 'auth'];

/** Special route permission: any signed-in user. */
export const AUTHENTICATED = 'authenticated';

/** Special route permission: no session required (use sparingly, e.g. health probes). */
export const PUBLIC = 'public';

export const PERMISSION_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

export function isValidPermission(permission: string): boolean {
  return PERMISSION_RE.test(permission);
}

/** Does a set of granted permissions (which may contain wildcards) include `required`? */
export function hasPermission(granted: readonly string[], required: string): boolean {
  if (required === PUBLIC || required === AUTHENTICATED) return true;
  for (const g of granted) {
    if (g === '*' || g === required) return true;
    if (g.endsWith('.*') && required.startsWith(g.slice(0, -1))) return true;
  }
  return false;
}
