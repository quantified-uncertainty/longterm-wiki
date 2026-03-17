#!/usr/bin/env bash
#
# matrix-loop.sh — Ralph-style autonomous content improvement loop
#
# Reads the entity matrix, picks the highest-impact page, runs the content
# improve pipeline, validates, commits, and repeats.
#
# Usage:
#   ./scripts/matrix-loop.sh [MAX_ITERATIONS] [DIMENSION] [TIER]
#
# Examples:
#   ./scripts/matrix-loop.sh 5                    # 5 iterations, content dimension, standard tier
#   ./scripts/matrix-loop.sh 10 coverage polish   # 10 iterations, coverage dimension, polish tier
#   ./scripts/matrix-loop.sh 3 content deep       # 3 deep iterations
#
# Requirements:
#   - database.json must exist (run `pnpm build-data:content` first)
#   - ANTHROPIC_API_KEY must be set for content improve
#
# Safety:
#   - Each iteration is one page, one commit
#   - Validation gate must pass before commit
#   - Errors in one iteration don't stop the loop (logged and skipped)
#   - Internal pages are auto-skipped (not counted toward iterations)
#   - Total cost depends on tier × iterations ($2-3/page polish, $5-8 standard, $15-25 deep)

set -euo pipefail

MAX_ITERATIONS="${1:-5}"
DIMENSION="${2:-content}"
TIER="${3:-standard}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

echo -e "${BOLD}Matrix Content Loop${RESET}"
echo -e "${DIM}Iterations: $MAX_ITERATIONS | Dimension: $DIMENSION | Tier: $TIER${RESET}"
echo ""

# Check prerequisites
if [ ! -f "apps/web/src/data/database.json" ]; then
  echo -e "${RED}Error: database.json not found. Run 'pnpm build-data:content' first.${RESET}"
  exit 1
fi

SUCCEEDED=0
FAILED=0
SKIPPED=0
MAX_TOTAL_ATTEMPTS=50  # Safety limit to prevent infinite loops

ATTEMPT=0
while [ "$SUCCEEDED" -lt "$MAX_ITERATIONS" ] && [ "$ATTEMPT" -lt "$MAX_TOTAL_ATTEMPTS" ]; do
  ATTEMPT=$((ATTEMPT + 1))

  echo -e "${BOLD}━━━ Iteration $((SUCCEEDED + 1))/$MAX_ITERATIONS (attempt $ATTEMPT) ━━━${RESET}"

  # Get next task
  TASK_JSON=$(pnpm --silent crux matrix next-task --dimension="$DIMENSION" --format=json 2>/dev/null)

  if [ "$TASK_JSON" = '{"task":null,"message":"NO_TASKS"}' ] || [ -z "$TASK_JSON" ]; then
    echo -e "${GREEN}No more tasks above threshold. All done!${RESET}"
    break
  fi

  PAGE_SLUG=$(echo "$TASK_JSON" | node -e "process.stdin.setEncoding('utf8'); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{const j=JSON.parse(d); console.log(j.id)})")
  PAGE_ID=$(echo "$TASK_JSON" | node -e "process.stdin.setEncoding('utf8'); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{const j=JSON.parse(d); console.log(j.wikiId)})")
  PAGE_TITLE=$(echo "$TASK_JSON" | node -e "process.stdin.setEncoding('utf8'); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{const j=JSON.parse(d); console.log(j.title)})")
  IMPACT=$(echo "$TASK_JSON" | node -e "process.stdin.setEncoding('utf8'); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{const j=JSON.parse(d); console.log(j.impactScore)})")
  ENTITY_TYPE=$(echo "$TASK_JSON" | node -e "process.stdin.setEncoding('utf8'); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{const j=JSON.parse(d); console.log(j.entityType)})")

  # Skip internal pages — they're wiki documentation, not user-facing content
  if [ "$ENTITY_TYPE" = "internal" ]; then
    echo -e "${DIM}Skipping internal page: ${PAGE_TITLE} (${PAGE_ID})${RESET}"
    pnpm --silent crux matrix mark-done "$PAGE_ID" 2>/dev/null || true
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  echo -e "${BLUE}Page: ${PAGE_TITLE} (${PAGE_SLUG} / ${PAGE_ID}) — impact: ${IMPACT}${RESET}"

  # Run content improve (uses slug, not wikiId)
  echo -e "${DIM}Running content improve --tier=$TIER...${RESET}"
  if pnpm crux content improve "$PAGE_SLUG" --tier="$TIER" --apply --skip-session-log 2>&1; then
    echo -e "${GREEN}✓ Content improved${RESET}"
  else
    echo -e "${YELLOW}⚠ Content improve failed for $PAGE_SLUG ($PAGE_ID), skipping${RESET}"
    FAILED=$((FAILED + 1))
    continue
  fi

  # Post-improve fixes
  echo -e "${DIM}Running fixes...${RESET}"
  pnpm crux fix escaping 2>&1 || true
  pnpm crux fix markdown 2>&1 || true

  # Validate
  echo -e "${DIM}Running validation gate...${RESET}"
  if pnpm crux validate gate --fix 2>&1; then
    echo -e "${GREEN}✓ Gate passed${RESET}"
  else
    echo -e "${YELLOW}⚠ Gate failed for $PAGE_SLUG ($PAGE_ID), reverting and skipping${RESET}"
    git checkout -- . 2>/dev/null || true
    FAILED=$((FAILED + 1))
    continue
  fi

  # Commit
  git add -A
  CHANGES=$(git diff --cached --stat | tail -1)
  if [ -z "$CHANGES" ]; then
    echo -e "${DIM}No changes to commit, skipping${RESET}"
    pnpm --silent crux matrix mark-done "$PAGE_ID" 2>/dev/null || true
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  git commit -m "$(cat <<EOF
Improve ${PAGE_TITLE} (${PAGE_ID}) via matrix loop

Tier: ${TIER} | Dimension: ${DIMENSION} | Impact: ${IMPACT}

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
  )" --quiet

  echo -e "${GREEN}✓ Committed${RESET}"

  # Mark page as done so it's excluded from future picks
  pnpm --silent crux matrix mark-done "$PAGE_ID" 2>/dev/null || true

  SUCCEEDED=$((SUCCEEDED + 1))

  # Rebuild data for next iteration (so scores are fresh)
  if [ "$SUCCEEDED" -lt "$MAX_ITERATIONS" ]; then
    echo -e "${DIM}Rebuilding data for next iteration...${RESET}"
    pnpm build-data:content 2>&1 | tail -1 || true
  fi

  echo ""
done

echo -e "${BOLD}━━━ Loop Complete ━━━${RESET}"
echo -e "Succeeded: ${GREEN}$SUCCEEDED${RESET} | Failed: ${RED}$FAILED${RESET} | Skipped: ${DIM}$SKIPPED${RESET}"
echo -e "Total attempts: $ATTEMPT"
