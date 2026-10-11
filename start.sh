#!/usr/bin/env bash
# Builds the UI, starts the local server (127.0.0.1:8795, or PORT from the environment) and opens it in the system browser (skip with --no-open).
set -euo pipefail
cd "$(dirname "$0")"
ENV_PORT="$(grep -E '^PORT=[0-9]+$' .env 2>/dev/null | cut -d= -f2 || true)"
URL="http://127.0.0.1:${PORT:-${ENV_PORT:-8795}}"
mkdir -p .run

# The server runs in its own process group (setsid), so npm/tsx/node children stop together.
if [ -f .run/server.pid ] && kill -0 "$(cat .run/server.pid)" 2>/dev/null; then
  kill -- "-$(cat .run/server.pid)" 2>/dev/null || true
  for _ in $(seq 1 25); do kill -0 "$(cat .run/server.pid)" 2>/dev/null || break; sleep 0.2; done
fi

npm run build --silent >/dev/null
setsid nohup npm start --silent > .run/server.log 2>&1 < /dev/null &
echo $! > .run/server.pid

for _ in $(seq 1 50); do
  curl -fsS -o /dev/null "$URL/api/overview" 2>/dev/null && break
  sleep 0.2
done

if [ "${1:-}" != "--no-open" ] && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  env -u BROWSER xdg-open "$URL" >/dev/null 2>&1 &
fi
echo "running: $URL (log: .run/server.log)"
