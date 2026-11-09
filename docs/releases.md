# Releases and updates

Installed servers update themselves from signed GitHub releases: no rebuilding, no copying archives
by hand. This page covers publishing a release (maintainers) and how servers install it.

## One-time setup: the signing key

Releases are signed with an Ed25519 key. Servers only install a release whose `release.json` is
signed by the key they were installed with, so a compromised download host, mirror or GitHub account
token without the key cannot push code to them.

```bash
npm run release:keygen
```

This writes the **public** key to `deploy/release-signing.pub` and prints the **private** key once.
It never writes the private key to disk.

1. Add the private key as a repository secret named `RELEASE_SIGNING_KEY`
   (GitHub → Settings → Secrets and variables → Actions → New repository secret). Paste the whole
   PEM block, including the `BEGIN`/`END` lines.
2. Keep an offline copy (a password manager). Without it you cannot publish updates that existing
   servers accept.
3. Commit `deploy/release-signing.pub`.

Servers installed from a build **without** the public key cannot update themselves; install the first
signed release on them once with `install.sh`. From then on they update from the web interface.

To replace the key, every server needs a release that carries the new public key, signed with the
old one: run `npm run release:keygen -- --force`, publish one release with the old secret still in
place, then switch the secret.

## Publishing a release

```bash
npm run set-version -- 1.1.0      # package.json and packages/core/src/version.ts
git commit -am "Release 1.1.0"
git tag v1.1.0
git push origin main v1.1.0
```

The `Release` workflow (`.github/workflows/release.yml`) checks that the tag matches the version, runs
the type check and tests, builds `x64` and `arm64` archives with Node.js bundled, writes and signs
`release.json`, and creates the GitHub release with:

| Asset | Contents |
| --- | --- |
| `servermin-<v>-linux-<arch>.tar.gz` (+ `.sha256`) | The full release, as for a manual install |
| `<module>-<v>.tgz` | Each module as an installable package |
| `release.json` | Version, and the SHA-256 and size of every archive and module package |
| `release.json.sig` | Ed25519 signature over `release.json` |

Version numbers must increase: servers never install an older or equal version (use rollback for that).

## How a server updates

1. **Check** — daily (`updates.checkIntervalHours`), or *Check now* in Settings → Updates, or
   `serverctl update check`. The core asks the GitHub API for the latest release, downloads
   `release.json` and its signature, and verifies the signature with `/opt/servermin/release-signing.pub`.
   A newer version produces one notification.
2. **Download** — on *Install* (or automatically, see below) the core downloads the archive for the
   server's architecture to `/var/tmp/servermin/updates` and checks its size and SHA-256 against the
   signed manifest.
3. **Hand over** — the core asks the privilege helper for `platform.update`. The helper copies the three
   files into a root-only directory and starts `/opt/servermin/bin/servermin-update` as its own
   transient systemd unit (`servermin-update.service`), so stopping Server Control does not stop the update.
4. **Install** — the root updater checks the signature, version and checksum **again** (it does not
   trust the core), unpacks the archive (rejecting links and special files), stops the service, copies
   `core.db` aside, and runs the new release's `install.sh`. The old installation is kept as
   `/opt/servermin.previous`.
5. **Confirm** — it waits up to three minutes for `/api/v1/health` to report the new version.
6. **Roll back on failure** — if the new version does not come up, it restores `/opt/servermin.previous`,
   the privilege helper, the unit file and the database copy, and starts the previous version.

The outcome is written to `/var/lib/servermin/update-status.json`; the core reports it as a
notification and in the audit log when it starts. The updater's own log is
`/var/lib/servermin-helper/update/update.log`; `journalctl -u servermin-update` shows the same.

Bundled modules that are newer in the new release are updated after the restart through the normal
module pipeline (integrity check, migration, rollback on failure).

### Module updates

Settings → Updates lists modules for which the latest release has a newer package. Updating a module
does not restart the server; the module manager installs the verified package and restores the
previous version if the new one fails to start. A module that needs a newer core is shown but not offered.

### Automatic installation

Off by default. When on (Settings → Updates, or `serverctl update auto on --window 03:00`) a newer
release is installed — modules first, then the core — during the hour that starts at the window time
(server local time). Each version is attempted once automatically: a release that rolls back is not
retried every night. Failures are reported as notifications.

### Rolling back by hand

Settings → Updates → *Roll back*, or `serverctl update rollback`. This reinstalls `/opt/servermin.previous`
and restores the database copy taken before the last update; changes made since then are lost.

### Configuration

In `/etc/servermin/config.json` (not changeable from the web interface, on purpose):

```json
"updates": {
  "enabled": true,
  "repository": "iant89/usb-servermin",
  "apiBase": "https://api.github.com",
  "checkIntervalHours": 24
}
```

Set `enabled` to `false` on servers that must only change through manual installs. The server needs
outbound HTTPS to `api.github.com`, `github.com` and `objects.githubusercontent.com`.
