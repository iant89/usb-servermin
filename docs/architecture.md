# Architecture

This document maps the design specification to the implementation.

## Layers

| Layer (§7) | Implementation |
| --- | --- |
| Presentation | `packages/shell` (React + ENTERPRISE-UI), module frontends in `modules/*/src/frontend` |
| API | `packages/core/src/http` (REST, `/api/v1`), `packages/core/src/websocket` (gateway) |
| Core platform | `packages/core/src` — runtime, registry, auth, events, config, database, logging, audit, notifications, process |
| Module | `modules/*` — each one a backend bundle, a frontend bundle and a manifest |
| Host integration | Inside modules: `/proc`, `/sys`, `ip`, `lsblk`, `systemctl`, `journalctl`, the Docker Engine socket, a PTY bridge; root actions via the privilege helper |

## Core components

| Component | File |
| --- | --- |
| Platform (wiring, health, settings, setup token) | `core/src/platform.ts` |
| Module manager: lifecycle, dependencies, install/update/remove, health, hot reload | `core/src/modules/module-manager.ts` |
| Module instance: one worker, its resources and cleanup | `core/src/modules/module-instance.ts` |
| Worker host: builds `ModuleContext` inside the worker | `core/src/modules/worker-host.ts` |
| Installer: sources, validation, integrity | `core/src/modules/installer.ts` |
| RPC over `MessagePort` | `core/src/modules/rpc.ts` |
| Event bus | `core/src/events/event-bus.ts` |
| Auth: users, sessions, API tokens, lockout | `core/src/auth/*` |
| Process execution and privilege boundary | `core/src/process/process-service.ts` |
| Logging (stdout/journald, file, SQLite, live) | `core/src/logging/logger.ts` |
| Audit log | `core/src/audit/audit.ts` |
| HTTP server, CSRF, rate limit, static files | `core/src/http/server.ts` |
| Core REST endpoints | `core/src/http/api.ts` |
| WebSocket gateway and channel hub | `core/src/websocket/*` |

## Module isolation

Every module backend runs in a `worker_threads` Worker:

```
core thread                                   module worker
───────────                                   ─────────────
ModuleManager ── ModuleInstance ──RPC──►  worker-host ── ModuleContext ── module code
                   │ routes, channels,           (proxy: every call is a message to the core)
                   │ event subscriptions,
                   │ services, processes
```

- **Crashes** (uncaught exception, out-of-memory, exit) fire the Worker's `error`/`exit` event.
  The instance releases every resource it registered and the manager moves the module to `ERROR`,
  stops dependents (`BLOCKED`) and raises a notification. The HTTP server and other workers are unaffected.
- **Resource limits**: `resourceLimits.maxOldGenerationSizeMb` per module (manifest
  `backend.maxMemoryMb`, capped by `modules.maxMemoryMb`); at most 16 child processes per module;
  timeouts on lifecycle calls, route handlers (`timeoutMs`), service calls and health checks.
- **Hot reload** creates a fresh Worker, so the module's code and all its state are reloaded with
  no stale references, timers or listeners. The old Worker is terminated after `stop`/`destroy`.
- The worker boundary is for **fault isolation, not a security sandbox**: module code runs with the
  service account's privileges. Install modules you trust, and review their declared host access
  in the Module Manager.

## Lifecycle

```
install:  DISCOVERED → VALIDATING → VALID → INSTALLING → INSTALLED → LOADING → LOADED → ACTIVE
runtime:  ACTIVE ⇄ DISABLED · STOPPING → STOPPED · RELOADING · UPDATING · ERROR · BLOCKED
remove:   disable → stop → unregister routes/channels/handlers/services → kill processes → [delete data] → remove
```

All lifecycle operations run through one queue in the manager, so they never interleave.

## Dependencies and capabilities

- `dependencies: { "docker": "^1.0.0" }` — a specific module and version range.
- `requires: [{ "capability": "docker.engine", "optional": true }]` — any module that `provides`
  the service. Optional requirements let a module start and degrade gracefully.
- A module with unmet requirements is `BLOCKED` and starts automatically when they become active.
  When a provider stops, its dependents go to `BLOCKED`; when it comes back, they restart.
