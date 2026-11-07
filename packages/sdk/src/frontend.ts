/**
 * Frontend contribution types (§14). A module's frontend bundle calls
 * `window.servermin.register(moduleId, contribution)` (via `registerFrontend` in
 * `@servermin/client`). The shell builds navigation, routes, widgets and commands from these
 * registrations; nothing about a module is hard-coded in the shell.
 */
import type { ComponentType, ReactNode } from 'react';

export interface ModuleRouteProps {
  /** Path parameters, e.g. `{ id: 'abc' }` for `/containers/:id`. */
  params: Record<string, string>;
  /** The path below the module root. */
  path: string;
  query: URLSearchParams;
}

export interface FrontendRoute {
  /** Path below `/m/<moduleId>`, e.g. `/` or `/containers/:id`. */
  path: string;
  component: ComponentType<ModuleRouteProps>;
  /** Permission needed to view; shows a permission-denied state otherwise. */
  permission?: string;
  title?: string;
}

export interface FrontendNavigationItem {
  id: string;
  label: string;
  /** ENTERPRISE-UI icon name. */
  icon?: string;
  /** Path below the module root. @default '/' */
  path?: string;
  /** Sort order in the side navigation (lower first). @default 100 */
  order?: number;
  permission?: string;
  children?: Omit<FrontendNavigationItem, 'children' | 'icon' | 'order'>[];
}

export interface DashboardWidget {
  id: string;
  title: string;
  component: ComponentType;
  /** Grid columns to span. @default 1 */
  span?: 1 | 2 | 3 | 4;
  order?: number;
  permission?: string;
}

export interface FrontendCommand {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  keywords?: string[];
  permission?: string;
  /** Navigate to a module path, or run an action. */
  path?: string;
  run?: () => void;
}

export interface StatusIndicatorContribution {
  id: string;
  component: ComponentType;
  permission?: string;
}

export interface SettingsPageContribution {
  id: string;
  title: string;
  component: ComponentType;
  permission?: string;
}

export interface FrontendContribution {
  routes?: FrontendRoute[];
  navigation?: FrontendNavigationItem[];
  widgets?: DashboardWidget[];
  commands?: FrontendCommand[];
  statusIndicators?: StatusIndicatorContribution[];
  settings?: SettingsPageContribution[];
  /** Called when the module is unloaded from the page (hot reload or removal). */
  dispose?: () => void;
}

export type { ReactNode };
