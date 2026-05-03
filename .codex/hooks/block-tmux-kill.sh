#!/bin/bash
# Block tmux kill-window/kill-session/kill-pane commands
# These destroy other agents' sessions and cause irreversible data loss.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if echo "$COMMAND" | grep -qE 'tmux\s+(kill-window|kill-session|kill-pane|kill-server)'; then
  echo "BLOCKED: tmux kill commands are prohibited — they destroy other agents' active sessions."
  echo "  If you need to close a tmux window, ask the user to do it manually."
  echo "  Other agents may have hours of accumulated context that cannot be recovered."
  exit 2
fi
