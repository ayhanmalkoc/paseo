#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export PATH="$REPO_ROOT/node_modules/.bin:$PATH"

TAILNET_HOST="${PASEO_TAILNET_HOST:-vmi3276356.tail0fe4ed.ts.net}"
TAILNET_IP="${PASEO_TAILNET_IP:-}"
DAEMON_PORT="${PASEO_TAILNET_DAEMON_PORT:-7777}"
WEB_PORT="${PASEO_TAILNET_WEB_PORT:-8081}"

if [ -z "$TAILNET_IP" ] && command -v tailscale >/dev/null 2>&1; then
  TAILNET_IP="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
fi
TAILNET_IP="${TAILNET_IP:-$TAILNET_HOST}"

export PASEO_HOME="${PASEO_HOME:-$HOME/.paseo-tailnet-main}"
export PASEO_LOCAL_MODELS_DIR="${PASEO_LOCAL_MODELS_DIR:-$HOME/.paseo/models/local-speech}"
export PASEO_CORS_ORIGINS="${PASEO_CORS_ORIGINS:-*}"
export PASEO_RELAY_ENABLED="${PASEO_RELAY_ENABLED:-0}"
export PASEO_NODE_INSPECT="${PASEO_NODE_INSPECT:---inspect=0}"
export BROWSER="${BROWSER:-none}"
export APP_VARIANT="${APP_VARIANT:-development}"
export EXPO_PUBLIC_LOCAL_DAEMON="${EXPO_PUBLIC_LOCAL_DAEMON:-$TAILNET_IP:$DAEMON_PORT}"

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
echo "  Web:       http://$TAILNET_HOST:$WEB_PORT/"
echo "  Web IP:    http://$TAILNET_IP:$WEB_PORT/"
echo "  Daemon:    $TAILNET_IP:$DAEMON_PORT"
echo "  Listen:    0.0.0.0:$DAEMON_PORT"
echo "  Home:      $PASEO_HOME"
echo "  Models:    $PASEO_LOCAL_MODELS_DIR"
echo "  Portless:  disabled"
echo "  Serve:     disabled"
echo "══════════════════════════════════════════════════════"

npm run build:server-deps

(
  export PASEO_LISTEN="0.0.0.0:$DAEMON_PORT"
  exec npm run dev:server:raw -- --no-relay
) &
DAEMON_PID=$!

(
  cd packages/app
  exec npx expo start --web --port "$WEB_PORT" --host lan --clear
) &
WEB_PID=$!

wait -n "$DAEMON_PID" "$WEB_PID"
