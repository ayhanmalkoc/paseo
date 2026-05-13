#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

COMMAND="${1:-}"
BRANCH="${PASEO_DEV_BRANCH:-test}"
WEB_PORT="${PASEO_WEB_PORT:-8081}"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/dev-test.sh daemon
  ./scripts/dev-test.sh web

Environment:
  PASEO_DEV_BRANCH   Branch to switch/pull before starting. Default: test
  PASEO_HOME         Dev daemon home. Default: $HOME/paseo-dev-local
  PASEO_WEB_PORT     Expo web port. Default: 8081
EOF
}

sync_branch() {
  cd "$REPO_ROOT"
  git switch "$BRANCH"
  git pull --ff-only origin "$BRANCH"
}

resolve_tailnet_host() {
  tailscale status --json | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  const j = JSON.parse(s);
  console.log((j.Self.DNSName || "").replace(/\.$/, ""));
});
'
}

run_daemon() {
  sync_branch

  local ts_host
  ts_host="$(resolve_tailnet_host)"
  if [ -z "$ts_host" ]; then
    echo "Could not resolve Tailscale DNS name." >&2
    exit 1
  fi

  export PASEO_HOME="${PASEO_HOME:-$HOME/paseo-dev-local}"
  export PASEO_LISTEN="${PASEO_LISTEN:-127.0.0.1:7777}"
  export PASEO_CORS_ORIGINS="${PASEO_CORS_ORIGINS:-https://$ts_host,https://$ts_host:7777}"
  export PASEO_HOSTNAMES="${PASEO_HOSTNAMES:-$ts_host}"

  echo "Branch:  $BRANCH"
  echo "TS_HOST: $ts_host"
  echo "Home:    $PASEO_HOME"
  echo "Listen:  $PASEO_LISTEN"

  exec "$REPO_ROOT/scripts/dev-daemon.sh"
}

run_web() {
  sync_branch

  fuser -k "${WEB_PORT}/tcp" 2>/dev/null || true

  cd "$REPO_ROOT/packages/app"
  export APP_VARIANT="${APP_VARIANT:-development}"
  export BROWSER="${BROWSER:-none}"

  echo "Branch: $BRANCH"
  echo "Web:    http://localhost:$WEB_PORT"

  exec npx expo start --web --host localhost --port "$WEB_PORT" --clear
}

case "$COMMAND" in
  daemon)
    run_daemon
    ;;
  web)
    run_web
    ;;
  -h|--help|help|"")
    usage
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
