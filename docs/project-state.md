# Project state

Working memory for the Servermin transformation. Read this first in a new session, then
[roadmap.md](roadmap.md). Updated at the end of every phase.

Last updated: 2026-11-10

## Current phase

Phase 1 — Agent foundation (not started; waiting on the decisions listed under *Open decisions*).

## Completed phases

- Phase 0 — Architecture audit (2026-11-10)

## Active work

None.

## Blocked

Nothing is blocked. Phase 1 proceeds on the defaults in *Open decisions* unless the owner changes
them.

## Open decisions

| Decision | Default | Record |
| --- | --- | --- |
| Agent = existing core + manager link; Manager = new process reusing core libraries | Yes | [ADR-001](adr/ADR-001-manager-agent-architecture.md), Proposed |
| A portable installation booted on other hardware is the same server (hardware-changed event) | Yes | ADR-003, to be written in Phase 1 |
| Rename `server-control.service` → `servermin-agent.service` with an alias | Yes, in Phase 1 | |
| Rename the repository | Owner's call; nothing depends on it | |
| Manager TLS trust: pinned self-signed by default, own certificate supported | Yes, in Phase 3 | ADR-002, to be written |

## Architectural decisions

- ADR-001 (Proposed): Manager/Agent architecture built on the existing core.

## Known issues

Found by the audit; none is a regression. Details in
[current-state.md §12](architecture/current-state.md#12-findings-that-constrain-the-roadmap).

1. The installer adds `servermin` to the `docker` group, which the roadmap forbids (fix in Phase 11).
2. Criticality (own unit, protected mounts) is hard-coded in the privilege helper.
3. Events are kept only in a 200-entry in-memory ring.
4. The audit log has no duration, correlation id or server.
5. `HttpServer`, `WebSocketGateway` and `UpdateService` depend on the concrete `Platform`.
6. No TLS by default and no certificate tooling.
7. `/etc/machine-id` moves with a portable installation; it cannot be the server's key.

## Technical debt

- No automated tests on a real host with systemd; `servermin-verify` is manual.
- "Capability" means two things in the manifest (`provides` services and `capabilities` tags).
- The core's `host-info.ts` and the System module both collect host facts.
- Product naming is split across "Server Control", `servermin`, `serverctl` and `usb-servermin`.
- `docs/roadmap.md` is a condensed copy of the owner's roadmap, not the full text.

## Test status

2026-11-10, commit `932af21` plus documentation only: `npm run typecheck` clean, `npm run build`
clean, `npm test` 27 files / 226 tests passing (Node.js 22.23.4).

## Next phase

Phase 1 — Agent foundation. Plan in
[migration-plan.md](architecture/migration-plan.md#sequence-for-the-mvp-phases-18-13-15-20):
identity store, `agent` configuration section, aggregated capabilities, local agent report
(API and `servermin-agent status`), unit rename with alias, ADR-003.
