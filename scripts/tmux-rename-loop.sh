#!/bin/bash
# Background loop that runs `./ws fix-tabs` every 5 minutes to keep tmux
# window names in sync with their actual slot + branch.
#
# Why this exists: the slot heartbeat hooks (.claude/hooks/heartbeat.sh)
# rename a window only when an agent is actively running and the heartbeat
# fires (every 10 min). If a window is idle, has zsh open, or is the
# coordinator session, it never gets renamed by hooks alone.
#
# Usage:
#   nohup ./scripts/tmux-rename-loop.sh > /tmp/lw-fix-tabs.log 2>&1 &
#   disown
#
# Stop:
#   pkill -f tmux-rename-loop.sh

set -u
# Script lives at <workspace>/main/scripts/tmux-rename-loop.sh.
# Workspace root (where `ws` lives) is two levels up from this script, not one
# (QUA-480 — previous resolution pointed at lw/main/ws which doesn't exist).
LW_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
INTERVAL=300  # 5 minutes

# Run inside whichever tmux server is active for the current user.
# If multiple sockets exist (rare), iterate over all of them.
run_once() {
  local sock
  for sock in /private/tmp/tmux-${UID}/*; do
    [ -S "$sock" ] || continue
    TMUX="${sock},0,0" "$LW_DIR/ws" fix-tabs 2>&1 | sed "s|^|[$(date +%H:%M:%S)] |"
  done
}

echo "[lw-fix-tabs] Started PID $$, interval ${INTERVAL}s, lw=${LW_DIR}"
while true; do
  run_once
  sleep "$INTERVAL"
done
