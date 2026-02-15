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
DELEGATE_JSON=$(curl -s -X POST "$BASE/api/cards/$CARD_ID/delegate" \
  -H "Content-Type: application/json" \
  -d '{"agentId":"researcher","taskDescription":"hi"}')
echo "$DELEGATE_JSON" | python3 -m json.tool
DELEGATION_ID=$(echo "$DELEGATE_JSON" | python3 -c 'import json,sys; data=json.load(sys.stdin); print((data.get("delegation") or {}).get("id") or ((data.get("spawn") or {}).get("delegation") or {}).get("id") or "")')
if [[ -n "$DELEGATION_ID" ]]; then
  echo "DELEGATION_ID=$DELEGATION_ID"
  echo "Resume:"
  curl -s -X POST "$BASE/api/delegations/$DELEGATION_ID/resume" \
    -H "Content-Type: application/json" \
    -d '{"message":"resume ping"}' | python3 -m json.tool
else
  echo "No DELEGATION_ID found in delegate response; skipping resume step"
fi

echo "Transcript:"
curl -s "$BASE/api/cards/$CARD_ID/transcript" | python3 -m json.tool
