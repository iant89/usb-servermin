# ADR-001: Manager/Agent architecture built on the existing core

- Status: **Proposed** (to be accepted or revised when Phase 1 starts)
- Date: 2026-11-10

## Context

Servermin changes from a per-server web panel into a central Manager with an Agent on every server.
The Phase 0 audit ([current state](../architecture/current-state.md)) found that the existing core
already provides what the roadmap lists as agent responsibilities: a systemd service, module
execution with fault isolation, hardware discovery, metrics, Docker, storage, network, services,
logs, signed updates with rollback, and a privilege boundary. It has no concept of another server.

## Decision

1. **The Agent is the existing core**, extended with a new subsystem (`packages/core/src/agent/`)
   for identity, an outbound connection to a Manager, registration and command dispatch. With no
   Manager configured it behaves as it does today, including the local web interface.
2. **The Manager is a new process** (`packages/manager`) that reuses the core's libraries
   (database, authentication, audit, events, logging, HTTP, WebSocket) but has its own entry point,
   unit, configuration and database, and holds no privilege on any server.
3. **A shared `packages/protocol`** defines the messages both sides exchange.
4. Agents open the connection; the Manager never connects to a server.

## Consequences

- No module, SDK, helper or updater change is needed to start.
- `HttpServer` and `WebSocketGateway` must stop depending on the concrete `Platform` class so the
  Manager can host them. This is an interface extraction with unchanged behaviour.
- Agents are heavier than a minimal telemetry daemon: each carries the full module runtime and a
  local UI. Accepted: that is what makes a server manageable while the Manager is unreachable.
- Manager and Agent share a version and a release, which keeps the protocol in step; mixed versions
  during a staged rollout must be handled by protocol version negotiation (Phase 3).

## Alternatives considered

- **A separate small agent beside the core.** Duplicates supervision, configuration, updates and
  the privilege boundary, and needs a second path into every module.
- **The Manager as a module of the core.** Modules can be unloaded and sit behind worker RPC;
  inventory, authentication and agent connections are platform concerns, and the roadmap requires
  the Manager to start independently.
- **Manager connects to agents (SSH or HTTPS pull).** Requires inbound access to and stored
  credentials for every server, which is the root-on-every-server outcome the roadmap forbids.
