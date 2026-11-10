# Security model

Server Control is a privileged administration interface. These are the mechanisms behind §20.

## Authentication

- First run: no account exists. Creating the administrator needs the setup token written to
  `/var/lib/servermin/setup-token` (mode 600) and printed to the journal, so someone on the network
  cannot claim a fresh installation. The token is deleted after use.
- Passwords: scrypt (N=16384, r=8, p=1), at least 10 characters mixing letters with digits or symbols.
- Sessions: 256-bit random token in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` with TLS). Only a
  SHA-256 hash is stored. Sliding expiry (`auth.sessionHours`), capped at 7 days. Changing a password,
  disabling or deleting a user revokes sessions and closes their WebSockets.
- API tokens (`smt_…`) for the CLI: stored hashed, optional expiry, revocable, shown once.
- Login lockout after `auth.loginAttempts` failures per IP and user, for `auth.lockoutMinutes`. A failed
  login takes the same time whether or not the user exists.

## Agent identity

The server id and agent id ([ADR-003](adr/ADR-003-server-identity.md)) are identifiers, not
credentials: every signed-in user can read them at `/api/v1/agent`, and nothing accepts them as
proof of identity. The identity file is mode 0600 so that only the service account can *change*
which server this is. The public health endpoint does not reveal them.

## Authorization

- Users hold permissions directly (presets: Administrator `*`, Operator, Viewer). Wildcards: `docker.*`.
- Every core route and every module route and channel declares a permission; the core checks it
  before the module sees the request. A module can only require permissions it declared.

## Requests

- CSRF: state-changing requests with a session must carry `X-Servermin-Request: 1` (a custom header that
  cross-site forms cannot send) and, when present, an `Origin` matching the host. WebSocket upgrades with a
  session must be same-origin.
- Rate limiting: token bucket per client IP on the API (burst 300, 30/s); WebSocket message rate and
  subscription count limits.
- Input validation in every route; JSON bodies limited to 1 MB (5 MB for module routes), uploads to 200 MB.
- Security headers: CSP (`script-src 'self'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`.
- Module routes cannot set arbitrary response headers (only content type, disposition, cache control and `x-*`).

## Process execution and the privilege boundary

- The core runs as `servermin` with only `CAP_NET_BIND_SERVICE` (to listen on port 80).
- Modules run executables only through `ctx.process`, only if declared in `host.commands`, without a
  shell (arguments are an array), with a sanitised environment (`LD_*`, `NODE_OPTIONS`, … removed),
  bounded output, timeouts and cancellation. All runs are logged.
- Root actions are a fixed catalogue (`packages/sdk/src/privileged.ts`). A module must declare the ones
  it uses; arguments are validated by the core, destructive ones need explicit confirmation, and every
  attempt is audited. The core then runs `sudo -n /usr/lib/servermin/servermin-privileged <op> key=value…`.
- The helper (`deploy/servermin-privileged`) is the actual boundary: root-owned, it re-validates every
  argument, accepts only known keys, refuses to stop Server Control itself, restricts mounts to `/mnt`,
  `/media` and `/srv` with `nosuid,nodev`, refuses to unmount system paths, and only applies the
  network module's staged netplan file.
- The sudoers rule allows exactly that helper and nothing else.
- There is no endpoint that executes arbitrary shell commands. The Terminal module is the one
  intentional exception: it needs the `terminal.access` permission, runs the shell as the unprivileged
  service account, and every session is audited.

## Updates

Updates are the one path by which new root-executed code reaches a server, so they are checked twice:

- The core installs nothing whose `release.json` does not verify with the Ed25519 public key shipped in
  the installed release (`/opt/servermin/release-signing.pub`, root-owned). Archives must match the
  SHA-256 and size in that signed manifest. The private key exists only as a GitHub Actions secret.
- `platform.update` accepts only file names under `/var/tmp/servermin/updates`; the helper copies them
  into a root-only directory before anything reads them, so the service account cannot swap them after
  verification. The root updater then repeats the signature, version (no downgrades) and checksum checks
  with its own code and key, and refuses archives that contain links or special files.
- Which repository releases come from is set only in `/etc/servermin/config.json`, not through the API.
- The `platform.update` permission (admins by default) is required to check, install or roll back.

## Things to know

- **Docker group**: the installer adds `servermin` to the `docker` group when it exists. Docker access is
  root-equivalent; grant `docker.*` permissions only to trusted administrators.
- **Modules are trusted code.** Worker threads isolate failures, not malicious code. Install modules
  from sources you trust; integrity checks prove a package was not modified, not that it is safe.
- **TLS**: set `http.tls.cert` and `http.tls.key` in `/etc/servermin/config.json`, or put a reverse proxy
  in front (set `http.trustProxy: true` only then). Without TLS, use it on a trusted network.
- **Audit log**: logins, user changes, every module lifecycle operation and setting change, privileged
  operations, and module actions that declare `audit` (container start/stop, service restarts, mounts,
  network changes, deployments, terminal sessions). Export it as CSV from Settings → Audit log.
