# Current state (Phase 0 audit)

Audited on 2026-11-10 at commit `932af21` (version 1.0.0). Everything here was read from the code,
the deployment files and the tests; nothing is inferred from the roadmap. The older
[`docs/architecture.md`](../architecture.md) stays the reference for the module runtime itself; this
document adds what matters for the Manager/Agent transformation.

Baseline at the time of the audit: `npm run typecheck` clean, `npm run build` clean,
`npm test` 27 files / 226 tests passing.

## 1. What the product is today

One Node.js process per server (`server-control.service`), administered from a browser on that same
server. There is no notion of a second server anywhere in the code: no inventory, no peer, no
outbound connection except the update check against the GitHub API.

```
browser ──HTTP/WS──► core (user servermin) ──RPC──► module workers ──► /proc, ip, lsblk, systemctl, docker.sock
                        │
                        └── sudo -n servermin-privileged <op> key=value…  (root, fixed catalogue)
```

## 2. Repository

| Path | Contents |
| --- | --- |
| `packages/sdk` | Module contract: manifest + validation, `ModuleContext`, permissions, privileged-operation catalogue, semver, config schema, `createTestContext` |
| `packages/core` | The server process (see §3) |
| `packages/client` | Browser runtime shared by shell and module UIs: API client, WebSocket channels, router, frontend registry |
| `packages/shell` | React shell on ENTERPRISE-UI: login/setup, dashboard, Module Manager, Settings, Users, Updates |
| `packages/cli` | `serverctl` (REST client with an API token) and `servermin-verify` (on-host end-to-end checker) |
| `modules/*` | Nine built-in modules, each `module.json` + backend + frontend + tests |
| `deploy/` | systemd unit, installer, privilege helper, sudoers rule, root updater, launchers |
| `tools/` | esbuild/Vite build, dev runner, packaging, release signing |
| `vendor/` | `@enterprise-ui/react` as a tarball, rebuilt by `tools/update-enterprise-ui.sh` from a sibling checkout |

Toolchain: npm workspaces, TypeScript 6 (`noEmit`, bundler resolution), esbuild for server and
modules, Vite for the shell, Vitest (projects `unit`, `integration`, `shell`). Runtime dependencies
of the server: `ws` only. Node.js ≥ 22.13 for `node:sqlite`.

## 3. Backend (`packages/core`)

`main.ts` loads the configuration, constructs `Platform`, handles `SIGTERM`/`SIGINT` (20 s forced
exit), exits with code 70 on an uncaught exception so systemd restarts it.

`Platform.start()` order: data directories → `core.db` + migrations → storage thread → settings →
audit, auth, notifications, process service, module manager, update service → setup token →
**HTTP and WebSocket listen** → modules initialise → update timer → log pruning. The API is up before
modules load, so a broken module cannot lock an administrator out.

| Concern | Implementation | Notes for the migration |
| --- | --- | --- |
| Configuration | `config/config.ts`: defaults ← `/etc/servermin/config.json` ← environment; `validateConfig` | No section for a manager connection or an identity |
| Database | `database/database.ts`: `node:sqlite`, WAL, numbered migrations in `_migrations`. Core schema is one migration: `users`, `sessions`, `api_tokens`, `module_registry`, `module_config`, `audit_log`, `logs`, `notifications`, `kv` | Reusable as is |
| Storage thread | `storage/*`: module databases, log persistence and checkpoints off the main thread | Motivated by USB flash, but generally useful; keep |
| Auth | `auth/auth-service.ts`: scrypt passwords, hashed session cookies, hashed `smt_` API tokens, per-IP+user lockout, setup token for the first administrator | Users hold **permission strings**; "roles" are three presets (`ROLE_PRESETS`) applied in the UI, not stored |
| HTTP | `http/server.ts`, `router.ts`, `api.ts`: `/api/v1`, CSRF header + origin check, token bucket per IP, CSP, optional TLS from files | `HttpServer`, `WebSocketGateway` and `UpdateService` take the whole `Platform` object |
| WebSocket | `websocket/gateway.ts`, `channel-hub.ts`: one connection per tab, multiplexed subscriptions, session or bearer auth, session revocation closes sockets | Server side only; there is no WebSocket *client* in the core |
| Events | `events/event-bus.ts`: in-process, pattern subscriptions, owner-scoped cleanup | **History is an in-memory ring of 200 events**; nothing is persisted |
| Audit | `audit/audit.ts` → `audit_log(timestamp, user, action, module, target, result, metadata, ip)` | No duration, no correlation id, no server column |
| Logging | `logging/logger.ts`: live subscribers, batches persisted by the storage thread, retention pruning | |
| Notifications | `notifications/notifications.ts`: stored, permission-filtered, per-user read cursor | In-app only |
| Host summary | `system/host-info.ts`: CPU, memory, `/` and data disk, network counters, OS, uptime | Used by the core dashboard; overlaps with the System module |
| Health | `Platform.health()`: `HEALTHY`/`DEGRADED`/`ERROR` from the database and module states; `/api/v1/health` is public | Used by the root updater to validate an update |

