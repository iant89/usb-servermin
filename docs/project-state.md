# Project state

Working memory for the Servermin transformation. Read this first in a new session, then
[roadmap.md](roadmap.md). Updated at the end of every phase.

Last updated: 2026-11-10

## Current phase

Phase 3 — Agent/Manager protocol (not started).

## Completed phases

- Phase 0 — Architecture audit (2026-11-10)
- Phase 1 — Agent foundation (2026-11-10)
- Phase 2 — Manager foundation (2026-11-10)

## Active work

None.

## Blocked

Nothing.

## Open decisions

| Decision | Default | Record |
| --- | --- | --- |
| Manager TLS trust: pinned self-signed by default, own certificate supported | Yes, in Phase 3 | ADR-002, to be written |
| Rename the repository | Owner's call; nothing depends on it | |
| When to make `servermin-agent.service` the unit file and `server-control.service` the alias | Not before the release after the one that ships Phase 1 | [target-state §10](architecture/target-state.md#10-naming) |

## Architectural decisions

- [ADR-001](adr/ADR-001-manager-agent-architecture.md) (Accepted): the Agent is the existing core
  plus a manager link; the Manager is a new process reusing core libraries.
- [ADR-003](adr/ADR-003-server-identity.md) (Accepted): two random UUIDs (agent id, server id)
  stored with the data; hostname, machine id and hardware are attributes; ids are not secrets.
- Phase 1, unit naming: alias instead of rename, because the installed release's updater performs
  the rollback and 1.0.0's would leave a renamed unit not enabled at boot.
- Phase 1, capabilities: a flat, derived list of module ids and provided services from modules
  that are `ACTIVE` and not `ERROR`/`OFFLINE`; manifest `capabilities` tags are reported per module
  as `tags` and left for Phase 9 to formalise.

## What Phase 2 added

- Refactor (own commit, no behaviour change): `HttpHost` / `GatewayHost` interfaces,
  `registerAccountRoutes`, `SetupToken`, shared schema fragments, core channels in their own file.
- `packages/manager`: `Manager`, `Inventory`, configuration, routes, entry point
  ([manager.md](manager.md)).
- `servermin-manager.service` (sandboxed, account `servermin-manager`), launcher,
  `install.sh --manager`; the updater restarts a Manager after a rollback.
- Decisions: a separate account with no sudo rule; session cookie `smm_session`; default port 8480;
  logs to the journal only; one `servers` table (an `agents` table waits for registration, Phase 4).

## What Phase 1 added

- `packages/core/src/agent/`: `IdentityStore`, host identity facts, `AgentService`.
- `agent.stateDir` configuration; `GET /api/v1/agent`.
- `servermin-agent status | id` (`packages/cli/src/agent.ts`), launcher and symlink.
- `servermin-agent.service` alias; helper and Services module protect both names; the root updater
  stops both names and installs whichever unit file a release ships.
- `servermin-verify`: "Agent identity" check.

## Known issues

From the Phase 0 audit
([current-state.md §12](architecture/current-state.md#12-findings-that-constrain-the-roadmap)):

1. The installer adds `servermin` to the `docker` group, which the roadmap forbids (Phase 11).
2. Criticality (own unit, protected mounts) is hard-coded in the privilege helper.
3. Events are kept only in a 200-entry in-memory ring.
4. The audit log has no duration, correlation id or server.
5. `UpdateService` still depends on the concrete `Platform` (the HTTP and WebSocket stack no
   longer does).
6. No TLS by default and no certificate tooling.

From Phase 1:

7. The hardware fingerprint identifies the model, not the unit (serials are root-only).
8. `servermin-agent status` without API credentials cannot list capabilities and needs root. A
   local, credential-free channel to the running agent will be needed for
   `servermin-agent register` (Phase 4) and should replace this fallback.
9. A cloned data directory duplicates the identity; detection belongs to the protocol (Phase 3).
10. If a 1.0.0 server rolls back from this release and is later upgraded again after a reboot, the
    state is consistent (verified), but the leftover `servermin-agent.service` link points at the
    1.0.0 unit until the next successful install recreates it. Harmless.

From Phase 2:

11. The Manager has no web interface (Phase 8) and no CLI (Phase 34); it is driven with `curl`.
12. The updater snapshots and restores only the agent's `core.db`. A Manager schema migration that
    is followed by a rollback would leave `manager.db` ahead of the code. Needs solving before the
    second Manager migration ships (Phase 19 at the latest).
13. The Manager's health is not part of the updater's health check; a release whose Manager fails
    to start is not rolled back.
14. Without TLS the Manager serves passwords in clear text, like the agent. Phase 3 must make TLS
    the default for the Manager.
15. `servermin-verify` does not check a Manager installation.

## Technical debt

- No automated tests on a host with systemd running; `servermin-verify` is manual. Phases 1 and 2
  were checked by hand in a container: real `install.sh`, real `systemctl` unit-file operations,
  agent and Manager started as their own accounts. The Manager unit's sandbox was not exercised.
- `npm run dev` does not start a Manager.
- Two unit names until the swap described under *Open decisions*.
- "Capability" still means two things in the manifest (`provides` services and `capabilities` tags).
- The core's `host-info.ts`, the System module and now `agent/identity.ts` each read host facts.
- Product naming is split across "Server Control", `servermin`, `serverctl` and `usb-servermin`.
- `docs/roadmap.md` is a condensed copy of the owner's roadmap, not the full text.
- The version is still 1.0.0; bump it with `npm run set-version` when this is released.

## Test status

2026-11-10, end of Phase 2: `npm run typecheck` clean, `npm run build` clean, `npm test`
33 files / 309 tests passing (Node.js 22.23.4). Added in Phase 2: `packages/core/test/schema.test.ts`
(the refactored schema equals the 1.0.0 one), `packages/manager/test/manager.test.ts`,
`tests/integration/manager.test.ts` (independent start, setup token, inventory CRUD and audit,
persistence across restart, permissions, CSRF/token/lockout, cookie separation from an agent,
WebSocket, the built program's exit codes, and that it contains no process-spawning code).

## Next phase

Phase 3 — Agent/Manager protocol. Plan:

1. ADR-002: transport (WebSocket over TLS, opened by the agent), trust (pinned Manager
   certificate by default), message envelope, version negotiation.
2. `packages/protocol`: message types and validation shared by both sides.
3. Agent link in `packages/core/src/agent/`: connect, authenticate, heartbeat, timeout, jittered
   backoff, connection state; `agent.manager` configuration.
4. Manager endpoint for agents, separate from the browser WebSocket; server state from the
   connection (`ONLINE`, `STALE`, `OFFLINE`); duplicate agent id detection.
5. Tests with real processes: kill the Manager, drop the socket mid-message, stall heartbeats,
   malformed and oversized frames.

Authentication of agents needs credentials that only registration (Phase 4) issues. Phase 3 should
therefore define and test the authentication handshake against a key enrolled directly in the
Manager database by the test, and Phase 4 adds the registration flow that enrols it.
