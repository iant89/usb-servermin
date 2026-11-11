# Project state

Working memory for the Servermin transformation. Read this first in a new session, then
[roadmap.md](roadmap.md). Updated at the end of every phase.

Last updated: 2026-11-11

## Current phase

Phase 4 — Server registration (not started).

## Completed phases

- Phase 0 — Architecture audit (2026-11-10)
- Phase 1 — Agent foundation (2026-11-10)
- Phase 2 — Manager foundation (2026-11-10)
- Phase 3 — Agent/Manager protocol (2026-11-11)

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
- [ADR-002](adr/ADR-002-agent-manager-protocol.md) (Accepted): agent-initiated WebSocket over TLS
  to `/api/v1/agent/link`; Ed25519 challenge signed together with the Manager key the agent saw;
  agents pin the Manager's public key (SPKI); TLS by default with an in-process self-signed
  certificate, renewed with the same key; heartbeat 15 s, STALE 35 s, timeout 60 s; equal-jitter
  backoff 1-60 s; duplicate ids resolved by probing the live connection.
- [ADR-003](adr/ADR-003-server-identity.md) (Accepted): two random UUIDs (agent id, server id)
  stored with the data; hostname, machine id and hardware are attributes; ids are not secrets.
- Phase 1, unit naming: alias instead of rename, because the installed release's updater performs
  the rollback and 1.0.0's would leave a renamed unit not enabled at boot.
- Phase 1, capabilities: a flat, derived list of module ids and provided services from modules
  that are `ACTIVE` and not `ERROR`/`OFFLINE`; manifest `capabilities` tags are reported per module
  as `tags` and left for Phase 9 to formalise.

## What Phase 3 added

- `packages/protocol`: envelope, seven message types, validation, close codes, version negotiation,
  the signed text. Reserved types are refused by name.
- Core: `tls/certificate.ts` (X.509 encoder, `ensureSelfSignedCertificate`), `agent/agent-key.ts`,
  `agent/manager-link.ts`, `agent.manager` configuration (`url`, `fingerprint`, `ca`; env
  `SERVERMIN_AGENT_MANAGER_URL|FINGERPRINT`), link status in `GET /api/v1/agent` and
  `servermin-agent status`, gateway `upgrades` for other WebSocket paths.
- Manager: migration 2 (`agents`), `AgentRegistry`, `AgentLinkServer`, inventory states
  ONLINE/STALE/OFFLINE, reconciliation on start, `agents.*` configuration, TLS by default
  (`http.selfSigned`, `SERVERMIN_MANAGER_TLS`), `GET /api/v1/servers/:id/agent`, TLS details in
  `GET /api/v1/manager`. `install.sh --manager` prints https and the key fingerprint.
- Known issue 14 (Manager without TLS) is resolved.

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
14. ~~Without TLS the Manager serves passwords in clear text.~~ Resolved in Phase 3.
15. `servermin-verify` does not check a Manager installation.

From Phase 3:

16. Agents cannot be enrolled through the API yet: Phase 4's registration does that. Until then a
    real deployment cannot connect an agent without writing to `manager.db`.
17. The self-signed certificate makes browsers and `curl` warn until it is trusted
    (`--cacert`) or replaced by your own.
18. Replacing the Manager's TLS key breaks every pinned agent; there is no key rotation with
    overlap yet (Phase 37: certificate rotation).
19. The local agent's `agent.manager` settings are file-only; there is no UI for them (Phase 4's
    `servermin-agent register` will write them).
20. `SERVERMIN_ROOT` (development) replaces the whole configuration with defaults, including
    `agent.manager`; use `SERVERMIN_AGENT_MANAGER_URL` in development.

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

2026-11-11, end of Phase 3: `npm run typecheck` clean, `npm run build` clean, `npm test`
36 files / 376 tests passing (Node.js 22.23.4). Added in Phase 3:
`packages/protocol/test/messages.test.ts`, `packages/core/test/manager-link-units.test.ts`
(certificate checked against OpenSSL, agent key, backoff, configuration) and
`tests/integration/agent-link.test.ts`. The integration tests cover: pinned TLS connect, heartbeats,
reports; Manager stopped and restarted; the built Manager killed with SIGKILL and restarted on
the same data; a Manager that stops answering; sockets dropped mid-frame in both directions;
STALE → OFFLINE for a silent agent and back to ONLINE; authentication timeout; malformed, unknown,
reserved, out-of-order, binary and oversized frames; unknown agent, wrong key, server-id mismatch,
key binding; wrong pin, untrusted and CA-trusted certificates; address lockout; duplicate and
half-open connections; removing a server; a real agent process end to end. The agent-link suite
passed four consecutive runs.

## Next phase

Phase 4 — Server registration. Plan:

1. Registration codes in the Manager: random, one-time, expiring, hashed at rest, audited; created
   by `servers.manage`, optionally bound to an existing server.
2. `servermin-agent register CODE --manager wss://…` (run as root, or through a local channel to the
   running agent, see known issue 8). It shows the Manager's key fingerprint for confirmation, sends
   the agent's public key and identity with the code, and writes `agent.manager` once approved.
3. Approval: a registration waits as pending until an administrator approves it (or is
   auto-approved when the code says so); then `AgentRegistry.enroll`. A reinstalled agent on a
   known server adopts the server id (`IdentityStore.setServerId`), and AUTHENTICATED already
   carries the server id.
4. Revocation of an agent (closes its connection with 4401), and re-registration after a key loss.
5. Tests: expiry, reuse, wrong code, brute force, approval, revocation, reinstall on a known server.
