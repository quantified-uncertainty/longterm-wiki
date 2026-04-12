#!/bin/bash
# Background loop that runs `./ws refresh` every 15 minutes so slots whose
# PR merged get auto-reset to main without waiting for the next coordinator
# session start.
#
# `./ws refresh` only resets slots whose PRs merged and pulls latest main in
# idle slots — it does not touch slots with active uncommitted work.
#
# Usage:
#   nohup ./scripts/ws-refresh-loop.sh > /tmp/lw-ws-refresh.log 2>&1 &
#   disown
#
# Stop:
#   pkill -f ws-refresh-loop.sh

set -u
LW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INTERVAL=900  # 15 minutes

echo "[lw-ws-refresh] Started PID $$, interval ${INTERVAL}s, lw=${LW_DIR}"
while true; do
  echo "[$(date +%H:%M:%S)] ./ws refresh"
  "$LW_DIR/ws" refresh 2>&1 | sed "s|^|[$(date +%H:%M:%S)] |"
  sleep "$INTERVAL"
done
