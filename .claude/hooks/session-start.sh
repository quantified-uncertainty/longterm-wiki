#!/usr/bin/env bash
#
# SessionStart hook — surfaces context that saves the agent early orientation turns.
#
# Runs every time a Claude Code session starts (including resume).
# stdout is injected as context for the Claude session.
# stderr is shown as progress during setup.
#
# Heavy env prep (deps, data layer, git config) lives in .claude/setup.sh,
# which runs once before launch and is skipped on resume.
#

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

CONTEXT_LINES=()
WARNINGS=()

# ─── 1. Verify environment (fast checks only) ──────────────────────────────────

if [ ! -d "node_modules" ] || [ ! -d "apps/web/node_modules" ]; then
  WARNINGS+=("Dependencies not installed. Run: pnpm setup:quick")
fi
if [ ! -f "apps/web/src/data/database.json" ]; then
  WARNINGS+=("Data layer missing. Run: pnpm setup:quick")
fi

# ─── 2. Git state context ──────────────────────────────────────────────────────

BRANCH=$(git branch --show-current 2>/dev/null || echo "detached")
LAST_COMMIT=$(git log --oneline -1 2>/dev/null || echo "no commits")
DIRTY_COUNT=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')

CONTEXT_LINES+=("Git: branch \`${BRANCH}\`, last commit: ${LAST_COMMIT}")
if [ "$DIRTY_COUNT" -gt 0 ]; then
  CONTEXT_LINES+=("⚠ Working tree has ${DIRTY_COUNT} uncommitted change(s) — run \`git status\` before committing.")
fi

# ─── 3. Wiki server connectivity ───────────────────────────────────────────────

WIKI_SERVER_URL="${LONGTERMWIKI_SERVER_URL:-}"
if [ -z "$WIKI_SERVER_URL" ]; then
  CONTEXT_LINES+=("ℹ Wiki server: LONGTERMWIKI_SERVER_URL not set (crux query commands unavailable)")
else
  HEALTH_RESPONSE=$(curl -s --max-time 3 "${WIKI_SERVER_URL}/health" 2>/dev/null || true)
  if [ -n "$HEALTH_RESPONSE" ] && echo "$HEALTH_RESPONSE" | grep -q '"status":"healthy"'; then
    PAGES=$(echo "$HEALTH_RESPONSE" | grep -oE '"totalPages":[0-9]+' | grep -oE '[0-9]+' || true)
    ENTITIES=$(echo "$HEALTH_RESPONSE" | grep -oE '"totalEntities":[0-9]+' | grep -oE '[0-9]+' || true)
    if [ -n "$PAGES" ] && [ -n "$ENTITIES" ]; then
      CONTEXT_LINES+=("✓ Wiki server: ${WIKI_SERVER_URL} (${PAGES} pages, ${ENTITIES} entities)")
    else
      CONTEXT_LINES+=("✓ Wiki server: available at ${WIKI_SERVER_URL}")
    fi
  else
    CONTEXT_LINES+=("⚠ Wiki server: not reachable at ${WIKI_SERVER_URL} (crux query, citations, edit-log unavailable)")
  fi
fi

# ─── 4. API key checks ─────────────────────────────────────────────────────────

MISSING_KEYS=()
[ -z "${ANTHROPIC_API_KEY:-}" ] && MISSING_KEYS+=("ANTHROPIC_API_KEY")
[ -z "${GITHUB_TOKEN:-}" ] && MISSING_KEYS+=("GITHUB_TOKEN")
[ -z "${OPENROUTER_API_KEY:-}" ] && MISSING_KEYS+=("OPENROUTER_API_KEY")

if [ ${#MISSING_KEYS[@]} -gt 0 ]; then
  CONTEXT_LINES+=("⚠ Missing API keys: ${MISSING_KEYS[*]} — some crux commands may fail")
fi

# ─── 5. Issue detection from branch name ────────────────────────────────────────

ISSUE_NUM=""
if [[ "$BRANCH" =~ issue[s]?[-_]([0-9]+) ]]; then
  ISSUE_NUM="${BASH_REMATCH[1]}"
elif [[ "$BRANCH" =~ resolve[-_]issue[-_]([0-9]+) ]]; then
  ISSUE_NUM="${BASH_REMATCH[1]}"
fi

if [ -n "$ISSUE_NUM" ]; then
  CONTEXT_LINES+=("Detected GitHub issue #${ISSUE_NUM} from branch name.")
  CONTEXT_LINES+=("→ Remember to run: pnpm crux agent-checklist init --issue=${ISSUE_NUM}")
  CONTEXT_LINES+=("→ Remember to run: pnpm crux issues start ${ISSUE_NUM}")
fi

# ─── Output ─────────────────────────────────────────────────────────────────────

if [ ${#WARNINGS[@]} -gt 0 ]; then
  echo "SESSION SETUP WARNINGS:"
  for w in "${WARNINGS[@]}"; do
    echo "  - $w"
  done
else
  echo "Environment ready."
fi

for line in "${CONTEXT_LINES[@]}"; do
  echo "$line"
done
