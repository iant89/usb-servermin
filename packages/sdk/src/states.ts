/**
 * Module lifecycle states (design spec §12).
 *
 * Installation: DISCOVERED → VALIDATING → VALID → INSTALLING → INSTALLED → LOADING → LOADED → ACTIVE
 * Runtime:      ACTIVE, DISABLED, STOPPING, STOPPED, RELOADING, UPDATING, ERROR
 *
 * BLOCKED is an extension of the spec: the module is enabled, but a required dependency or
 * capability is unavailable, so it stays inactive until the dependency becomes ACTIVE (§18).
 */
export const MODULE_STATES = [
  'DISCOVERED',
  'VALIDATING',
  'VALID',
  'INSTALLING',
  'INSTALLED',
  'LOADING',
  'LOADED',
  'ACTIVE',
  'DISABLED',
  'STOPPING',
  'STOPPED',
  'RELOADING',
  'UPDATING',
  'BLOCKED',
  'ERROR',
] as const;

export type ModuleState = (typeof MODULE_STATES)[number];

/** Health model (§44). Module health is independent from core health. */
export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'ERROR' | 'OFFLINE';

export interface HealthResult {
  status: HealthStatus;
  message?: string;
  details?: Record<string, unknown>;
}
