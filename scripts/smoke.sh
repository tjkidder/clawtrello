#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:3000}"

echo "Health:"
curl -s "$BASE/health" | python3 -m json.tool

echo "API OpenClaw health:"
curl -s "$BASE/api/openclaw/health" | python3 -m json.tool

echo "Agents:"
curl -s "$BASE/api/agents" | python3 -m json.tool

echo "Create card:"
CARD_JSON=$(curl -s -X POST "$BASE/api/cards" \
  -H "Content-Type: application/json" \
  -d '{"title":"smoke test","description":"test","dueAt":null}')
echo "$CARD_JSON" | python3 -m json.tool
CARD_ID=$(echo "$CARD_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "CARD_ID=$CARD_ID"

echo "Delegate:"
curl -s -X POST "$BASE/api/cards/$CARD_ID/delegate" \
  -H "Content-Type: application/json" \
  -d '{"agentId":"researcher","taskDescription":"hi"}' | python3 -m json.tool

echo "Transcript:"
curl -s "$BASE/api/cards/$CARD_ID/transcript" | python3 -m json.tool
