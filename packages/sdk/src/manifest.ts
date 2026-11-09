import type { ConfigField } from './config-schema';
import { RESERVED_PERMISSION_NAMESPACES, isValidPermission } from './permissions';
import { isPrivilegedOperation, type PrivilegedOperationId } from './privileged';
import { isValidRange, isValidVersion, satisfies } from './semver';

/** Major version of the module API implemented by this SDK and the core. */
export const MODULE_API_VERSION = 1;

export interface PermissionDefinition {
  id: string;
  description: string;
}

export interface CapabilityRequirement {
  /** Service name provided by another module (see `provides`), e.g. `docker.engine`. */
  capability: string;
  /** When true, the module starts without it and can check `services.available()`. @default false */
  optional?: boolean;
}

export interface ChannelDefinition {
  /** Channel name, local to the module. Clients subscribe to `<moduleId>.<name>`. */
  name: string;
  /** Permission required to subscribe. */
  permission: string;
  description?: string;
}

/**
 * Module manifest (`module.json`, §11). Everything the core needs to validate, install and
 * activate a module without executing any of its code.
 */
export interface ModuleManifest {
  /** Unique id: lowercase letters, digits and hyphens. */
  id: string;
  name: string;
  /** Semantic version of the module. Modules are versioned independently of the core (§50). */
  version: string;
  description?: string;
  author?: string;
  license?: string;
  homepage?: string;
  /** Module API major version this module targets. */
  apiVersion: number;
  /** Semver range of core versions this module supports. @default '*' */
  coreVersion?: string;
  /** Other modules required by id, with a semver range. */
  dependencies?: Record<string, string>;
  /** Services required from whichever module provides them (allows replacement, §61). */
  requires?: CapabilityRequirement[];
  /** Descriptive capability tags, e.g. `containers`, `images`. */
  capabilities?: string[];
  /** Services this module provides to other modules through `ctx.services`. */
  provides?: string[];
  /** Permissions this module's routes and channels require. */
  permissions?: PermissionDefinition[];
  /** Real-time channels. */
  channels?: ChannelDefinition[];
  /** Event namespaces this module publishes in. Defaults to its own id. */
  events?: { publishes?: string[]; subscribes?: string[] };
  /** Host access the module needs. The process service refuses anything not declared here. */
  host?: {
    /** Executables the module may run through `ctx.process` (bare names resolved on PATH, or absolute paths). */
    commands?: string[];
    /** Privileged operations the module may request. */
    privileged?: PrivilegedOperationId[];
  };
  /** Settings schema. */
  config?: ConfigField[];
  backend?: {
    /** Path of the backend bundle, relative to the module root. */
    entry: string;
    /** Heap limit of the module worker. @default 192 */
    maxMemoryMb?: number;
  };
  frontend?: {
    /** Path of the frontend bundle (IIFE), relative to the module root. */
    entry: string;
    /** Optional stylesheet, relative to the module root. */
    style?: string;
  };
}

export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export const MODULE_ID_RE = /^[a-z][a-z0-9-]{1,47}$/;
const SERVICE_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const REL_PATH_RE = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9_./-]+$/;
const COMMAND_RE = /^(\/[A-Za-z0-9_./+-]+|[A-Za-z0-9_.+-]+)$/;

