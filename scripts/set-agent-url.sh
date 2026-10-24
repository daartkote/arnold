#!/bin/sh
set -e
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
URL=${1:-$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/vc-tunnel.log | head -1)}
curl -s -X PATCH -H "xi-api-key: $ELEVENLABS_API_KEY" -H 'Content-Type: application/json' \
  "https://api.elevenlabs.io/v1/convai/agents/$ELEVENLABS_AGENT_ID" \
  -d "{\"conversation_config\":{\"agent\":{\"prompt\":{\"llm\":\"custom-llm\",\"custom_llm\":{\"url\":\"$URL/v1\",\"model_id\":\"gemma\",\"request_headers\":{\"x-voicecode-secret\":\"$CUSTOM_LLM_SECRET\"}}}}}}" \
  | grep -o '"url":"[^"]*"'
