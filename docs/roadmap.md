# Servermin roadmap

Status tracker for the Servermin implementation roadmap (the "Claude Fable 5.2 roadmap" supplied by
the project owner on 2026-11-10). This file is a **condensed** copy: goals, deliverables, exit
criteria and status for every phase, plus the rules that apply to all of them. Where it and the
owner's original text differ, the original wins.

Current position and decisions: [project-state.md](project-state.md).

Status: `[ ]` not started · `[~]` in progress · `[x]` complete (implemented, tested, integrated,
reviewed and documented — nothing less).

## Rules for every phase

- Work bottom-up: infrastructure → agent → protocol → manager backend → inventory → UI →
  capabilities → applications → monitoring → automation → advanced infrastructure.
- Loop: read the roadmap → inspect the repository → find what exists → determine what is missing →
  plan → implement → test → lint/typecheck/build → inspect the diff → review → fix → test again →
  document → update this file and `project-state.md` → commit.
- Existing architecture is presumed valuable. Before replacing a subsystem, answer: why is it
  insufficient, what must change, can it be extended, what could be lost, how is the replacement
  tested.
- Preserve: core/module separation, module lifecycle, worker isolation, privilege separation and
  helper, network rollback, signed updates and update rollback, system-disk awareness, SQLite
  storage, the frontend module architecture, ENTERPRISE-UI, the test architecture.
- Review gate before marking a phase complete: architecture, security, reliability, recovery,
  testing, compatibility, performance, operability, documentation.
- No fake complete: a UI, an API, compiling code, a working mock or a passing happy-path test is not
  completion.
- Tests: unit, integration, failure-path, permission/security, UI for important workflows; real
  Linux behaviour wherever possible.
- Security boundary: the Manager must not become root on every server. Manager → authenticated
  command → Agent → authorisation → module → privileged helper → Linux.
- Docker: do not add the service account to the `docker` group for convenience; prefer controlled
  access through the Docker module.
- Platform-critical resources (management disk, filesystem, network interface, manager connection,
  agent service) need validation, explicit confirmation and a recovery plan for dangerous
  operations.
- Priority: correctness, security, recoverability, maintainability, testability, performance, UI
  polish.
- Record significant decisions in `docs/adr/`. Commits are meaningful milestones
  (`feat(agent): add heartbeat protocol`).

## Phases

| # | Phase | Status | Exit criteria |
| --- | --- | --- | --- |
| 0 | Architecture audit | [x] | The current system can be explained without guessing |
| 1 | Agent foundation | [x] | Agent starts automatically and reports server id, agent id, hostname, OS, version, capabilities |
| 2 | Manager foundation | [ ] | Manager starts independently and keeps a persistent server inventory |
| 3 | Agent/Manager protocol | [ ] | Agent disconnects and reconnects without manual intervention |
| 4 | Server registration | [ ] | Code → install → `servermin-agent register CODE` → approve → managed |
| 5 | Server inventory | [ ] | Manager accurately reflects server state |
| 6 | Hardware discovery | [ ] | A newly registered server populates its hardware profile automatically |
| 7 | Metrics | [ ] | Manager displays live resource utilisation |
| 8 | Server dashboard | [ ] | An administrator understands a server's health without SSH |
| 9 | Capability system | [ ] | A new module adds a capability without modifying the Manager core |
| 10 | Resource manager | [ ] | Application requirements are validated before deployment |
| 11 | Docker | [ ] | Containers, images, volumes, networks, logs, lifecycle, health, usage, Compose; no blanket docker group |
| 12 | Application management | [ ] | Application model and lifecycle states |
| 13 | Wake-on-LAN | [ ] | Manager wakes a powered-off server when the network permits |
| 14 | WOL proxy | [ ] | Another agent relays the packet; failures are reported |
| 15 | Server groups | [ ] | Default groups exist and can carry policy later |
| 16 | Services | [ ] | systemd management that respects criticality |
| 17 | Storage | [ ] | Inventory, S.M.A.R.T., and protection of system disk, management filesystem and network |
| 18 | Network management | [ ] | Inventory; existing rollback preserved |
| 19 | Centralised updates | [ ] | Staged rollout with validation and rollback; never all servers at once by default |
| 20 | Events | [ ] | Persistent typed events |
| 21 | Alerting | [ ] | Rules with severity, deduplication, suppression, acknowledgement, resolution |
| 22 | Notifications | [ ] | In-app, email, webhook, push |
| 23 | Automation | [ ] | IF/THEN rules with validation, execution, result, audit |
| 24 | Audit | [ ] | Timestamp, user, server, action, resource, result, duration, correlation id |
| 25 | Remote terminal | [ ] | PTY over WebSocket with authn, authz, audit |
| 26 | Diagnostics | [ ] | One click, PASS/WARN/FAIL per check |
| 27 | Recovery | [ ] | Recovery exists outside the main process |
| 28 | Failure injection | [ ] | Each injected failure recovers or yields a clear recovery path |
| 29 | Dependency graph | [ ] | "What breaks if this server goes offline?" is answerable |
| 30 | Topology | [ ] | Networks, servers, containers, applications, storage visualised |
| 31 | Application catalogue | [ ] | Modular definitions |
| 32 | Backup / restore | [ ] | Configuration, policies, automation, application and module configuration, secrets |
| 33 | API | [ ] | REST and WebSocket surface for every resource |
| 34 | CLI | [ ] | `servermin …` on the same API as the web interface |
| 35 | Roles and permissions | [ ] | Five roles, eleven permission areas |
| 36 | Self monitoring | [ ] | Manager, agent, database, WebSocket, modules, workers, queues, updates, recovery |
| 37 | Production hardening | [ ] | Signed releases, certificate rotation, rate limiting, recovery and upgrade testing |
| 38 | Distribution | [ ] | Ubuntu and Debian packages first; USB remains supported |

