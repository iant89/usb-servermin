# Real-hardware checklist

Use this the first time Server Control runs on a real machine, and whenever the USB stick moves to
a new computer. `servermin-verify` does most of the work; the rest needs a person.

Record the results (the `--json` reports are easy to compare between machines).

## 0. Build the release

On a build machine:

```bash
npm ci
npm run package -- --bundle-node --arch x64          # add ,arm64 for ARM boards
```

This produces `release/servermin-<version>-linux-x64.tar.gz` with the Node.js runtime included
(downloaded from nodejs.org and checked against its published SHA-256). The server then needs no
Node.js of its own.

## 1. Install (machine A)

Ubuntu Server 22.04 or 24.04 on the USB stick, booted, connected to the network.

```bash
tar xzf servermin-1.0.0-linux-x64.tar.gz && cd servermin-1.0.0-linux-x64
sudo ./install.sh
```

- [ ] The installer ends with "Server Control is running" and prints the address and setup token.
- [ ] `Runtime:` says **bundled Node.js**.
- [ ] Open the address in a browser, enter the setup token, create the administrator.
- [ ] The dashboard shows host metrics and widgets for System, Monitoring, Docker, Storage, Network, Services and Applications.

## 2. Automatic checks (machine A)

```bash
sudo servermin-verify --user admin --json /root/verify-A.json
```

- [ ] No `FAIL`. Read every `WARN`: each one says what is missing (for example Docker not installed).
- [ ] *Privilege helper and sudoers rule* passes: the service account reaches the helper without a password and has no other root access.
- [ ] *Terminal* reports the shell runs as `servermin`, not root.
- [ ] *Storage* names the USB stick as the system disk.

Then the opt-in checks. Each one changes the system briefly and cleans up:

```bash
sudo apt-get install -y docker.io && sudo systemctl restart server-control   # if Docker is wanted
sudo servermin-verify --user admin --docker --service cron.service --updates
sudo servermin-verify --user admin --mount /dev/sdb1          # a spare partition, not the stick
sudo servermin-verify --user admin --network-rollback --i-have-console-access
```

- [ ] `--docker`: a test application is deployed, answers, and is removed.
- [ ] `--mount`: the partition is mounted read-only with `nosuid,nodev` and unmounted.
- [ ] `--network-rollback`: run this **with a keyboard and screen attached**. The change rolls back
      on its own after 30 seconds and the server stays reachable.

## 3. By hand (machine A)

- [ ] **Reboot** from System → Power. The server comes back, Server Control starts on its own, and
      `sudo servermin-verify` passes again.
- [ ] **Network change you keep**: Network → Configure the wired interface → Apply → *Keep this
      configuration* within the countdown. The pending banner disappears and stays gone after a reboot.
- [ ] **Network change you lose**: give the interface a wrong static address and do not confirm.
      Within the rollback time the old address returns and the page reconnects.
- [ ] **Unplug the network cable** for 30 seconds. The header shows *Offline* then *Online*; a
      `network.interface.changed` event appears in Logs → Platform and modules.
- [ ] **Stop Docker** (`sudo systemctl stop docker`). Docker shows *Docker Engine unavailable*,
      everything else keeps working, the dashboard health turns *Degraded*. Start it again and the
      Docker page recovers without reloading the module.
- [ ] **Module failure**: Modules → Docker → Disable, then Enable. Navigation and widgets disappear
      and return.
- [ ] **Phone**: open the address on a phone. The navigation is a drawer; the dashboard and the
      Services list are usable.
- [ ] **Audit log** (Settings → Audit log) lists the logins, the reboot, the network changes and the
      module actions from these steps.

## 4. Move the stick (machine B, different hardware)

Shut down machine A, move the USB stick to a different computer (another vendor, network chip or
disk controller if possible), and boot.

- [ ] The server boots and Server Control starts without any change.
- [ ] `sudo servermin-verify --user admin --json /root/verify-B.json` has no `FAIL`.
- [ ] Compare the reports: `hardware`, `disks` and `network` describe machine B, not A
      (`diff <(jq .hardware /root/verify-A.json) <(jq .hardware /root/verify-B.json)`).
- [ ] The interface name may differ (for example `enp3s0` → `eno1`). If you configured a static
      address on machine A, that interface does not exist here; the new one uses DHCP and the
      server is reachable. The Network page shows the new name.
- [ ] Storage still marks the stick as the system disk, even though its device name may have changed.

## If something fails

- `journalctl -u server-control -b` for the core.
- Modules → *module* → Logs for a module.
- `sudo -u servermin sudo -n /usr/lib/servermin/servermin-privileged bogus` must print
  `unknown operation`; anything about a password means the sudoers rule is not installed.
- Report issues with the `--json` report attached.
