# Target state

Where Servermin is going, expressed in terms of the code that exists
([current state](current-state.md)). Decisions marked **Proposed** are not final until their ADR is
accepted in the phase that implements them.

## 1. Shape

```
                    SERVERMIN MANAGER (one, any Linux host)
        users · inventory · groups · events · alerts · updates · audit · API · dashboard
                                   ▲   ▲   ▲
                 outbound TLS WebSocket, opened by each agent
                                   │   │   │
        ┌──────────────────────────┘   │   └──────────────────────────┐
   SERVERMIN AGENT                SERVERMIN AGENT                SERVERMIN AGENT
   core + modules                 core + modules                 core + modules
   privilege helper               privilege helper               privilege helper
```

## 2. The Agent is today's core (ADR-001)

The existing `server-control` process already is what the roadmap calls an agent: a systemd service
with module execution, hardware discovery, metrics, Docker, storage, network, services, logs,
signed updates with rollback, and a privilege helper. The Agent is therefore **the current core
plus a manager link**, not a new program.

- New core subsystem `packages/core/src/agent/`: identity, manager link (WebSocket client with
  reconnect, heartbeat, backoff), registration, command dispatch.
- Modules, the SDK contract, the worker runtime, the helper and the updater are unchanged.
- The local web interface stays. An agent that is not registered with any Manager is exactly the
  product that ships today, which is also how "USB remains supported" is honoured.

Rejected alternative: a separate lightweight agent binary next to the core. It would duplicate
process supervision, configuration, updates and the privilege boundary, and every module would need
a second way to be reached.

## 3. The Manager is a new process that reuses core building blocks (ADR-001)

New workspace `packages/manager` with its own entry point, unit (`servermin-manager.service`),
account (`servermin-manager`), configuration (`/etc/servermin-manager/config.json`) and database
(`/var/lib/servermin-manager/manager.db`). Implemented in Phase 2; see [manager.md](../manager.md). It reuses from
`@servermin/core`: `Database` and migrations, `AuthService`, `AuditLog`, `EventBus`, `LogService`,
`NotificationService`, the HTTP server, router and WebSocket gateway.

- `HttpServer` and `WebSocketGateway` take narrow host interfaces (`HttpHost`, `GatewayHost`)
  instead of the concrete `Platform`.
- The Manager holds **no** sudo rule, no privilege helper and runs no modules on its own behalf.
- A server can run both Manager and Agent; the Manager then manages its own host through the local
  agent like any other server.

Rejected alternative: the Manager as a module inside the core. Inventory, authentication and agent
connections are platform concerns; a module can be unloaded, runs behind worker RPC, and the roadmap
requires the Manager to start independently.

## 4. Shared protocol package

New workspace `packages/protocol`: message types, validation and version negotiation for
`AUTHENTICATION`, `HEARTBEAT`, `SERVER_STATE`, `CAPABILITIES`, `METRIC`, `EVENT`, `COMMAND`,
`COMMAND_RESULT`, `LOG`, `MODULE_STATE`. Every message carries an id; replies carry the correlation
id. Both sides import the same code, so a schema change cannot drift. No new runtime dependency:
validation is hand-written, as the manifest validation already is.

## 5. Identity ([ADR-003](../adr/ADR-003-server-identity.md), implemented in Phase 1)

| Field | Source | Lifetime |
| --- | --- | --- |
| Agent ID | Random UUID created on first start, stored in the data directory (root-readable, 0600) | The installation |
| Server ID | Random UUID created on first start; a Manager may replace it at registration to attach a reinstalled agent to a known server | The inventory entry |
| Machine ID | `/etc/machine-id` | The OS installation; reported, never trusted as a key |
| Hardware fingerprint | DMI product UUID / board serial where readable | The physical machine |
| Hostname | `os.hostname()` | Changeable; display only |

A portable installation booted on different hardware keeps both ids while the hardware
description changes. The Manager records that as an event on the same server rather than a new
server. The ids are identifiers, not secrets.

## 6. Security boundary

```
Manager user ─► Manager authz (role, group) ─► COMMAND over the agent's own TLS connection
   ─► Agent: is this command type allowed here? (local policy, can only narrow)
   ─► existing module route / service, with the module's declared permission
   ─► ProcessService ─► servermin-privileged (fixed catalogue, re-validated) ─► Linux
```

- The Manager never opens a connection to a server and never holds credentials that work on one.
  Compromising the Manager yields the catalogue of operations the agents accept, not root shells.
- Commands are typed and enumerated. There is no "run this string" command. The remote terminal
  (Phase 25) is a separate, explicitly enabled capability with its own permission and audit.
- An agent can be told locally to refuse classes of commands (read-only agents).
- Agent credentials are per agent (Ed25519 key pair generated on the agent with `node:crypto`; the
  Manager stores only the public key) and revocable from the inventory. Details in ADR-002/003.

## 7. Capabilities

Agents report the union of what their active modules declare: provided services
(`docker.engine`), capability tags (`containers`, `zfs`) and module ids with versions. The Manager
keys every feature on those strings, never on a server name. A new module that declares a new
capability reaches the Manager without a Manager change; a UI that understands it is an optional
contribution.

## 8. Data ownership

| Data | Lives on | Why |
| --- | --- | --- |
| Users, roles, groups, inventory, registration codes, policies, automation rules | Manager | Central by nature |
| Server state, hardware profile, last metrics | Manager (cache of what agents report) | Visible while the server is offline |
| Metric history | Agent (Monitoring module) first; Manager keeps a coarse copy | Keeps the Manager small; survives a Manager outage |
| Events and alerts | Manager, persisted; agents buffer while disconnected | Phase 20 |
| Audit | Both: Manager records who asked, Agent records what ran; joined by correlation id | Phase 24 |
| Module data, application definitions | Agent | Unchanged |

## 9. Frontend

The Manager dashboard is the existing shell technology (React, ENTERPRISE-UI, `@servermin/client`)
with new pages for inventory, events, alerts and updates. Whether per-server module UIs are shown by
proxying the agent's module API through the Manager or by rebuilding them against Manager endpoints
is decided in Phase 8; the protocol in Phase 3 must not preclude the proxy approach.

## 10. Naming

| Today | Target | When |
| --- | --- | --- |
| Product "Server Control" | Servermin (Manager, Agent) | With the first Manager release |
| `server-control.service` | Phase 1: `servermin-agent.service` is an **alias**; the unit file keeps its name. Later: swap them | The swap waits until every release that can still update directly has an updater that handles both names (the Phase 1 updater is the first) |
| `serverctl` | `servermin` (Manager API) and `servermin-agent` (local: `status`, `id` since Phase 1; `register` in Phase 4); `serverctl` kept as an alias | Phases 4 and 34 |
| Repository `usb-servermin` | Owner's decision | Any time; GitHub redirects, and `updates.repository` is configuration |

Why the unit file was not simply renamed: the updater that runs during an update is the one of
the *installed* release. If the new release fails its health check, the 1.0.0 updater puts
`server-control.service` back as a file and starts it, but does not enable it; had the new
release moved the enablement to another unit name, the server would run until the next reboot and
then stay down. Keeping the file name and adding an alias has no such state.

## 11. What stays exactly as it is

Module runtime and lifecycle, worker isolation, the SDK contract (`apiVersion` 1), the privilege
helper and its catalogue, netplan rollback, signed updates with rollback, the storage thread,
SQLite via `node:sqlite`, the frontend module registry, ENTERPRISE-UI, the test layout, and the
rule of minimal dependencies.