## 4. Module architecture

- Each backend runs in a `worker_threads` Worker with a heap limit; `ModuleContext` is an RPC proxy
  (`modules/rpc.ts`, `worker-host.ts`). A crash, OOM or hung lifecycle call ends only that worker.
- `ModuleManager` (835 lines) runs every lifecycle operation through one queue: install, enable,
  disable, reload, update with automatic restore of the previous version, remove.
- Manifest (`module.json`) declares permissions, channels, event namespaces, `host.commands`,
  `host.privileged`, settings, `dependencies`, `requires`/`provides` and `capabilities`.
- **Two things are called "capability" today.** `provides`/`requires` are *services* with a
  dotted name (`docker.engine`, `services.systemd`, `system.info`) that the core routes between
  workers. `capabilities` is a list of descriptive tags (`containers`, `zfs`-style) that nothing
  consumes. The roadmap's capability system (Phase 9) maps onto these.
- Worker isolation is fault isolation, not a sandbox: module code runs with the service account's
  rights. Documented as such in `docs/security.md`.

| Module | Provides | Host commands | Privileged operations |
| --- | --- | --- | --- |
| system 1.0.0 | `system.info` | `apt`, `timedatectl`, `lspci` | power, packages, hostname, time zone, NTP |
| docker 1.1.0 | `docker.engine` | `docker` (Compose); Engine API over the socket | none |
| storage 1.0.0 | | `lsblk`, `findmnt` | mount, unmount, S.M.A.R.T. |
| network 1.0.0 | | `ip`, `resolvectl` | `network.apply`, `.confirm`, `.rollback` |
| services 1.0.0 | `services.systemd` | `systemctl`, `journalctl` | start, stop, restart, enable, disable |
| applications 1.1.0 | | (uses `docker.engine?`, `services.systemd?`) | none |
| logs 1.0.0 | | `journalctl` | none |
| terminal 1.0.0 | | `python3` (PTY bridge) | none |
| monitoring 1.0.0 | | | none |

Already implemented inside modules and reusable for later phases:

- **Hardware discovery** (System): OS, kernel, CPU, memory, GPUs (DRM, `lspci`), DMI, `/etc/machine-id`,
  virtualisation. Missing against Phase 6: temperatures, and a consolidated profile (storage and
  network inventory live in their own modules).
- **Metrics** (System + Monitoring): live channel, periodic `*.metrics` events, SQLite history with
  retention and bucketing, threshold alerts with hysteresis. Missing against Phase 7: disk I/O,
  temperature, GPU utilisation.
- **Docker, Services, Storage, Network, Applications + catalogue, Logs, Terminal**: local
  equivalents of Phases 11, 12, 16, 17, 18, 25 and 31 exist and are tested.

## 5. Privilege architecture

- The service runs as `servermin` with `CAP_NET_BIND_SERVICE` only. `NoNewPrivileges` is
  deliberately off because the service must be able to run `sudo`.
- One sudoers rule: `servermin ALL=(root) NOPASSWD: /usr/lib/servermin/servermin-privileged`.
- The catalogue (`sdk/src/privileged.ts`, 20 operations) is validated twice: in the core
  (`ProcessService.privileged`, with declaration check, confirmation flag and audit) and again in the
  bash helper, which is the real boundary.
- Self-protection in the helper is **hard-coded**: it refuses to stop/restart/disable
  `server-control.service` by name, refuses to unmount a fixed `PROTECTED_MOUNTS` list, restricts
  mounts to `/mnt`, `/media`, `/srv`, and applies only the Network module's staged netplan file.
- `privileged.mode`: `sudo`, `simulate` (development and tests) or `disabled`.
- The Terminal module is the one intentional arbitrary-command path: a shell as `servermin`,
  permission-gated and audited.

## 6. Network rollback

`network.apply` backs up `/etc/netplan/90-servermin.yaml`, installs the staged file, runs
`netplan generate`, **schedules `servermin-network-rollback` with `systemd-run --on-active` before
`netplan apply`**, and waits for `network.confirm`. The timer lives outside the service, so a lost
connection or a dead core still rolls back. The roadmap makes preserving this mandatory; it needs no
change.

## 7. Update system

- `UpdateService` polls `GET {apiBase}/repos/{repository}/releases/latest` (default repository
  `iant89/usb-servermin`), verifies `release.json` with the Ed25519 key installed at
  `/opt/servermin/release-signing.pub`, checks archive SHA-256 and size, downloads to
  `/var/tmp/servermin/updates`, and calls `platform.update`.
- The helper copies the files into a root-only directory and starts `servermin-update` in its own
  transient unit. The root updater (`deploy/servermin-update.mjs`) repeats signature, version
  (no downgrade) and checksum checks, refuses links and special files, snapshots the database, swaps
  `/opt/servermin`, restarts, waits for `/api/v1/health` to report the new version, and otherwise
  restores `/opt/servermin.previous` and the database.
