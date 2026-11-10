# Migration plan

How to get from the [current state](current-state.md) to the [target state](target-state.md)
without rewriting what works. Phase numbers are those of [the roadmap](../roadmap.md).

## Principles

1. Every step leaves a standalone server working exactly as today. An agent with no Manager
   configured must behave like version 1.0.0.
2. Additive first: new packages and new core subsystems; refactors only where reuse requires them,
   each behind the existing tests.
3. The SDK module contract does not change in the MVP phases. Modules keep `apiVersion` 1.
4. No new runtime dependency without an ADR.

## Reuse map

| Phase | Exists | Partial | Missing |
| --- | --- | --- | --- |
| 1 Agent foundation | systemd service, lifecycle, logging, health, version, configuration loader | capabilities (module manifests declare them; nothing aggregates them) | identity (agent id, server id), identity/health report, `servermin-agent` name |
| 2 Manager foundation | database, auth, HTTP, WebSocket, audit, logging (as libraries) | they are coupled to `Platform` | Manager process, configuration, inventory schema |
| 3 Protocol | `ws` dependency, RPC framing pattern in `modules/rpc.ts` | | protocol package, client with reconnect/backoff/heartbeat, TLS trust |
| 4 Registration | setup-token pattern, hashed token storage, audit | | codes, approval, agent credentials, `servermin-agent register` |
| 5 Inventory | host summary, System module info | | server states, last seen, persistence |
| 6 Hardware discovery | CPU, memory, GPU, DMI, OS, kernel, arch, disks (Storage), interfaces (Network) | spread over three modules | temperatures, one consolidated profile |
| 7 Metrics | CPU, memory, swap, disk usage, network I/O, processes, history, alerts | | disk I/O, temperature, GPU utilisation, forwarding to the Manager |
| 8 Dashboard | shell, ENTERPRISE-UI, module UIs | single-server client | Manager pages, remote module UI routing |
| 9 Capabilities | `provides`/`requires`, `capabilities` tags | | reporting, Manager-side gating |
| 11 Docker | full local module | | controlled access without the docker group |
| 12, 31 Applications, catalogue | local module and catalogue | lifecycle states differ from the roadmap's | Manager-side view, resource validation (Phase 10) |
| 16–18 Services, Storage, Network | local modules, netplan rollback | protections are hard-coded | derived criticality (§56) |
| 19 Updates | signed releases, root updater, health check, rollback, maintenance window | per server only | staged rollout across servers, Manager self-update |
| 20–22 Events, alerts, notifications | event bus, threshold alerts, in-app notifications | not durable, not central | persistent store, rules, channels |
| 24 Audit | audit log and CSV export | | duration, correlation id, server |
| 25 Terminal | local PTY terminal, audited | | relay through the Manager |
| 27 Recovery | update rollback and network rollback run outside the main process | | recovery entry point with the roadmap's options |
| 33–34 API, CLI | `/api/v1`, `serverctl` | single server | Manager API, `servermin` CLI |
| 35 Roles | permissions, wildcards, presets | | stored roles, scoping to groups |
| 10, 13–15, 23, 26, 28–30, 32, 36–38 | | | all of it |

## Sequence for the MVP (Phases 1–8, 13, 15, 20)

**Phase 1 — Agent foundation.** Add `packages/core/src/agent/`: identity store, an `agent`
configuration section (off by default), an aggregated capability list from the module manager, and a
local report (`GET /api/v1/agent`, `servermin-agent status`) with server id, agent id, hostname, OS,
version and capabilities. Add `servermin-agent.service` as an alias of the unit. ADR-003. **Done.**
*Proof:* integration test starts a core and reads the report; identity survives a restart;
`systemd-analyze verify` on the unit; `servermin-verify` extended.

**Phase 2 — Manager foundation.** Narrow `HttpServer`/`WebSocketGateway` to a host interface (no
behaviour change), then add `packages/manager` with its own database (`servers`, `agents`), reusing
auth and the setup token. ADR-001 accepted here.
*Proof:* all 226 existing tests unchanged; new integration test starts a Manager with no agent code
loaded and persists an inventory across a restart.

**Phase 3 — Protocol.** `packages/protocol`, agent link with heartbeat, timeout, jittered backoff
and connection states; Manager endpoint. ADR-002.
*Proof:* tests that kill the Manager, drop the socket mid-message, stall heartbeats and send
malformed or oversized frames; the agent reconnects unaided.

**Phase 4 — Registration.** One-time, expiring codes; agent key pair; approval; audit.
*Proof:* reuse, expiry, replay and wrong-key tests; a revoked agent cannot reconnect.

**Phases 5–7 — Inventory, hardware, metrics.** Agent sends `SERVER_STATE`, the consolidated hardware
profile and 5-second live metrics; Manager derives server states from the connection
(`ONLINE` → `STALE` → `OFFLINE`).
*Proof:* state-transition tests driven by a real disconnected agent process, not a mock.

**Phase 8 — Dashboard**, then **13 WOL**, **15 groups**, **20 events** to complete the MVP list in
roadmap §58.

Post-MVP order follows roadmap §59.

## Things that must be settled before the phase that needs them

| Question | Needed by | Default if nobody objects |
| --- | --- | --- |
| Agent = evolved core, Manager = separate process reusing core libraries | Phase 1 | Yes (ADR-001) |
| Manager TLS: self-signed with pinned fingerprint handed out with the registration code, or bring-your-own certificate | Phase 3 | Support both; pinning by default |
| Portable installation booted on other hardware: same server or new server | Phase 1 | Same server, hardware-changed event |
| Repository and product renames | Phase 1 (unit name) | Alias now, swap later (see target state §10); leave the repository name to the owner |
| Docker without the docker group | Phase 11 | Keep today's behaviour until then; record as technical debt |

## Risks

| Risk | Mitigation |
| --- | --- |
| The refactor for reuse breaks the standalone server | Interface extraction only, existing tests as the gate, done in its own commit |
| Renaming the unit breaks the helper's self-protection or an update rollback | Phase 1 only adds an alias; helper, Services module and updater already accept both names, covered by tests |
| A Manager compromise becomes fleet compromise | Typed commands only, agent-side policy, per-agent revocable keys, no Manager-held host credentials |
| Mocked tests give false confidence for Linux behaviour | Add a CI job on a real Ubuntu runner with systemd for agent install/start/reconnect before the MVP is called done (roadmap §52) |
| Metric and event volume on a small Manager | Agents keep history; the Manager stores coarse series and bounded events |

## Not to be touched during the MVP

`modules/*` behaviour, `packages/sdk` contract, `deploy/servermin-privileged` operation semantics,
`deploy/servermin-update.mjs` verification logic, netplan rollback, the storage thread.
