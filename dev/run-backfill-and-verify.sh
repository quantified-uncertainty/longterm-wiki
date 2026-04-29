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

# Refuse to run against prod. backfill --apply writes; one stray prefix
# (WIKI_SERVER_ENV=prod) would silently target the prod wiki-server.
# Override with ALLOW_PROD=1 if you really mean it.
if [ "${WIKI_SERVER_ENV:-}" = "prod" ] && [ "${ALLOW_PROD:-}" != "1" ]; then
  printf '\033[31mRefusing to run: WIKI_SERVER_ENV=prod is set.\033[0m\n' >&2
  printf 'This script writes to the DB. Unset WIKI_SERVER_ENV (or set =local) to run locally,\n' >&2
  printf 'or set ALLOW_PROD=1 to override.\n' >&2
  exit 2
fi

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
