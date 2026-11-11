# Project state

Working memory for the Servermin transformation. Read this first in a new session, then
[roadmap.md](roadmap.md). Updated at the end of every phase.

Last updated: 2026-11-11

## Current phase

Phase 5 — Server inventory (not started).

## Completed phases

- Phase 0 — Architecture audit (2026-11-10)
- Phase 1 — Agent foundation (2026-11-10)
- Phase 2 — Manager foundation (2026-11-10)
- Phase 3 — Agent/Manager protocol (2026-11-11)
- Phase 4 — Server registration (2026-11-11)

## Active work

None.

## Blocked

Nothing.

## Open decisions

| Decision | Default | Record |
| --- | --- | --- |
| Rename the repository | Owner's call; nothing depends on it | |
| When to make `servermin-agent.service` the unit file and `server-control.service` the alias | Not before the release after the one that ships Phase 1 | [target-state §10](architecture/target-state.md#10-naming) |

## Architectural decisions

- [ADR-001](adr/ADR-001-manager-agent-architecture.md) (Accepted): the Agent is the existing core
  plus a manager link; the Manager is a new process reusing core libraries.
- [ADR-002](adr/ADR-002-agent-outbound-connection.md) (Accepted): agents dial out over a WebSocket;
  TLS with a pinned fingerprint by default; Ed25519 challenge-response bound to the certificate;
  server state derived from the connection.
- [ADR-004](adr/ADR-004-server-registration.md) (Accepted): one-time hashed codes, optionally bound
  to a server or self-approving; `servermin-agent register` posts ids and public key over a pinned
  connection and writes `<stateDir>/manager.json`, which the agent polls; an unbound code always
  creates a new server.
- [ADR-003](adr/ADR-003-server-identity.md) (Accepted): two random UUIDs (agent id, server id)
  stored with the data; hostname, machine id and hardware are attributes; ids are not secrets.
- Phase 1, unit naming: alias instead of rename, because the installed release's updater performs
  the rollback and 1.0.0's would leave a renamed unit not enabled at boot.
- Phase 1, capabilities: a flat, derived list of module ids and provided services from modules
  that are `ACTIVE` and not `ERROR`/`OFFLINE`; manifest `capabilities` tags are reported per module
  as `tags` and left for Phase 9 to formalise.

## What Phase 4 added

- Manager: `registrations.ts` (migration 3: `registration_codes`, `registrations`),
  `POST|GET /registration-codes`, `DELETE /registration-codes/:id`, public `POST /registrations`,
  `GET /registrations[?status=]`, `GET /registrations/:id`, `POST /registrations/:id/approve|reject`.
- Core: `validateManagerSettings`, `readRegisteredManager`; the platform builds its link from
  `agent.manager` or `<stateDir>/manager.json` and replaces it when the file changes; `source` in
  the link status.
- CLI: `servermin-agent register`, `servermin-agent leave` (`packages/cli/src/register.ts`);
  status from disk shows a registered Manager.
- Known issue 16 is resolved.

## What Phase 3 added

- `packages/protocol`: envelope, validation, version negotiation, signing input.
- Agent: `agent/agent-key.ts`, `agent/manager-link.ts`, `agent.manager` configuration,
  `keyFingerprint` and `manager` in the agent report, `servermin-agent key`.
- Manager: `agent-hub.ts`, `agents` table (migration 2), enrol/revoke endpoints, server states
  from connections, `agents.*` configuration, certificate fingerprint in `GET /api/v1/manager`.
- Installer: self-signed certificate and TLS configuration for a new Manager.
- Core: `GatewayHost.otherUpgrade` so one HTTP server can carry both WebSocket endpoints.

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
9. A cloned data directory duplicates the identity (and now the key). The Manager keeps one
   connection per agent and audits a second live one from another address as a possible clone;
   two clones behind one address take turns unnoticed.
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
14. Resolved in Phase 3 for new Manager installs (certificate created by the installer). The
    agent's own local interface still has no TLS by default.
15. `servermin-verify` does not check a Manager installation.

From Phase 3:

16. ~~`agent.manager` needs a root-owned file and a restart.~~ Resolved in Phase 4: `register`
    writes `<stateDir>/manager.json`, which the agent picks up within 2 s.
17. A reverse proxy that terminates TLS in front of the Manager breaks the certificate binding of
    agent authentication. Not supported.
18. Replacing the Manager's certificate means touching every agent. No rotation mechanism yet
    (roadmap Phase 37).
19. Each heartbeat writes `last_seen_at` (every 15 s per agent).
20. The Manager's connection events (`agent.connected`, `agent.disconnected`) are only logged and
    put on the in-memory bus; a persistent event store is Phase 20.
21. `servermin-verify` checks neither the Manager nor the agent's link to one.

From Phase 4:

22. The URL in the printed registration command comes from the `Host` header the administrator
    used; behind NAT it may not be what agents can reach.
23. Registrations and used codes are kept forever; nothing prunes them.
24. A registration does not expire while pending; a rejected or superseded agent keeps retrying
    every 30 s until someone runs `servermin-agent leave` on it.

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

2026-11-11, end of Phase 4: `npm run typecheck` clean, `npm run build` clean, `npm test`
36 files / 400 tests passing (Node.js 22.23.4). Added `tests/integration/registration.test.ts`
(13 tests, three consecutive passing runs): the code format, hashing and permissions; reuse, expiry,
revocation, malformed requests that do not use a code up, and address lockout; the full flow with
the built `servermin-agent` program against a real Manager over TLS and a real agent that picks up
the registration without a restart; codes that approve themselves; a reinstall through a code
bound to the server (new key, same server, server id adopted); an unbound code never attaching to
an existing server; rejection; a wrong fingerprint sending nothing; an untrusted certificate
explained; trusting a CA file; `leave`; refusals before any network access; and an unusable
registration file. The test helper's HTTPS client trusts the test certificate instead of
switching verification off.

End of Phase 3 (kept for reference):
2026-11-11, end of Phase 3: `npm run typecheck` clean, `npm run build` clean, `npm test`
35 files / 387 tests passing (Node.js 22.23.4); the protocol tests were run repeatedly to look for
timing-dependent failures (one found and fixed in the Manager's close handling). Added:
`packages/protocol/test/protocol.test.ts`, key and settings tests in `packages/core/test/agent.test.ts`,
and `tests/integration/protocol.test.ts`: a real agent against a real Manager (enrol, connect,
Manager restart, revoke, removal, server-id adoption, degraded state); raw clients against the
Manager (wrong key, unknown agent, replayed signature, wrong server id, nothing before
authentication, silent connection, version mismatch, browser, stalled heartbeats, malformed,
binary, oversized, flood, duplicate); the agent link against misbehaving Managers (no answer, not
a Manager, rubbish, no common version, no heartbeat acknowledgements, connection cut mid-frame,
accepted then dropped); TLS (pinned, wrong pin, untrusted, CA file, proof made for another
certificate); and two real processes with `kill -9` in both directions. That last test takes
about 35 s because an agent that was refused waits 30 s before trying again.

By hand, on a real installation in a container: Manager installed with its generated certificate
and serving HTTPS only, agent pinned to it, enrolled with the output of `servermin-agent key`,
reconnected within seconds of a `kill -9` and restart of the Manager, `OFFLINE` when stopped.
Still not exercised: anything under a running systemd.

## Next phase

Phase 5 — Server inventory: list, detail, metadata, OS, agent version, IP, last seen, uptime and
hardware, and the full set of states. Plan:

1. Decide what the agent reports and when: extend `SERVER_STATE` (OS details, uptime, address the
   Manager saw) rather than add message types; hardware waits for Phase 6's profile.
2. Store the latest report per server (one row, replaced), not a history: history is metrics and
   events (Phases 7 and 20).
3. States beyond ONLINE / DEGRADED / STALE / OFFLINE / UNKNOWN that Phase 5 can derive honestly
   (`CONNECTING` while a handshake is in progress, `ERROR` for an agent that reports ERROR), and
   leave the rest (`WAKING`, `UPDATING`, …) to the phases that cause them.
4. `GET /servers` filters and sorting; `last_seen_at` writes reduced (known issue 19).
5. Tests: a report changes the inventory; a stale report never overwrites a newer one; a server
   that goes away keeps its last known facts, marked as such.