- Cycles are rejected at install time.

Service calls (`ctx.services.call('docker.engine', 'listContainers')`) are routed by the core to
the provider's worker. A caller can only call services it declared in `requires`.

## Events

`EventBus` delivers `PlatformEvent { type, source, timestamp, payload }` with patterns (`docker.container.*`,
`*.metrics`, `module.**`). A module may only publish in its own namespace (its id, plus namespaces
declared in `events.publishes`). Subscriptions are owned by the module and removed when it unloads.

Core events: `module.installed`, `module.removed`, `module.loaded`, `module.unloaded`,
`module.state.changed`, `module.error`, `module.health.changed`, `module.config.changed`,
`config.changed`, `auth.login`, `notification.created`.

## Data

```
/var/lib/servermin/core.db                    users, sessions, tokens, module registry, module settings,
                                              audit log, logs, notifications, key-value state
/var/lib/servermin/module-data/<id>/module.db each module's own database (migrations tracked per module)
/var/lib/servermin/module-data/<id>/          the module's files (ctx.module.dataDir)
/var/lib/servermin/modules/<id>/              installed module code
```

## REST API

Core endpoints (`/api/v1`): `health`, `auth/*`, `users`, `permissions`, `config`, `system`, `events`,
`logs`, `audit`, `notifications`, `platform/modules[/:id[/enable|disable|reload|restart|update|config|logs|upload]]`,
`platform/modules/discover`, `platform/frontend`, `platform/health`, and `modules` (list).

Module endpoints: `/api/v1/modules/<id>/<path>`, registered by the module at runtime and removed when it unloads.

## WebSocket protocol

One connection per tab at `/api/v1/ws` (session cookie, same origin), multiplexing subscriptions:

```
→ { type: 'subscribe', id, channel, params }      ← { type: 'subscribed', id }
→ { type: 'message', id, data }                    ← { type: 'data', id, data }
→ { type: 'unsubscribe', id }                      ← { type: 'closed', id, reason }  e.g. module-unloaded
                                                   ← { type: 'error', id, message, reason }
```

Core channels: `module.status`, `notifications`, `events`, `platform.logs`. Module channels:
`<id>.<name>` as declared in the manifest, each with a permission.

## Frontend

The shell exposes React, ReactDOM, ENTERPRISE-UI and `@servermin/client` on
`window.__SERVERMIN_SHARED__`. Module frontends are IIFE bundles built by `tools/build-module.mjs`,
which maps those imports to the shared instances, so module UI shares the theme, router and
contexts. Bundles call `registerFrontend(id, contribution)`. The shell loads and unloads bundles
whenever the `module.status` channel reports a state change, and reloads a bundle when its revision
changes (hot reload).

Every module page is wrapped in an error boundary, and the shell renders explicit states for a
module that is missing, disabled, failed, waiting for a dependency, loading, or not permitted (§45).

## Health

- Core: `HEALTHY`, or `DEGRADED` when an enabled module is in `ERROR`/`BLOCKED` or reports
  `DEGRADED`/`ERROR`; `ERROR` when the database is unavailable.
- Modules register health checks; the core polls them every `modules.healthIntervalMs` with a
  timeout. Module health is independent of core health (a module can be `ACTIVE` with health `ERROR`,
  for example Docker when the engine is down).

## Decisions

- **Native host application** (§54), started by systemd, not containerised.
- **SQLite via `node:sqlite`** (§55): no native addon to compile for each machine, which matters for
  a portable installation. Requires Node.js 22.13+.
- **Worker threads** for module isolation rather than child processes: cheap to start, structured
  cloning for RPC, and per-worker heap limits; a crash still cannot reach the core thread.
- **Python PTY bridge** for the terminal instead of `node-pty`, again to avoid a native addon.
- **JSON manifests** (`module.json`) rather than YAML, so validation needs no parser dependency.
- **Minimal dependencies**: the core depends only on `ws`; the shell on React and ENTERPRISE-UI;
  the terminal module bundles xterm.js. No Redis, Kafka, Kubernetes or other infrastructure (§53).