- Optional automatic install in a one-hour local maintenance window. Module packages update
  independently, with restore-on-failure.
- The update source is settable only in the configuration file, never through the API.

## 8. Frontend

- Shell: `AppShell` from ENTERPRISE-UI, navigation built from module contributions plus two fixed
  core entries (Modules, Settings). Pages: Dashboard, Module Manager, Module Detail, Settings
  (including Users, Updates, Audit, account).
- Module frontends are IIFE bundles that import React, ENTERPRISE-UI and `@servermin/client` from
  `window.__SERVERMIN_SHARED__` and call `registerFrontend`. They are loaded and unloaded as
  `module.status` reports state changes.
- Every API path a module UI uses is relative to **this** server (`/api/v1/modules/<id>/…`). Nothing
  in `@servermin/client` carries a server identifier.
- ENTERPRISE-UI is consumed as a vendored tarball (0.1.0). No change to that repository is needed
  for the phases before the Manager dashboard (Phase 8).

## 9. Deployment

`install.sh` creates the `servermin` account, installs to `/opt/servermin` (previous version kept as
`.previous`), installs helper + sudoers + unit, checks that the port is free, and enables the
service. Optional bundled Node.js for hosts without one. `servermin-verify` checks a real host end
to end, with opt-in destructive checks (`--docker`, `--mount`, `--service`, `--updates`,
`--network-rollback`).

## 10. Testing

| Layer | What it proves | Real Linux behaviour? |
| --- | --- | --- |
| Unit (`packages/*/test`, `modules/*/test`) | Manifest/semver/permissions, auth, rate limits, process service, installer integrity, updater logic, parsers against captured command output | The privilege helper tests run the real bash script, but only its refusal paths |
| Integration (`tests/integration`) | A real core with workers and SQLite: lifecycle, failure isolation, packages, slow storage, updates, verify | Privileged operations are simulated |
| Shell (`packages/shell/test`) | jsdom rendering | n/a |
| `servermin-verify` | The installed product on a real host | Yes, but manual; CI has no VM or systemd job |

CI (`ci.yml`): typecheck, build, test, package for x64 and arm64 on `ubuntu-24.04`.

## 11. USB-specific assumptions

The code is less USB-bound than the name suggests. What actually exists:

| Assumption | Where | Effect on Servermin |
| --- | --- | --- |
| Slow flash storage | Storage thread, "Saving…" indicator, `TimeoutStopSec=90`, generous lifecycle timeouts, `logging.file` off | Harmless on fast disks; keep |
| No hardware pinned | No interface, disk or MAC in configuration; discovery on every start | Good for agents generally |
| Bundled Node.js | `--bundle-node`, launchers prefer `/opt/servermin/node` | Keep; it makes agent installs dependency-free |
| "System disk is the boot stick" | Storage module comment and the *Removable* badge | Logic is already generic ("the disk that holds `/`") |
| **The installation moves between machines** | Whole design; hardware checklist | **Conflicts with a stable server identity**: `/etc/machine-id` and any agent identity stored in the data directory travel with the stick to different hardware |
| Naming | Repository `usb-servermin`, default `updates.repository`, product name "Server Control", unit `server-control.service`, CLI `serverctl` | Renames touch the update source, the helper's self-protection and every installed server |
| Local-only administration | Browser session against the server itself; setup token on the local disk | The Manager needs a different trust bootstrap (registration) |

## 12. Findings that constrain the roadmap

1. **Docker group.** `install.sh` adds `servermin` to the `docker` group when it exists, and
   `servermin-verify` warns when it is missing. Roadmap §18/§55 forbids exactly this. The Docker
   module talks to the socket directly, so changing it needs a design (Phase 11), not a one-line fix.
2. **Criticality is hard-coded** in the helper (unit name, mount list) and in the Storage module.
   Phases 16–17 and §56 need it to be derived (management disk, filesystem, interface, manager
   connection).
3. **Events are not durable.** Phase 20 needs a persisted event store; the in-memory ring is not one.
4. **Audit lacks duration, correlation id and server.** Phase 24 extends the table; it does not
   replace it.
5. **Roles are presets, not entities.** Phase 35 adds them; permission strings and wildcards stay.
6. **`HttpServer`, `WebSocketGateway` and `UpdateService` depend on the concrete `Platform`.**
   Reusing the HTTP/WebSocket stack for a Manager process needs these narrowed to interfaces first.
7. **No TLS by default** and no certificate tooling. Agent-to-Manager traffic must be TLS
   (Phase 3), so the Manager needs a certificate story before registration (Phase 4).
8. **Identity on a moving installation** (§11). Needs an explicit decision in Phase 1.
9. **No automated real-system tests.** Roadmap §51–52 asks for systemd/Docker/mount/network tests
   on real hosts; today that is the manual `servermin-verify` run.
10. **Single-server client.** `@servermin/client` and every module UI assume one origin = one
    server. Showing a remote server's module UI from the Manager (Phase 8) needs a routing decision.
