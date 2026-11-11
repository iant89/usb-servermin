# ADR-002: Agents connect outward to the Manager over an authenticated WebSocket

- Status: **Accepted**
- Date: 2026-11-11 (Phase 3)

## Context

The Manager must know the state of every server and, later, send it commands, without holding
anything that works as a login on a server (roadmap §53). Servers are often behind NAT or a
firewall that the Manager cannot reach into. The project keeps runtime dependencies to a minimum
(`ws` is the only one), and Node.js cannot create X.509 certificates without one.

## Decision

**Transport.** Each agent opens one WebSocket to `wss://<manager>/api/v1/agents/ws` and keeps it
open. The Manager never connects to an agent. Messages are JSON text frames of at most 256 KiB:

```json
{ "v": 1, "id": "…", "type": "HEARTBEAT", "ts": "…", "correlationId": "…", "payload": { } }
```

Every message has an id; an answer carries the id it answers as `correlationId`. The types are
`HELLO`, `AUTHENTICATION`, `AUTHENTICATED`, `ERROR`, `HEARTBEAT`, `SERVER_STATE`, `CAPABILITIES`,
and, reserved for later phases, `METRIC`, `EVENT`, `COMMAND`, `COMMAND_RESULT`, `LOG`,
`MODULE_STATE`. Both sides use the same code for this (`packages/protocol`).

**Trust in the Manager.** TLS. An agent accepts the Manager's certificate in one of three ways:
its SHA-256 fingerprint is pinned (`agent.manager.fingerprint`; the default for the self-signed
certificate the installer creates), it chains to a CA file (`agent.manager.ca`), or it is publicly
trusted. A connection without TLS needs `agent.manager.insecure: true` and is meant for a Manager
on the same machine.

**Trust in the agent.** Each agent has an Ed25519 key pair created on its server; the private key
never leaves it. The Manager stores the public key of each enrolled agent. To authenticate:

1. The Manager sends `HELLO` with the protocol versions it speaks and a random 32-byte nonce.
2. The agent picks the highest common version and sends `AUTHENTICATION` with its agent id, server
   id, the version, and a signature over: a fixed label, the version, the nonce, both ids, and the
   fingerprint of the TLS certificate it saw.
3. The Manager verifies the signature with the enrolled key, using its *own* certificate
   fingerprint, and answers `AUTHENTICATED` (server id, heartbeat interval and timeout) or `ERROR`
   and closes.

The nonce makes a captured signature useless on any other connection. Signing the certificate
fingerprint makes it useless through a machine in the middle, which necessarily presents a
different certificate. Every failure gets the same answer ("Not authorized"), so the endpoint does
not reveal which agents exist; the reason goes to the Manager's audit log.

**Liveness.** The agent sends `HEARTBEAT` at the interval the Manager set (15 s); the Manager
acknowledges each one. The Manager derives the server's state from the connection: `ONLINE`, or
`DEGRADED` when the agent reports itself unhealthy; `STALE` after 2.5 missed intervals; `OFFLINE`
when the connection ends or stays silent past the timeout (60 s). An agent that gets no
acknowledgement within the timeout drops the connection itself. At start the Manager resets every
server to `OFFLINE` (or `UNKNOWN` without an agent): state is never remembered, only observed.

**Reconnection.** Any failure, at any stage, on either side, ends in a retry: 1 s doubling to
60 s, with jitter, reset only after a connection has lasted 30 s. After a refusal the agent waits
longer (30 s when not authorized, 60 s when revoked, replaced or refused as a duplicate, 5 min on a version mismatch),
because a person has to act first. Nothing about the link can stop or slow the server itself.

**One connection per agent.** When a second connection authenticates as an agent that is
already connected, the Manager pings the existing connection (`agents.duplicateProbeSeconds`,
5 s). If the existing connection answers, two installations share one identity (a cloned disk, a
restored backup). The newcomer is refused with 4410 `duplicate`, and the refusal is audited
(`agent.duplicate`), published on the event bus and logged; the live connection is untouched. If
the existing connection does not answer, it is half-open (the agent restarted or changed networks):
it is closed with 4409 `replaced` and the new one takes its place. Replacing unconditionally, as
the first version did, made two clones knock each other off on every reconnect, forever. Anything
the newcomer sends during the check ends its connection.
*(Amended 2026-11-11.)*

**Limits.** Upgrades are rate-limited per address. Unauthenticated connections are capped at 200
in total and 16 per address, and have 10 s to authenticate. Ten failed handshakes from one address
in 10 minutes (bad signature, anything malformed or out of order before authentication, or silence
until the timeout) lock that address out for 15 minutes, refused with HTTP 429 before the
WebSocket upgrade. "Agent is not enrolled" does not count: that is the normal state of a new server
until someone enrols it, and its 30 s retries would otherwise lock out every agent behind the same
NAT address. Frames are size-limited, frames are size-limited, and a connection that sends more than 300
messages in 10 s is closed. Requests with an `Origin` header are refused, so a web page cannot
open the endpoint. A malformed frame ends the connection; an unknown message type from an
authenticated peer is answered or skipped, so a newer agent and an older Manager can coexist.

**Enrolment** in this phase is by hand: `servermin-agent key` prints the ids and the public key,
and `PUT /api/v1/servers/:id/agent` records them. Registration codes (Phase 4) automate exactly
this step and change nothing else.

## Consequences

- The roadmap's "certificate identity" is realised as a raw public key, not an X.509 client
  certificate. The security property is the same (possession of a private key that never leaves
  the server); what is not available is terminating agent authentication in a reverse proxy.
- A Manager behind a TLS-terminating proxy breaks the certificate binding unless the agent pins
  the proxy's certificate and the Manager is told that fingerprint. Not supported yet; documented.
- Heartbeats write `last_seen_at` for every agent every 15 s. Fine for a homelab; to be batched if
  inventories grow large.
- The Manager can tell an agent its server id (`AUTHENTICATED.serverId`), which the agent adopts
  (ADR-003). The id is not a secret and grants nothing.

## Alternatives considered

- **Mutual TLS with client certificates.** Needs a CA in the Manager and certificate creation,
  which means a dependency or shelling out to `openssl` from a process that deliberately cannot
  start one; rotation and revocation would need CRLs or short lifetimes.
- **A shared secret or bearer token per agent.** The Manager would hold something that can
  impersonate the agent, and a leaked database would compromise every agent's identity.
- **HTTP polling.** No push for commands later, more requests, and no simpler to secure.
- **The Manager dials the agents.** Needs inbound reachability and stored credentials for every
  server: the outcome roadmap §53 forbids.
