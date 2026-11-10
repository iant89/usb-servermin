# Project state

Working memory for the Servermin transformation. Read this first in a new session, then
[roadmap.md](roadmap.md). Updated at the end of every phase.

Last updated: 2026-11-10

## Current phase

Phase 2 — Manager foundation (not started).

## Completed phases

- Phase 0 — Architecture audit (2026-11-10)
- Phase 1 — Agent foundation (2026-11-10)

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
5. `HttpServer`, `WebSocketGateway` and `UpdateService` depend on the concrete `Platform`
   (first task of Phase 2).
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

## Technical debt

- No automated tests on a host with systemd running; `servermin-verify` is manual. Phase 1 was
  checked by hand in a container: real `install.sh`, real `systemctl` unit-file operations, the
  agent started as the `servermin` account.
- Two unit names until the swap described under *Open decisions*.
- "Capability" still means two things in the manifest (`provides` services and `capabilities` tags).
- The core's `host-info.ts`, the System module and now `agent/identity.ts` each read host facts.
- Product naming is split across "Server Control", `servermin`, `serverctl` and `usb-servermin`.
- `docs/roadmap.md` is a condensed copy of the owner's roadmap, not the full text.
- The version is still 1.0.0; bump it with `npm run set-version` when this is released.

## Test status

2026-11-10, end of Phase 1: `npm run typecheck` clean, `npm run build` clean, `npm test`
30 files / 267 tests passing (Node.js 22.23.4). New: `packages/core/test/agent.test.ts`,
`tests/integration/agent.test.ts`, `packages/cli/test/packaging.test.ts`, updater rollback across
unit names, helper and Services self-protection for both names.

## Next phase

Phase 2 — Manager foundation. Plan in
[migration-plan.md](architecture/migration-plan.md#sequence-for-the-mvp-phases-18-13-15-20):

1. Narrow `HttpServer` and `WebSocketGateway` to a host interface, with no behaviour change and
   the existing tests as the gate (own commit).
2. `packages/manager`: entry point, configuration, `manager.db` with `servers` and `agents`,
   authentication reusing `AuthService` and the setup token, inventory API, unit file.
3. Test: the Manager starts with no agent code loaded and its inventory survives a restart.
