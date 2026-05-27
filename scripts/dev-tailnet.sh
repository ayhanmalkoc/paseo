#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export PATH="$REPO_ROOT/node_modules/.bin:$PATH"

TAILNET_HOST="${PASEO_TAILNET_HOST:-vmi3276356.tail0fe4ed.ts.net}"
DAEMON_PORT="${PASEO_TAILNET_DAEMON_PORT:-7777}"
WEB_PORT="${PASEO_TAILNET_WEB_PORT:-8081}"
export PASEO_HOME="${PASEO_HOME:-$HOME/.paseo-tailnet-main}"
export PASEO_LOCAL_MODELS_DIR="${PASEO_LOCAL_MODELS_DIR:-$HOME/.paseo/models/local-speech}"
export PASEO_CORS_ORIGINS="${PASEO_CORS_ORIGINS:-*}"
export PASEO_RELAY_ENABLED="${PASEO_RELAY_ENABLED:-0}"
export PASEO_NODE_INSPECT="${PASEO_NODE_INSPECT:---inspect=0}"
export BROWSER="${BROWSER:-none}"
export APP_VARIANT="${APP_VARIANT:-development}"
export EXPO_PUBLIC_LOCAL_DAEMON="${EXPO_PUBLIC_LOCAL_DAEMON:-$TAILNET_HOST:$DAEMON_PORT}"

mkdir -p "$PASEO_HOME" "$PASEO_LOCAL_MODELS_DIR"

cleanup() {
  if [ -n "${DAEMON_PID:-}" ]; then kill "$DAEMON_PID" 2>/dev/null || true; fi
  if [ -n "${WEB_PID:-}" ]; then kill "$WEB_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

cd "$REPO_ROOT"

echo "══════════════════════════════════════════════════════"
echo "  Paseo Tailnet Dev"
echo "══════════════════════════════════════════════════════"
echo "  Web:     https://$TAILNET_HOST/"
echo "  Daemon:  https://$TAILNET_HOST:$DAEMON_PORT/"
echo "  Listen:  127.0.0.1:$DAEMON_PORT"
echo "  Home:    $PASEO_HOME"
echo "  Models:  $PASEO_LOCAL_MODELS_DIR"
echo "══════════════════════════════════════════════════════"

if command -v tailscale >/dev/null 2>&1; then
  tailscale serve --bg --https="$DAEMON_PORT" "http://127.0.0.1:$DAEMON_PORT" >/dev/null || true
  tailscale serve --bg --https=443 "http://127.0.0.1:$WEB_PORT" >/dev/null || true
fi

(
  export PASEO_LISTEN="127.0.0.1:$DAEMON_PORT"
  exec npm run dev:server -- --no-relay
) &
DAEMON_PID=$!

(
  cd packages/app
  exec npx expo start --web --port "$WEB_PORT"
) &
WEB_PID=$!

wait -n "$DAEMON_PID" "$WEB_PID"
