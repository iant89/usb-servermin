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
| Agent: identity, capabilities, self-report ([ADR-003](adr/ADR-003-server-identity.md)) | `core/src/agent/*` |
| Module manager: lifecycle, dependencies, install/update/remove, health, hot reload | `core/src/modules/module-manager.ts` |
| Module instance: one worker, its resources and cleanup | `core/src/modules/module-instance.ts` |
| Worker host: builds `ModuleContext` inside the worker | `core/src/modules/worker-host.ts` |
| Installer: sources, validation, integrity | `core/src/modules/installer.ts` |
| RPC over `MessagePort` | `core/src/modules/rpc.ts` |
| Event bus | `core/src/events/event-bus.ts` |
| Auth: users, sessions, API tokens, lockout | `core/src/auth/*` |
| Process execution and privilege boundary | `core/src/process/process-service.ts` |
| Logging (live subscribers; batches persisted by the storage thread) | `core/src/logging/logger.ts` |
| Storage thread: module databases, log persistence, checkpoints | `core/src/storage/*` |
| Audit log | `core/src/audit/audit.ts` |
| HTTP server, CSRF, rate limit, static files (serves any `HttpHost`) | `core/src/http/server.ts` |
| Sign-in, setup, tokens, users, audit endpoints (shared with the Manager) | `core/src/http/account-routes.ts` |
| Core REST endpoints | `core/src/http/api.ts` |
| WebSocket gateway and channel hub | `core/src/websocket/*` |

## Storage thread

All slow disk work runs on a dedicated storage thread (`core/src/storage/storage-host.ts`):

- every module's SQLite database (modules reach it asynchronously through the core);
- persisting log entries to `core.db`, and writing log lines to journald (stdout) and the optional log file;
- WAL checkpoints of all databases, the step that forces data onto the disk with `fsync`.

The main thread keeps its own `core.db` connection for small, infrequent writes (sessions, users,
audit, notifications), in WAL mode with `synchronous=NORMAL` and automatic checkpoints disabled, so
none of its writes wait for the disk. On slow media such as a USB 2.0 flash drive, saving data and
starting modules can lag, but the HTTP API, the WebSocket gateway and module calls stay responsive.
A slow-storage integration test delays every storage-thread write to prove this.

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

## Manager

`packages/manager` is a second program in the same release ([manager.md](manager.md)). It hosts the
same `HttpServer`, `WebSocketGateway`, `AuthService`, `AuditLog`, `EventBus` and `Database` classes
as the core, through the `HttpHost` and `GatewayHost` interfaces, with its own routes
(`manager/src/routes.ts`), its own schema (`MANAGER_MIGRATIONS`: the shared account, audit and
key-value tables plus `servers`) and no module runtime, process service or update service.

## Agent/Manager protocol

`packages/protocol` holds the message envelope, the validation of everything received, version
negotiation and the bytes an agent signs; both ends import it
([ADR-002](adr/ADR-002-agent-outbound-connection.md)).

| Side | File | Role |
| --- | --- | --- |
| Agent | `core/src/agent/manager-link.ts` | Dials out, verifies the certificate, authenticates, heartbeats, reconnects with backoff |
| Agent | `core/src/agent/agent-key.ts` | The Ed25519 key pair |
| Manager | `manager/src/agent-hub.ts` | Accepts agents, verifies them, derives server state, enforces limits |

## Agent

Every server is a Servermin agent, whether or not a Manager exists
([ADR-001](adr/ADR-001-manager-agent-architecture.md)). `AgentService` loads the identity before
the HTTP server listens and answers `GET /api/v1/agent` (any signed-in user):

```json
{ "serverId": "…", "agentId": "…", "name": "Saturn", "hostname": "saturn", "machineId": "…",
  "hardware": { "vendor": "…", "product": "…", "board": "…", "fingerprint": "…" },
  "os": { "name": "Ubuntu 24.04.5 LTS", "id": "ubuntu", "version": "24.04", "kernel": "…", "arch": "x64" },
  "version": "1.0.0", "state": "RUNNING", "health": "HEALTHY", "startedAt": "…", "uptimeSeconds": 42,
  "capabilities": ["docker", "docker.engine", "storage"],
  "modules": [{ "id": "docker", "version": "1.1.0", "state": "ACTIVE", "health": "HEALTHY", "provides": ["docker.engine"], "tags": ["containers"] }],
  "keyFingerprint": "2df27bd2…",
  "manager": { "configured": true, "url": "wss://manager:8480/api/v1/agents/ws", "state": "CONNECTED", "connectedSince": "…",
               "lastError": null, "attempts": 0, "nextAttemptAt": null, "protocolVersion": 1 } }
```

- `state` is `STARTING` until modules have initialised, then `RUNNING`, and `STOPPING` during shutdown.
- `capabilities` is derived on every request: the id and the provided services of each module that
  is `ACTIVE` and whose health check is not `ERROR` or `OFFLINE`. Docker with the engine down is
  active but contributes nothing. Nothing in the core names a module.
- The public `health` endpoint does not include the identity.

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

Core endpoints (`/api/v1`): `health`, `agent`, `auth/*`, `users`, `permissions`, `config`, `system`, `events`,
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
