#!/bin/bash
# Installs (or upgrades) Server Control from an unpacked release directory.
#
#   sudo ./install.sh                 install or upgrade
#   sudo ./install.sh --port 8080     listen on another port (default 80)
#   sudo ./install.sh --uninstall     remove the program (keeps /var/lib/servermin and /etc/servermin)
#
# Layout (§48): program /opt/servermin · configuration /etc/servermin · data /var/lib/servermin
#               logs journald + /var/log/servermin · scratch /var/tmp/servermin
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
APP=/opt/servermin
PORT=""
UNINSTALL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "Unknown option $1" >&2; exit 1 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo ./install.sh)" >&2; exit 1; }

if [[ $UNINSTALL -eq 1 ]]; then
  systemctl disable --now server-control.service 2>/dev/null || true
  rm -f /etc/systemd/system/server-control.service /etc/sudoers.d/servermin /usr/local/bin/serverctl /usr/local/bin/servermin-verify
  rm -rf "$APP" /usr/lib/servermin
  systemctl daemon-reload
  echo "Removed. Data in /var/lib/servermin and configuration in /etc/servermin were kept."
  exit 0
fi

# ── Requirements ─────────────────────────────────────────────────────────────────
NODE=""
if [[ -x "$SRC/node/bin/node" ]]; then NODE="$SRC/node/bin/node"; elif command -v node >/dev/null; then NODE="$(command -v node)"; fi
if [[ -z "$NODE" ]] || ! "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  echo "Node.js 22.13 or newer is required (it provides the built-in SQLite driver)." >&2
  echo "Install it, for example:  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs" >&2
  echo "or use a release built with a bundled runtime: npm run package -- --bundle-node" >&2
  exit 1
fi
for cmd in sudo python3 tar; do command -v "$cmd" >/dev/null || { echo "Missing $cmd (apt-get install -y $cmd)" >&2; exit 1; }; done

# ── Service account ──────────────────────────────────────────────────────────────
if ! id servermin >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/servermin --create-home --shell /bin/bash --comment "Server Control" servermin
fi
for g in systemd-journal adm docker; do getent group "$g" >/dev/null && usermod -aG "$g" servermin; done
if getent group docker >/dev/null; then
  echo "Note: membership of the docker group gives the service account root-equivalent access to Docker."
fi

# ── Files ────────────────────────────────────────────────────────────────────────
systemctl stop server-control.service 2>/dev/null || true
rm -rf "$APP.new"
mkdir -p "$APP.new"
cp -a "$SRC/server" "$SRC/shell" "$SRC/modules" "$SRC/cli" "$SRC/bin" "$APP.new/"
[[ -d "$SRC/node" ]] && cp -a "$SRC/node" "$APP.new/"
cp -a "$SRC/README.md" "$SRC/VERSION" "$APP.new/" 2>/dev/null || true
rm -rf "$APP.old"
[[ -d "$APP" ]] && mv "$APP" "$APP.old"
mv "$APP.new" "$APP"
rm -rf "$APP.old"
chown -R root:root "$APP"
chmod -R go-w "$APP"

install -d -m 755 /usr/lib/servermin
install -m 755 -o root -g root "$SRC/deploy/servermin-privileged" /usr/lib/servermin/servermin-privileged
install -m 440 -o root -g root "$SRC/deploy/sudoers" /etc/sudoers.d/servermin.new
visudo -cf /etc/sudoers.d/servermin.new >/dev/null && mv /etc/sudoers.d/servermin.new /etc/sudoers.d/servermin

install -d -m 750 -o root -g servermin /etc/servermin
if [[ ! -f /etc/servermin/config.json ]]; then
  install -m 640 -o root -g servermin "$SRC/deploy/config.json" /etc/servermin/config.json
fi
if [[ -n "$PORT" ]]; then
  "$NODE" -e 'const f="/etc/servermin/config.json",fs=require("fs"),c=JSON.parse(fs.readFileSync(f));c.http.port=Number(process.argv[1]);fs.writeFileSync(f,JSON.stringify(c,null,2))' "$PORT"
fi
for d in /var/lib/servermin /var/log/servermin /var/tmp/servermin /var/lib/servermin/module-sources; do install -d -m 750 -o servermin -g servermin "$d"; done

ln -sf "$APP/bin/serverctl" /usr/local/bin/serverctl
ln -sf "$APP/bin/servermin-verify" /usr/local/bin/servermin-verify
install -m 644 "$SRC/deploy/server-control.service" /etc/systemd/system/server-control.service
systemctl daemon-reload
systemctl enable --now server-control.service

echo
echo "Server Control is running:  systemctl status server-control"
echo "Runtime: $([[ -x $APP/node/bin/node ]] && echo "bundled Node.js $($APP/node/bin/node --version)" || echo "system Node.js $($NODE --version)")"
echo "Check the installation:   sudo servermin-verify"
sleep 2
if [[ -f /var/lib/servermin/setup-token ]]; then
  echo "Open http://$(hostname -I | awk '{print $1}')${PORT:+:$PORT}/ and enter the setup token: $(cat /var/lib/servermin/setup-token)"
fi
