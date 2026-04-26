#!/usr/bin/env bash
#
# Runs the full source-check pipeline end-to-end on N records:
#   1. backfill-sources --apply  (find + write source URLs for records missing them)
#   2. verify backfill           (snapshot the URLs + run verdicts)
#
# Usage:
#   dev/run-backfill-and-verify.sh                  # default: 10 records, $5 budget
#   dev/run-backfill-and-verify.sh 50               # 50 records
#   dev/run-backfill-and-verify.sh 50 10            # 50 records, $10 budget
#   DRY_RUN=1 dev/run-backfill-and-verify.sh 5      # preview only (backfill in --dry-run)
#

set -euo pipefail

LIMIT="${1:-10}"
BUDGET="${2:-5}"
DRY_RUN="${DRY_RUN:-}"

cd "$(dirname "$0")/.."

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

bold "=== Stage 1/2: Find + write source URLs (limit=$LIMIT) ==="
if [ -n "$DRY_RUN" ]; then
  yellow "DRY RUN — backfill will not write to DB"
  pnpm crux tb backfill-sources --dry-run --limit="$LIMIT"
  yellow "Skipping verify stage in dry-run mode"
  exit 0
fi
pnpm crux tb backfill-sources --apply --limit="$LIMIT"

echo
bold "=== Stage 2/2: Snapshot + verdict (budget=\$$BUDGET) ==="
pnpm crux tb verify backfill --budget="$BUDGET" --limit="$LIMIT"

echo
bold "=== Done ==="
echo "Triage results at /internal/entity-source-checks/"
