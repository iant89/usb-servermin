# Operations

## Locations (§48)

| What | Where |
| --- | --- |
| Program | `/opt/servermin` (`server/`, `shell/`, `modules/` bundled set, `cli/`, `bin/`, optional `node/`) |
| Configuration | `/etc/servermin/config.json`, `/etc/servermin/privileged.conf` (optional) |
| Data | `/var/lib/servermin` (`core.db`, `module-data/<id>/`, installed `modules/`) |
| Logs | journald (`journalctl -u server-control`), the platform database (Logs module), and optionally `/var/log/servermin/servermin.log` (`logging.file: true`) |
| Scratch | `/var/tmp/servermin` |
| Privilege helper | `/usr/lib/servermin/servermin-privileged`, `/etc/sudoers.d/servermin` |
| Service | `/etc/systemd/system/server-control.service` |

Program files and data are separate, so the program can live on the USB stick while data moves to
another disk: change `paths.data` and `paths.modules` in the configuration. If data lives on a
separate mount, add it to `RequiresMountsFor=` in the unit.

## Configuration

`/etc/servermin/config.json` (environment overrides: `SERVERMIN_CONFIG`, `SERVERMIN_DATA_DIR`,
`SERVERMIN_PORT`, `SERVERMIN_HOST`, `SERVERMIN_PRIVILEGED_MODE`, `SERVERMIN_LOG_LEVEL`):

```json
{
  "http": { "host": "0.0.0.0", "port": 80, "tls": { "cert": "/etc/servermin/tls.crt", "key": "/etc/servermin/tls.key" } },
  "modules": { "preinstall": ["/opt/servermin/modules"], "sources": ["/opt/servermin/modules"], "maxMemoryMb": 512 },
  "privileged": { "mode": "sudo" },
  "logging": { "level": "INFO", "retentionDays": 14 },
  "auth": { "sessionHours": 12, "loginAttempts": 5, "lockoutMinutes": 15 }
}
```

`privileged.mode`: `sudo` (production), `simulate` (log instead of executing; development), or
`disabled`. The server name and log level can also be changed at runtime in Settings.

## Portable USB installations (§38)

- Nothing is tied to the hardware: interfaces, disks, CPUs and GPUs are discovered on every start and
  nothing refers to `eth0`, `sda` or a MAC address. The Storage module marks the disk that holds `/`
  as the system disk so it is never offered for mounting.
- Bundle Node.js in the release (`npm run package -- --bundle-node`) so the stick does not depend on
  the host's packages. The launchers in `/opt/servermin/bin` prefer `/opt/servermin/node/bin/node`.
- After moving the stick, run `sudo servermin-verify` and follow [the hardware checklist](hardware-checklist.md).
- Network settings managed by Server Control are stored per interface name. On another machine the
  names may differ; interfaces it does not manage keep the distribution's default (usually DHCP), so
  the server stays reachable.
- systemd restarts the service on failure (`Restart=on-failure`) and starts it after
  `network-online.target` once the data paths are mounted.

## Slow storage (USB flash drives)

Cheap USB flash drives, especially on USB 2.0, can take tens to hundreds of milliseconds for each
small write that must reach the disk; a database makes many of them. Server Control keeps all of
that on a separate storage thread, so the web interface stays responsive, but saving data, starting
modules and Docker will still be slow on such a drive. `sudo servermin-verify` measures it
("Disk speed") and warns below about 100 synced writes per second.

What helps, in order:

1. Run the installation from a USB 3 SSD (an M.2 or SATA SSD in a USB enclosure). It is just as
   portable and typically a hundred times faster at this kind of write.
2. Put the data directory on a faster disk of the machine: set `paths.data` and `paths.modules` in
   `/etc/servermin/config.json` (and add the mount to `RequiresMountsFor=` in the unit). This trades
   portability for speed: the data then stays with that machine.
3. Keep the extra log file off (`logging.file`, off by default); journald and the database already
   keep the logs.

## Backups (§49)

Back up `/etc/servermin` and `/var/lib/servermin` (stop the service, or use `sqlite3 core.db ".backup"`).
That covers core configuration, users, module settings, installed module manifests and code, the audit
log, and module data such as application and deployment definitions. A backup module can automate this.

## Upgrades

- Core: Settings → Updates installs signed releases from GitHub, with a database backup and automatic
  rollback (see [releases.md](releases.md)). Manual alternative: unpack a new release and run
  `sudo ./install.sh`; data and configuration are kept and the previous version is kept as
  `/opt/servermin.previous`.
- Modules: Module Manager → module → Update, or `serverctl module update <id> <package.tgz>`. If the new
  version fails to start, the previous version is restored automatically. Modules are versioned
  independently of the core.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Module in `ERROR` | Modules → module → Logs; fix, then Reload |
| Module `BLOCKED` | Its dependencies are listed; enable or install them |
| Docker module health `ERROR` | `systemctl status docker`; is `servermin` in the `docker` group? (`id servermin`) |
| Privileged actions fail with "sudo: a password is required" | `/etc/sudoers.d/servermin` missing or invalid: `visudo -cf /etc/sudoers.d/servermin` |
| Journal logs are incomplete | `servermin` must be in `systemd-journal` (the installer adds it) |
| Lost the admin password | Stop the service, remove all users with `sqlite3 /var/lib/servermin/core.db "DELETE FROM users"`, restart, and use the new setup token from the journal |
