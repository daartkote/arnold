#!/bin/sh
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
DEMO="${PROJECT_DIR:-$(grep '^PROJECT_DIR=' .env | cut -d= -f2-)}"
LOG=/tmp

pkill -f 'tsx.*server/src/index.ts' 2>/dev/null || true
pkill -f 'vite' 2>/dev/null || true
pkill -f 'cloudflared tunnel' 2>/dev/null || true
sleep 1

echo "server…";   (nohup npx tsx --env-file=.env server/src/index.ts > $LOG/vc-server.log 2>&1 &)
echo "web…";      (cd web && nohup npx vite > $LOG/vc-web.log 2>&1 &)
echo "demo app…"; (cd "$DEMO" && nohup npx vite --port 5174 --strictPort > $LOG/vc-demo.log 2>&1 &)
echo "tunnel…";   (nohup cloudflared tunnel --url http://localhost:3000 > $LOG/vc-tunnel.log 2>&1 &)

until grep -qo 'https://[a-z0-9-]*\.trycloudflare\.com' $LOG/vc-tunnel.log; do sleep 1; done
until curl -s -o /dev/null localhost:3000/api/state; do sleep 1; done
sleep 3
URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' $LOG/vc-tunnel.log | head -1)
"$ROOT/scripts/set-agent-url.sh" "$URL" >/dev/null && echo "ElevenLabs agent → $URL/v1"

echo
echo "Arnold     http://localhost:5173"
echo "TaskFlow   http://localhost:5174"
echo "Server     http://localhost:3000"
echo "Logs       $LOG/vc-*.log"
