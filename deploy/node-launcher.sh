# Sourced by the launchers in /opt/servermin/bin. Picks the bundled Node.js runtime
# (portable installs) or the system one, and checks it is new enough (22.13+ for node:sqlite).
APP="${SERVERMIN_APP:-/opt/servermin}"
if [ -x "$APP/node/bin/node" ]; then NODE="$APP/node/bin/node"; else NODE="$(command -v node || true)"; fi
if [ -z "$NODE" ]; then
  echo "Node.js 22.13 or newer is required. Reinstall a release built with --bundle-node, or install Node.js." >&2
  exit 1
fi
if ! "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  echo "$NODE is $("$NODE" --version); Node.js 22.13 or newer is required." >&2
  exit 1
fi
