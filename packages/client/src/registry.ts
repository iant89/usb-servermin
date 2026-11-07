/**
 * Frontend contribution registry (§14, §57). Module bundles call `registerFrontend(id, …)`; the
 * shell renders navigation, routes, widgets, commands and status indicators from it. When a
 * module is disabled, reloaded or removed the shell unregisters it and its UI disappears.
 */
import type { FrontendContribution } from '@servermin/sdk';

export interface RegisteredFrontend {
  moduleId: string;
  revision: number;
  contribution: FrontendContribution;
}

const entries = new Map<string, RegisteredFrontend>();
const listeners = new Set<() => void>();
let snapshot: RegisteredFrontend[] = [];
let pendingRevision = new Map<string, number>();

function emit() {
  snapshot = [...entries.values()];
  for (const l of listeners) l();
}

export function registerFrontend(moduleId: string, contribution: FrontendContribution) {
  const previous = entries.get(moduleId);
  if (previous) safeDispose(previous);
  entries.set(moduleId, { moduleId, revision: pendingRevision.get(moduleId) ?? 0, contribution });
  emit();
}

export function unregisterFrontend(moduleId: string) {
  const e = entries.get(moduleId);
  if (!e) return;
  safeDispose(e);
  entries.delete(moduleId);
  emit();
}

function safeDispose(e: RegisteredFrontend) {
  try {
    e.contribution.dispose?.();
  } catch (err) {
    console.error(`dispose() of ${e.moduleId} failed`, err);
  }
}

/** Used by the shell's loader so registrations carry the revision they were loaded for. */
export function expectRevision(moduleId: string, revision: number) {
  pendingRevision = new Map(pendingRevision).set(moduleId, revision);
}

export function getFrontends() {
  return snapshot;
}

export function subscribeFrontends(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}