### Phase 0 — Architecture audit `[x]`

- [x] Inspect repository
- [x] Map existing, frontend, backend, module, privilege, update, storage, authentication,
      networking and testing architecture
- [x] Identify USB-specific assumptions
- [x] `docs/architecture/current-state.md`, `target-state.md`, `migration-plan.md`

### Phase 1 — Agent foundation `[x]`

- [x] Agent identity (server id, agent id, hostname, machine id) — `core/src/agent/identity.ts`, ADR-003
- [x] Agent configuration — `agent.stateDir`
- [x] Agent systemd service — existing unit, now also `servermin-agent.service` (alias)
- [x] Agent lifecycle — `STARTING` / `RUNNING` / `STOPPING`
- [x] Agent logging — log source `agent`
- [x] Agent health — core health in the report
- [x] Agent version
- [x] Agent capabilities — derived from working modules
- [x] Report: `GET /api/v1/agent`, `servermin-agent status`, `servermin-verify` check

Not verified under a running systemd (none in the build environment): that the alias resolves
for `systemctl status servermin-agent`. Unit-file operations were verified with the real
`systemctl`; `servermin-verify` warns on a server where the alias is missing.

### Phase 2 — Manager foundation `[ ]`

- [ ] Manager service, configuration, database
- [ ] Authentication foundation
- [ ] Server inventory
- [ ] API and WebSocket foundation

### Phase 3 — Agent/Manager protocol `[ ]`

- [ ] Schema, message ids, correlation ids
- [ ] Authentication
- [ ] Reconnection, heartbeat, timeout, backoff, connection state

### Phase 4 — Server registration `[ ]`

- [ ] Registration codes, expiry, one-time use
- [ ] Server identity, certificate identity
- [ ] Approval, registration audit

### Phase 5 — Server inventory `[ ]`

- [ ] List, detail, metadata, OS, agent version, IP, last seen, uptime, hardware
- [ ] States: UNKNOWN, DISCOVERING, CONNECTING, ONLINE, DEGRADED, STALE, WAKING, UPDATING,
      REBOOTING, SHUTTING_DOWN, OFFLINE, ERROR, RECOVERY

## MVP (roadmap §58)

Manager: authentication, inventory, registration, status, groups, basic dashboard, events, basic
metrics, Wake-on-LAN. Agent: stable identity, systemd service, registration, TLS WebSocket,
heartbeat, hardware discovery, metrics, events, existing modules.

Exit: install an agent, register it, see it online with hardware and CPU/RAM/storage, see events,
watch it go offline when the connection is lost and return when restored, wake it with WOL.

After the MVP: Docker → applications → storage → network → services → updates → monitoring →
alerts → automation → recovery → diagnostics → topology → dependency graph → application catalogue.
