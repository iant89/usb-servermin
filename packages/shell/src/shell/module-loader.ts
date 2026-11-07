/**
 * Loads and unloads module frontend bundles to match the server's module states (§14, §57).
 * A bundle is a script that calls `window.servermin.register(id, contribution)`. When a module
 * is reloaded its revision changes and the bundle is fetched again; when it stops, its
 * registration (navigation, routes, widgets) is removed.
 */
import { expectRevision, unregisterFrontend, type FrontendModuleInfo } from '@servermin/client';

interface Loaded {
  key: string;
  script: HTMLScriptElement;
  style?: HTMLLinkElement;
}

const loaded = new Map<string, Loaded>();
const failures = new Map<string, string>();
const failureListeners = new Set<() => void>();

export function loadFailures() {
  return failures;
}

export function onLoadFailure(l: () => void) {
  failureListeners.add(l);
  return () => void failureListeners.delete(l);
}

function remove(id: string) {
  const l = loaded.get(id);
  if (!l) return;
  l.script.remove();
  l.style?.remove();
  loaded.delete(id);
  unregisterFrontend(id);
}

export function syncModuleFrontends(modules: FrontendModuleInfo[]) {
  const wanted = new Map(modules.filter((m) => m.state === 'ACTIVE' && m.script).map((m) => [m.id, m]));
  for (const id of [...loaded.keys()]) if (!wanted.has(id)) remove(id);
  for (const m of wanted.values()) {
    const key = `${m.script}|${m.style}`;
    if (loaded.get(m.id)?.key === key) continue;
    remove(m.id);
    failures.delete(m.id);
    let style: HTMLLinkElement | undefined;
    if (m.style) {
      style = document.createElement('link');
      style.rel = 'stylesheet';
      style.href = m.style;
      style.dataset.module = m.id;
      document.head.appendChild(style);
    }
    expectRevision(m.id, m.revision);
    const script = document.createElement('script');
    script.src = m.script!;
    script.async = true;
    script.dataset.module = m.id;
    script.onerror = () => {
      failures.set(m.id, `The ${m.name} interface could not be loaded`);
      failureListeners.forEach((l) => l());
    };
    document.head.appendChild(script);
    loaded.set(m.id, { key, script, style });
  }
}
