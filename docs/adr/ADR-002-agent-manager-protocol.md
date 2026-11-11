# ADR-002: Agent/Manager protocol, authentication and TLS trust

- Status: **Accepted**
- Date: 2026-11-11 (Phase 3)

## Context

Agents must report to a Manager across networks the Manager does not control, keep working when
it is gone, and come back without anyone stepping in. The Manager must never accept a server
because something claims to be it: ids are not secrets (ADR-003). Phase 2 left the Manager on plain
HTTP (known issue 14). Node.js can create keys and signatures but not X.509 certificates, and the
Manager is forbidden from starting processes, so it cannot run `openssl`.

## Decision

### Transport

1. The **agent opens** the connection, a WebSocket to `LINK_PATH` (`/api/v1/agent/link`) on the
   Manager's port. That works through NAT and firewalls that allow outbound traffic, and the Manager
   never needs to reach into a server's network. The endpoint is separate from the browser
   WebSocket (`/api/v1/ws`) and does its own authentication; browser sessions are never accepted on
   it.
2. Frames are JSON text, at most 256 KiB, one envelope each: `{ v, id, type, correlationId?,
   payload }`. Every message has an id; a reply carries the id it answers as `correlationId`.
3. `packages/protocol` holds the types, a hand-written validator (no new dependency), the close
   codes and the text to sign. Both sides import it; `encode` runs the receiving side's decoder
   before sending, so a malformed message is a bug at the sender. Unknown payload fields are
   dropped, unknown types are errors, and types reserved for later phases (`COMMAND`, `METRIC`, …)
   are refused as "not supported by protocol version 1".

### Handshake and versions

```
Manager → HELLO          { managerVersion, protocolVersions: [1], nonce: 32 random bytes }
Agent   → AUTHENTICATE   { protocolVersion, agentId, serverId, agentVersion, keyFingerprint, signature }
Manager → AUTHENTICATED  { sessionId, protocolVersion, serverId, heartbeatIntervalMs, timeoutMs }
Agent   → SERVER_STATE   (the agent report, on connect and whenever capabilities, health or state change)
Agent   → HEARTBEAT      { sequence, state, health, uptimeSeconds }   every heartbeatIntervalMs
Manager → HEARTBEAT_ACK  { sequence }
Either  → ERROR          { code, message }, then close
```

The agent picks the highest version both list. With none in common it closes with 4406 and keeps
retrying at the longest interval, because the next Manager release may add it.

### Authentication

4. Each agent has an **Ed25519 key pair**, created on first connection in
   `<agent.stateDir>/agent-key.pem` (0600). The Manager stores only the public key, in a new
   `agents` table (migration 2), one agent per server. A damaged key is kept aside, like a damaged
   identity, never overwritten.
5. The agent signs `servermin-link-auth \n v<version> \n <nonce> \n <agentId> \n <serverId> \n
   <Manager key fingerprint>`. The Manager checks that the agent is enrolled, that the server id is
   the one it was enrolled for, and the signature. The fresh nonce prevents replay.
6. The **Manager key the agent saw** is part of the signed text, and the Manager requires it to be
   its own (`agents.requireKeyBinding`, on by default). A relay with its own certificate therefore
   cannot use an agent's signature against the real Manager. Behind a reverse proxy that terminates
   TLS this has to be turned off, and agents pin the proxy's key instead.
7. A refused agent is told "Authentication failed" and nothing more. The reason (unknown agent,
   wrong key, server mismatch, key binding) goes to the Manager's audit log (`agent.authenticate`)
   and journal. Ten failed handshakes from one address in ten minutes lock that address out for 15
   minutes, before the WebSocket upgrade.
8. Phase 4 adds the registration flow that enrols keys. Until then `AgentRegistry.enroll` is the
   only way in, used by the tests and available to an administrator's own tooling.

### TLS and trust

9. **TLS is the default for the Manager.** With no certificate configured, it creates a
   self-signed ECDSA P-256 certificate in `<paths.data>/tls` (key 0600). The certificate is
   DER-encoded in-process (`packages/core/src/tls/certificate.ts`), and the tests check it against
   OpenSSL. Plain HTTP needs `http.selfSigned: false` or `SERVERMIN_MANAGER_TLS=off`, and the
   Manager then warns at every start.
10. Agents **pin the SHA-256 of the Manager's public key** (SPKI), not of the certificate. The
    Manager renews its certificate 30 days before expiry **with the same key**, so renewal never
    breaks a pin. The fingerprint is printed at start (journal), shown by `install.sh --manager` and
    returned by `GET /api/v1/manager`. It can be checked with
    `openssl x509 -pubkey -noout -in manager.crt | openssl pkey -pubin -outform der | sha256sum`.
11. On the agent, `agent.manager.fingerprint` pins the key and replaces certificate-authority
    checks. Without a pin, the certificate is verified normally, against `agent.manager.ca` if given
    or the system CAs otherwise. The pin is checked as soon as the TLS handshake finishes, before
    the agent signs anything. `ws://` is accepted only for a Manager on the same machine.

### Liveness and reconnection

12. The Manager tells each agent the heartbeat interval (default 15 s) and timeout (60 s). It marks
    a server **STALE** after 35 s without a message and closes the connection at the timeout, which
    makes the server **OFFLINE**. The agent likewise gives up a connection that has been silent for
    the timeout, which catches half-open TCP that the kernel has not noticed.
13. The agent reconnects forever, with exponential backoff (1 s doubling to 60 s) and equal jitter:
    half the delay fixed, half random. The backoff resets only after a connection has lasted 30 s,
    so a Manager that accepts and drops agents is not hammered. Refusals that a retry soon will not
    fix (bad credentials, duplicate, no common version, wrong pinned key) wait the full maximum.
    Nothing is queued while disconnected: the full state is sent on every connection.
14. The same failure is logged once at WARN, then at DEBUG until it changes, so a day without a
    Manager does not flood the journal.
15. After a start the Manager marks every server with an agent OFFLINE (UNKNOWN without one). A
    Manager that crashed may have left servers ONLINE, and nothing is connected yet.

### Duplicate identities

16. When a second connection authenticates for an agent that already has one, the Manager pings
    the old connection. If it answers within `agents.duplicateProbeMs` (5 s), two installations
    share one identity (ADR-003: a cloned disk or a restored backup). The new connection is refused
    with 4409, and the refusal is audited (`agent.duplicate`), published on the event bus and
    logged. If the old connection does not answer, it is half-open (the agent restarted or changed
    networks): it is closed with 4410 and the new connection replaces it.

## Consequences

- An agent without `agent.manager.url` behaves exactly as before: no key, no connection, its link
  status is `DISABLED`.
- Existing Manager clients now need `https://`, and the self-signed certificate must be trusted or
  pinned. Browsers will warn until an administrator configures their own certificate.
- The protocol has no command channel yet. `COMMAND` is reserved, and authorisation on the agent
  side is Phase 9 onwards.
- Close codes: 1001 shutting down, 1009 frame too large, 4400 protocol error, 4401 authentication
  failed, 4406 no common version, 4408 timeout, 4409 duplicate, 4410 replaced, 4429 rate limited.
