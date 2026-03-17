#!/usr/bin/env bash
# Maintenance sweep cron script — runs /maintain via Claude Code subscription.
#
# Checks how many PRs have merged since the last maintenance run.
# Only invokes Claude Code if >= $MIN_PRS new PRs have merged.
# This keeps maintenance proportional to activity, not clock time.
#
# Usage:
#   ./maintenance-cron.sh              # normal run (gated on PR count)
#   FORCE=1 ./maintenance-cron.sh      # skip PR count check, always run
#   DRY_RUN=1 ./maintenance-cron.sh    # log what would happen, don't run

set -euo pipefail

REPO_DIR="/Users/ozziegooen/Documents/GitHub.nosync/lw/a11"
LOG_DIR="$HOME/.claude/maintenance-logs"
LOG_FILE="$LOG_DIR/$(date +%Y-%m-%d_%H%M).log"
MIN_PRS=6

mkdir -p "$LOG_DIR"

echo "=== Maintenance check at $(date) ===" | tee -a "$LOG_FILE"

cd "$REPO_DIR"

# Pull latest main
git checkout main 2>&1 | tee -a "$LOG_FILE"
git pull 2>&1 | tee -a "$LOG_FILE"

# Check merged PR count since last run
LAST_RUN_FILE="$REPO_DIR/.claude/maintain-last-run.txt"
if [ -f "$LAST_RUN_FILE" ]; then
  LAST_RUN=$(cat "$LAST_RUN_FILE" | head -1 | tr -d '[:space:]')
else
  LAST_RUN="1970-01-01"
fi

echo "Last maintenance run: $LAST_RUN" | tee -a "$LOG_FILE"

PR_COUNT=$(gh pr list --repo quantified-uncertainty/longterm-wiki \
  --state merged --search "merged:>=$LAST_RUN" \
  --limit 100 --json number --jq length 2>/dev/null || echo "0")

echo "Merged PRs since last run: $PR_COUNT (threshold: $MIN_PRS)" | tee -a "$LOG_FILE"

if [ "${FORCE:-}" != "1" ] && [ "$PR_COUNT" -lt "$MIN_PRS" ]; then
  echo "Below threshold — skipping maintenance." | tee -a "$LOG_FILE"
  echo "=== Maintenance check done at $(date) ===" | tee -a "$LOG_FILE"
  exit 0
fi

echo "Threshold met — running maintenance sweep." | tee -a "$LOG_FILE"

if [ "${DRY_RUN:-}" = "1" ]; then
  echo "DRY RUN — would execute: claude -p '/maintain' --max-turns 80" | tee -a "$LOG_FILE"
else
  claude -p "/maintain" \
    --max-turns 80 \
    --allowedTools "Bash,Read,Edit,Write,Glob,Grep,Agent,WebFetch,WebSearch,Skill" \
    2>&1 | tee -a "$LOG_FILE"
fi

echo "=== Maintenance finished at $(date) ===" | tee -a "$LOG_FILE"

# Clean up logs older than 30 days
find "$LOG_DIR" -name "*.log" -mtime +30 -delete 2>/dev/null || true
