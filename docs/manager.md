# Servermin Manager

The Manager is the central service of Servermin: one place that knows every server. It is a
separate process from the agent (`server-control.service`), built from the same libraries
([ADR-001](adr/ADR-001-manager-agent-architecture.md)).

**What exists today (Phases 2-3):** accounts, a persistent server inventory, a REST API, a
WebSocket endpoint, and agents that connect to it, so it knows which servers are online.
**What does not exist yet:** registration codes (Phase 4; agents are enrolled by hand, see
[Connecting an agent](#connecting-an-agent)), hardware and metrics (Phases 6-7), commands, and a
web interface (Phase 8); it is driven through the API.

## Install

The Manager ships in the same release as the agent. On the server that should run it:

```bash
sudo ./install.sh --manager
```

This creates the `servermin-manager` account, `/etc/servermin-manager`, `/var/lib/servermin-manager`,
and enables `servermin-manager.service`. On a first install it also creates a self-signed TLS
certificate (`/etc/servermin-manager/tls.crt`, valid ten years) and a configuration that uses it, so
the Manager never serves clear text; this needs `openssl`. It prints the address, the certificate
fingerprint that agents pin, and the one-time setup token (also in the journal and in
`/var/lib/servermin-manager/setup-token`). Later updates of the release keep a
Manager that is already installed up to date and restart it.

| What | Where |
| --- | --- |
| Program | `/opt/servermin/manager/manager.js`, started by `/opt/servermin/bin/servermin-manager` |
| Configuration | `/etc/servermin-manager/config.json` (optional) |
| Data | `/var/lib/servermin-manager/manager.db` (mode 0600, directory 0700) |
| Logs | `journalctl -u servermin-manager` (the Manager keeps no log database) |
| Service | `servermin-manager.service`, account `servermin-manager` |

## Configuration

Every setting has a default; the file is only needed to change one.

```json
{
  "http": { "host": "0.0.0.0", "port": 8480, "tls": { "cert": "/etc/servermin-manager/tls.crt", "key": "/etc/servermin-manager/tls.key" }, "trustProxy": false },
  "paths": { "data": "/var/lib/servermin-manager" },
  "logging": { "level": "INFO" },
  "auth": { "sessionHours": 12, "loginAttempts": 5, "lockoutMinutes": 15 },
  "agents": { "heartbeatSeconds": 15, "timeoutSeconds": 60, "handshakeSeconds": 10 }
}
```

Environment overrides: `SERVERMIN_MANAGER_CONFIG`, `SERVERMIN_MANAGER_DATA_DIR`,
`SERVERMIN_MANAGER_HOST`, `SERVERMIN_MANAGER_PORT`, `SERVERMIN_MANAGER_LOG_LEVEL`
(`/etc/servermin-manager/environment` is read by the unit).

An invalid configuration stops the service with exit code 78 and a message naming the setting; the
unit does not restart in a loop for that. The default port is 8480 because a Manager often shares a
host with an agent, which listens on port 80.

If you move the data directory, also adjust the unit: it only allows writes to its
`StateDirectory` (`/var/lib/servermin-manager`).

## First administrator

```bash
TOKEN=$(sudo cat /var/lib/servermin-manager/setup-token)
curl --cacert /etc/servermin-manager/tls.crt -c cookies -H 'X-Servermin-Request: 1' -H 'Content-Type: application/json' \
  -d "{\"setupToken\":\"$TOKEN\",\"username\":\"admin\",\"password\":\"a long password 1\"}" \
  https://localhost:8480/api/v1/auth/setup
```

For scripts, create an API token (`POST /api/v1/auth/tokens`) and send it as
`Authorization: Bearer smt_…`.

## API

All paths are under `/api/v1`. Sign-in, tokens, users and the audit log are the same endpoints,
with the same rules, as on an agent (`auth/*`, `users`, `audit`); see [security.md](security.md).

| Method and path | Permission | |
| --- | --- | --- |
| `GET health` | public | `{ status, version, service: "manager" }` |
| `GET manager` | signed in | Version, uptime, number of servers by state |
| `GET permissions` | signed in | Permission catalogue and role presets |
| `GET servers` | `servers.read` | All servers, by name |
| `GET servers/:id` | `servers.read` | One server |
| `POST servers` | `servers.manage` | `{ name, hostname?, description?, id? }` |
| `PATCH servers/:id` | `servers.manage` | `{ name?, hostname?, description? }`; `hostname: null` clears it |
| `DELETE servers/:id` | `servers.manage` | Also disconnects its agent |
| `PUT servers/:id/agent` | `servers.manage` | `{ agentId, publicKey }`: allow this agent to connect as the server (replaces a previous one) |
| `DELETE servers/:id/agent` | `servers.manage` | Revoke the agent: its connection is closed at once and it cannot return |

A server:

```json
{ "id": "b8479b5b-…", "name": "Saturn", "hostname": "saturn.lan", "description": "compute",
  "agentId": "0ceb5584-…", "agentVersion": "1.0.0", "agentKeyFingerprint": "2df27bd2…",
  "capabilities": ["docker", "docker.engine", "storage"], "state": "ONLINE",
  "createdAt": "…", "updatedAt": "…", "lastSeenAt": "…" }
```

- `id` is the server id ([ADR-003](adr/ADR-003-server-identity.md)). Pass the output of
  `servermin-agent id` (first line) to describe a server before its agent registers; otherwise an
  id is generated.
- `name` is 1-64 characters and unique regardless of case.
- `state`, `agentVersion`, `capabilities` and `lastSeenAt` come from the agent's connection and
  cannot be set through the API. `capabilities` is what the agent last reported, also while it is
  offline.

| State | Meaning |
| --- | --- |
| `UNKNOWN` | No agent is enrolled for this server |
| `OFFLINE` | An agent is enrolled and not connected |
| `ONLINE` | Connected, heartbeats arriving, the agent reports itself healthy |
| `DEGRADED` | Connected, but the agent reports a problem (a failed module, for example) |
| `STALE` | Connected, but heartbeats have stopped; `OFFLINE` follows after the timeout |

The other states of the roadmap (`WAKING`, `UPDATING`, …) arrive with the features that cause them.
After a restart the Manager shows every server `OFFLINE` or `UNKNOWN` until its agent reconnects,
which takes a few seconds.
- Every change, and every refused change, is written to the audit log (`server.create`,
  `server.update`, `server.remove`).

Presets: Administrator (`*`), Operator (`servers.read`, `servers.manage`), Viewer (`servers.read`).

## Connecting an agent

Until registration codes exist (Phase 4), three steps by hand. The design is in
[ADR-002](adr/ADR-002-agent-outbound-connection.md).

1. **On the server**, print what the Manager needs. None of it is secret:

   ```bash
   sudo servermin-agent key --json
   ```

2. **On the Manager**, add the server and enrol the agent with that output:

   ```bash
   curl … -d '{"name":"Saturn","id":"<serverId>"}' https://manager:8480/api/v1/servers
   curl … -X PUT -d '{"agentId":"<agentId>","publicKey":"<publicKey>"}' https://manager:8480/api/v1/servers/<serverId>/agent
   ```

3. **On the server**, tell the agent where its Manager is, in `/etc/servermin/config.json`, and
   restart it (`sudo systemctl restart server-control`):

   ```json
   { "agent": { "manager": { "url": "https://manager:8480", "fingerprint": "D1:C7:B2:…" } } }
   ```

   `fingerprint` is the Manager's certificate fingerprint: printed by the installer, shown by
   `GET /api/v1/manager` (`tls.fingerprint`), or
   `openssl x509 -in /etc/servermin-manager/tls.crt -noout -fingerprint -sha256`. With a
   certificate from a CA use `"ca": "/path/to/ca.pem"` instead, or neither if it is publicly trusted.

`servermin-agent status` (after `serverctl login`) shows the connection, and the server turns
`ONLINE` in the inventory. The order of the steps does not matter: an agent that is not enrolled
yet keeps trying every 30 seconds, and the attempts are in the Manager's audit log.

To replace the certificate, install the new one, restart the Manager, and update `fingerprint` on
every agent; agents refuse a certificate they do not know, so do the agents first if you can
reach them only through the Manager.

## WebSocket

`/api/v1/ws`, the same protocol as the agent's (see [architecture.md](architecture.md#websocket-protocol)).
One channel so far:

| Channel | Permission | Data |
| --- | --- | --- |
| `inventory` | `servers.read` | `{ type: "inventory.server.created" \| "…updated" \| "…removed", server }` |

## Security

- **Its own account.** The agent's `servermin` account may run the privilege helper through sudo.
  The Manager runs as `servermin-manager`, which has no sudo rule, cannot read the agent's data or
  configuration, and whose program contains no code to start a process at all (a test checks the
  built file). A compromised Manager on a server is not root on that server.
- **Locked-down unit.** `NoNewPrivileges`, an empty capability set, a read-only file system except
  its state directory, no access to home directories or devices.
- **Its own session cookie** (`smm_session`). Browsers send cookies to every port of a host, so a
  Manager and an agent on one host would otherwise overwrite each other's session. Neither accepts
  the other's sessions.
- **Same request protections as the agent**: CSRF header and origin check, rate limiting, login
  lockout, hashed sessions and tokens, security headers.
- **TLS.** The installer sets it up. A Manager started without `http.tls` logs a warning, and
  agents refuse to connect to it unless told to accept that (`agent.manager.insecure`).
- **Agents prove who they are with a key that never leaves their server**, on a connection they
  open themselves. The Manager stores public keys only: its database cannot be used to
  impersonate an agent, and it holds nothing that works as a login on a server. The agent endpoint
  refuses browsers, rate-limits connections, and answers every failed authentication identically.
- **A reverse proxy that terminates TLS is not supported for agent connections yet**: agents bind
  their proof to the certificate they see, which would be the proxy's.

## Backup

Stop the service and copy `/var/lib/servermin-manager` and `/etc/servermin-manager`, or use
`sqlite3 manager.db ".backup …"` while it runs. Note that the updater's automatic database
snapshot covers the agent's database only; back up the Manager before updating it.

## Development

```bash
npm run build
SERVERMIN_MANAGER_DATA_DIR=$PWD/.dev/manager SERVERMIN_MANAGER_HOST=127.0.0.1 node packages/manager/dist/manager.js
```
