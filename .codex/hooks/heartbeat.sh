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

# Heartbeats always target the prod wiki-server (the active-agents dashboard
# lives there). Agent slots don't run a local wiki-server, so the default
# LONGTERMWIKI_SERVER_URL (localhost:311x) is unreachable. Use PROD_* vars
# when available, falling back to the default vars for local-dev setups.
if [ -n "${PROD_LONGTERMWIKI_SERVER_URL:-}" ]; then
  WIKI_SERVER_URL="$PROD_LONGTERMWIKI_SERVER_URL"
  API_KEY="${PROD_LONGTERMWIKI_SERVER_API_KEY:-${LONGTERMWIKI_SERVER_API_KEY:-}}"
else
  WIKI_SERVER_URL="${LONGTERMWIKI_SERVER_URL:-}"
  API_KEY="${LONGTERMWIKI_SERVER_API_KEY:-}"
fi

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

  # Self-heal .agent-slot if missing (git operations on stale branches delete it)
  # See: https://github.com/quantified-uncertainty/longterm-wiki/discussions/3779
  AGENT_SLOT_FILE="$REPO_ROOT/.agent-slot"
  DIR_NAME=$(basename "$REPO_ROOT")
  if [[ "$DIR_NAME" =~ ^a([0-9]+)$ ]]; then
    SLOT_FROM_DIR="${BASH_REMATCH[1]}"
    CURRENT_SLOT=$(cat "$AGENT_SLOT_FILE" 2>/dev/null | tr -d '[:space:]' || true)
    if [ "$CURRENT_SLOT" != "$SLOT_FROM_DIR" ]; then
      echo "$SLOT_FROM_DIR" > "$AGENT_SLOT_FILE"
    fi
  fi

  # Tmux naming — derive from directory name, not .agent-slot file
  # See: https://github.com/quantified-uncertainty/longterm-wiki/discussions/3798
  # IMPORTANT: Use -t with pane ID to target THIS session's window specifically.
  # Without -t, tmux rename-window targets the user's currently-viewed window.
  if [ -n "${SLOT_FROM_DIR:-}" ] && command -v tmux >/dev/null 2>&1 && [ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ]; then
    SLOT="$SLOT_FROM_DIR"
    CURRENT_BRANCH=$(git -C "$REPO_ROOT" branch --show-current 2>/dev/null || echo "?")
    PR_NUM=$(
      gh pr view --json number --jq .number 2>/dev/null &
      _pid=$!
      ( sleep 2 && kill $_pid 2>/dev/null ) &
      _timer=$!
      wait $_pid 2>/dev/null
      kill $_timer 2>/dev/null
      wait $_timer 2>/dev/null
    ) 2>/dev/null || true
    LABEL="A${SLOT}:${CURRENT_BRANCH}"
    [ -n "$PR_NUM" ] && LABEL="${LABEL} #${PR_NUM}"
    tmux rename-window -t "$TMUX_PANE" "$LABEL" 2>/dev/null || true
  fi
fi
