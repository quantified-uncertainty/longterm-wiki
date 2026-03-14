#!/usr/bin/env bash
# Auto-update cron script — runs the wiki auto-update via Claude Code subscription.
#
# Uses `claude -p "/auto-update"` which runs through your Claude Code
# Max/Pro subscription. No API credits consumed for page improvement.
# (The digest/routing stage still uses ~$0.15 of Haiku API.)
#
# Usage:
#   ./auto-update-cron.sh              # normal run
#   DRY_RUN=1 ./auto-update-cron.sh    # log what would happen, don't edit

set -euo pipefail

REPO_DIR="/Users/ozziegooen/Documents/GitHub.nosync/lw/a10"
LOG_DIR="$HOME/.claude/auto-update-logs"
LOG_FILE="$LOG_DIR/$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"

echo "=== Auto-update started at $(date) ===" | tee -a "$LOG_FILE"

# Pull latest main
cd "$REPO_DIR"
git checkout main 2>&1 | tee -a "$LOG_FILE"
git pull 2>&1 | tee -a "$LOG_FILE"

# Run the auto-update skill via Claude Code subscription
if [ "${DRY_RUN:-}" = "1" ]; then
  echo "DRY RUN — would execute: claude -p '/auto-update' --max-turns 50" | tee -a "$LOG_FILE"
else
  claude -p "/auto-update" \
    --max-turns 50 \
    --allowedTools "Bash,Read,Edit,Write,Glob,Grep,Agent,WebFetch,WebSearch" \
    2>&1 | tee -a "$LOG_FILE"
fi

echo "=== Auto-update finished at $(date) ===" | tee -a "$LOG_FILE"

# Clean up logs older than 30 days
find "$LOG_DIR" -name "*.log" -mtime +30 -delete 2>/dev/null || true
