# Servermin Manager

The Manager is the central service of Servermin: one place that knows every server. It is a
separate process from the agent (`server-control.service`), built from the same libraries
([ADR-001](adr/ADR-001-manager-agent-architecture.md)).

**What exists today (Phase 2):** accounts, a persistent server inventory, a REST API and a
WebSocket endpoint. **What does not exist yet:** agents cannot connect to it (Phase 3) or register
(Phase 4), so every server is in state `UNKNOWN`, and there is no web interface (Phase 8); it is
driven through the API.

## Install

The Manager ships in the same release as the agent. On the server that should run it:

```bash
sudo ./install.sh --manager
```

This creates the `servermin-manager` account, `/etc/servermin-manager`, `/var/lib/servermin-manager`,
and enables `servermin-manager.service`. It prints the address and the one-time setup token (also in
the journal and in `/var/lib/servermin-manager/setup-token`). Later updates of the release keep a
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
  "auth": { "sessionHours": 12, "loginAttempts": 5, "lockoutMinutes": 15 }
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
curl -c cookies -H 'X-Servermin-Request: 1' -H 'Content-Type: application/json' \
  -d "{\"setupToken\":\"$TOKEN\",\"username\":\"admin\",\"password\":\"a long password 1\"}" \
  http://manager:8480/api/v1/auth/setup
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
| `DELETE servers/:id` | `servers.manage` | |

A server:

```json
{ "id": "b8479b5b-…", "name": "Saturn", "hostname": "saturn.lan", "description": "compute",
  "agentId": null, "agentVersion": null, "state": "UNKNOWN",
  "createdAt": "…", "updatedAt": "…", "lastSeenAt": null }
```

- `id` is the server id ([ADR-003](adr/ADR-003-server-identity.md)). Pass the output of
  `servermin-agent id` (first line) to describe a server before its agent registers; otherwise an
  id is generated.
- `name` is 1-64 characters and unique regardless of case.
- `state`, `agentId`, `agentVersion` and `lastSeenAt` are derived from what an agent reports. They
  cannot be set through the API.
- Every change, and every refused change, is written to the audit log (`server.create`,
  `server.update`, `server.remove`).

Presets: Administrator (`*`), Operator (`servers.read`, `servers.manage`), Viewer (`servers.read`).

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
- **TLS.** Without `http.tls` (or a reverse proxy) passwords and sessions cross the network in
  clear text. Use it on a trusted network only until TLS is configured; agent connections
  (Phase 3) will require TLS.

## Backup

Stop the service and copy `/var/lib/servermin-manager` and `/etc/servermin-manager`, or use
`sqlite3 manager.db ".backup …"` while it runs. Note that the updater's automatic database
snapshot covers the agent's database only; back up the Manager before updating it.

## Development

```bash
npm run build
SERVERMIN_MANAGER_DATA_DIR=$PWD/.dev/manager SERVERMIN_MANAGER_HOST=127.0.0.1 node packages/manager/dist/manager.js
```
