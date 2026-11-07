#!/usr/bin/env bash
# Rebuilds the vendored ENTERPRISE-UI package from a checkout of
# https://github.com/iant89/ENTERPRISE-UI (default: ../ENTERPRISE-UI) and reinstalls it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EUI="${1:-$ROOT/../ENTERPRISE-UI}"
[[ -f "$EUI/package.json" ]] || { echo "ENTERPRISE-UI checkout not found at $EUI" >&2; exit 1; }
(cd "$EUI" && npm ci && npm run build:lib && npm pack --pack-destination "$ROOT/vendor")
cd "$ROOT"
TGZ="$(ls -t vendor/enterprise-ui-react-*.tgz | head -1)"
echo "Using $TGZ"
npm pkg set "dependencies.@enterprise-ui/react=file:$TGZ"
npm install
