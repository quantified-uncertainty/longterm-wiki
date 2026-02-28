#!/usr/bin/env bash
#
# Throttled heartbeat — runs after tool calls but only sends a heartbeat
# if more than 10 minutes have passed since the last one.
#
# Keeps the active-agents dashboard (E925) showing agents as "active"
# instead of "stale" during long-running sessions.
#

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
AGENT_ID_FILE="$REPO_ROOT/.claude/agent-id"
HEARTBEAT_FILE="$REPO_ROOT/.claude/last-heartbeat"
THROTTLE_SECONDS=600  # 10 minutes

# Quick exit if no agent registered
[ -f "$AGENT_ID_FILE" ] || exit 0

# Check throttle — is the heartbeat file recent enough?
if [ -f "$HEARTBEAT_FILE" ]; then
  LAST=$(stat -c %Y "$HEARTBEAT_FILE" 2>/dev/null || stat -f %m "$HEARTBEAT_FILE" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  AGE=$((NOW - LAST))
  [ "$AGE" -lt "$THROTTLE_SECONDS" ] && exit 0
fi

# Read agent ID and env vars
AGENT_ID=$(cat "$AGENT_ID_FILE" 2>/dev/null || true)
WIKI_SERVER_URL="${LONGTERMWIKI_SERVER_URL:-}"
API_KEY="${LONGTERMWIKI_PROJECT_KEY:-${LONGTERMWIKI_SERVER_API_KEY:-}}"

# Validate inputs
[[ "$AGENT_ID" =~ ^[0-9]+$ ]] || exit 0
[ -z "$WIKI_SERVER_URL" ] && exit 0
[ -z "$API_KEY" ] && exit 0

# Send heartbeat — only update throttle file on success
if curl -s --max-time 3 \
  -X POST "${WIKI_SERVER_URL}/api/active-agents/${AGENT_ID}/heartbeat" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d '{}' >/dev/null 2>&1; then
  touch "$HEARTBEAT_FILE"
fi