/** Validates an untrusted manifest object (§34). */
export function validateManifest(input: unknown, opts: { coreVersion?: string } = {}): ManifestValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const m = input as Partial<ModuleManifest> | null;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { valid: false, errors: ['Manifest must be a JSON object'], warnings };

  const str = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  if (!str(m.id) || !MODULE_ID_RE.test(m.id!)) errors.push('id must be 2-48 lowercase letters, digits or hyphens, starting with a letter');
  if (!str(m.name)) errors.push('name is required');
  if (!str(m.version) || !isValidVersion(m.version!)) errors.push('version must be a semantic version (x.y.z)');
  if (typeof m.apiVersion !== 'number') errors.push('apiVersion is required');
  else if (m.apiVersion !== MODULE_API_VERSION) errors.push(`apiVersion ${m.apiVersion} is not supported (this core implements ${MODULE_API_VERSION})`);
  if (m.coreVersion !== undefined) {
    if (!str(m.coreVersion) || !isValidRange(m.coreVersion)) errors.push('coreVersion must be a semver range');
    else if (opts.coreVersion && !satisfies(opts.coreVersion, m.coreVersion)) errors.push(`Requires core ${m.coreVersion}, but this core is ${opts.coreVersion}`);
  }

  if (m.dependencies !== undefined) {
    if (typeof m.dependencies !== 'object' || Array.isArray(m.dependencies)) errors.push('dependencies must be an object of id → version range');
    else
      for (const [dep, range] of Object.entries(m.dependencies)) {
        if (!MODULE_ID_RE.test(dep)) errors.push(`dependency id "${dep}" is invalid`);
        if (dep === m.id) errors.push('a module cannot depend on itself');
        if (typeof range !== 'string' || !isValidRange(range)) errors.push(`dependency "${dep}" has an invalid version range`);
      }
  }
  if (m.requires !== undefined) {
    if (!Array.isArray(m.requires)) errors.push('requires must be an array');
    else for (const r of m.requires) if (!r || !SERVICE_RE.test(r.capability)) errors.push(`required capability "${r?.capability}" is invalid`);
  }
  const arrayOfStrings = (name: string, v: unknown, re?: RegExp) => {
    if (v === undefined) return;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) errors.push(`${name} must be an array of strings`);
    else if (re) for (const x of v) if (!re.test(x)) errors.push(`${name}: "${x}" is invalid`);
  };
  arrayOfStrings('capabilities', m.capabilities);
  arrayOfStrings('provides', m.provides, SERVICE_RE);

  const declared = new Set<string>();
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) errors.push('permissions must be an array');
    else
      for (const p of m.permissions) {
        if (!p || typeof p.id !== 'string' || !isValidPermission(p.id)) {
          errors.push(`permission "${p?.id}" is invalid (use namespace.action)`);
          continue;
        }
        if (RESERVED_PERMISSION_NAMESPACES.includes(p.id.split('.')[0])) errors.push(`permission "${p.id}" uses a namespace reserved for the core`);
        if (!str(p.description)) warnings.push(`permission "${p.id}" has no description`);
        declared.add(p.id);
      }
  }
  if (m.channels !== undefined) {
    if (!Array.isArray(m.channels)) errors.push('channels must be an array');
    else
      for (const c of m.channels) {
        if (!c || !/^[a-z][a-z0-9-]*$/.test(c.name)) errors.push(`channel name "${c?.name}" is invalid`);
        else if (!declared.has(c.permission) && c.permission !== 'authenticated') errors.push(`channel "${c.name}" requires undeclared permission "${c.permission}"`);
      }
  }
  if (m.events !== undefined) {
    arrayOfStrings('events.publishes', m.events.publishes, /^[a-z][a-z0-9-]*$/);
    arrayOfStrings('events.subscribes', m.events.subscribes);
    for (const ns of m.events.publishes ?? []) if (['module', 'core', 'config', 'auth', 'platform'].includes(ns)) errors.push(`event namespace "${ns}" is reserved for the core`);
  }
  if (m.host !== undefined) {
    arrayOfStrings('host.commands', m.host.commands, COMMAND_RE);
    for (const op of m.host.privileged ?? []) if (!isPrivilegedOperation(op)) errors.push(`unknown privileged operation "${op}"`);
    if (m.host.commands?.some((c) => ['sh', 'bash', 'dash', 'zsh', 'sudo', 'su', 'env'].includes(c.split('/').pop()!)))
      warnings.push('host.commands includes a shell or privilege tool; the module can run arbitrary commands');
  }
  if (m.config !== undefined) {
    if (!Array.isArray(m.config)) errors.push('config must be an array of fields');
    else {
      const keys = new Set<string>();
      for (const f of m.config) {
        if (!f || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(f.key)) errors.push(`config key "${f?.key}" is invalid`);
        else if (keys.has(f.key)) errors.push(`config key "${f.key}" is duplicated`);
        else keys.add(f.key);
        if (!['string', 'number', 'boolean', 'enum', 'secret'].includes(f?.type)) errors.push(`config "${f?.key}" has an invalid type`);
        if (f?.type === 'enum' && (!Array.isArray(f.options) || !f.options.length)) errors.push(`config "${f.key}" needs options`);
      }
    }
  }
  if (m.backend !== undefined && (!m.backend || !str(m.backend.entry) || !REL_PATH_RE.test(m.backend.entry))) errors.push('backend.entry must be a relative path');
  if (m.backend?.maxMemoryMb !== undefined && (typeof m.backend.maxMemoryMb !== 'number' || m.backend.maxMemoryMb < 32 || m.backend.maxMemoryMb > 4096))
    errors.push('backend.maxMemoryMb must be between 32 and 4096');
  if (m.frontend !== undefined) {
    if (!m.frontend || !str(m.frontend.entry) || !REL_PATH_RE.test(m.frontend.entry)) errors.push('frontend.entry must be a relative path');
    if (m.frontend?.style !== undefined && !REL_PATH_RE.test(m.frontend.style)) errors.push('frontend.style must be a relative path');
  }
  if (!m.backend && !m.frontend) warnings.push('module has neither a backend nor a frontend');

  return { valid: errors.length === 0, errors, warnings };
}

/** Event namespaces a module may publish in. */
export function publishNamespaces(m: ModuleManifest): string[] {
  return [m.id, ...(m.events?.publishes ?? [])];
}
