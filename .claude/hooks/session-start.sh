#!/usr/bin/env bash
#
# SessionStart hook — ensures the dev environment is ready and surfaces
# context that saves the agent early orientation turns.
#
# Runs automatically when a Claude Code session starts.
# stdout is injected as context for the Claude session.
# stderr is shown as progress during setup.
#

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

ISSUES=()
CONTEXT_LINES=()

# ─── 1. Dependencies ───────────────────────────────────────────────────────────

if [ ! -d "node_modules" ] || [ ! -d "apps/web/node_modules" ]; then
  echo "Installing dependencies..." >&2
  # PUPPETEER_SKIP_DOWNLOAD: Chrome binary download fails in sandboxed environments
  # and is only needed for screenshot tests, not core development.
  PUPPETEER_SKIP_DOWNLOAD=1 pnpm install --reporter=silent 2>/dev/null || true
  if [ -d "node_modules" ] && [ -d "apps/web/node_modules" ]; then
    echo "Dependencies installed." >&2
  else
    ISSUES+=("Dependencies not fully installed. Run: pnpm setup:quick")
  fi
fi

# ─── 2. Data layer ─────────────────────────────────────────────────────────────

if [ ! -f "apps/web/src/data/database.json" ] || [ ! -f "apps/web/src/data/pages.json" ]; then
  echo "Building data layer..." >&2
  if (cd apps/web && node --import tsx/esm scripts/build-data.mjs 2>/dev/null); then
    echo "Data layer built." >&2
  else
    ISSUES+=("Data layer build failed. Run: pnpm setup:quick")
  fi
fi

# ─── 3. Git hooks path ─────────────────────────────────────────────────────────
# Ensures the pre-push gate runs on every push. Idempotent.

CURRENT_HOOKS_PATH=$(git config --get core.hooksPath 2>/dev/null || true)
if [ "$CURRENT_HOOKS_PATH" != ".githooks" ]; then
  git config core.hooksPath .githooks
  echo "Set core.hooksPath → .githooks (pre-push gate enabled)." >&2
fi

# ─── 4. Git state context ──────────────────────────────────────────────────────
# Saves the agent 2-3 orientation turns.

BRANCH=$(git branch --show-current 2>/dev/null || echo "detached")
LAST_COMMIT=$(git log --oneline -1 2>/dev/null || echo "no commits")
DIRTY_COUNT=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')

CONTEXT_LINES+=("Git: branch \`${BRANCH}\`, last commit: ${LAST_COMMIT}")
if [ "$DIRTY_COUNT" -gt 0 ]; then
  CONTEXT_LINES+=("⚠ Working tree has ${DIRTY_COUNT} uncommitted change(s) — run \`git status\` before committing.")
fi

# ─── 5. Wiki server connectivity ───────────────────────────────────────────────

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

# ─── 6. API key checks ─────────────────────────────────────────────────────────
# Content pipeline sessions need these; surfacing early prevents mid-run failures.

MISSING_KEYS=()
[ -z "${ANTHROPIC_API_KEY:-}" ] && MISSING_KEYS+=("ANTHROPIC_API_KEY")
[ -z "${GITHUB_TOKEN:-}" ] && MISSING_KEYS+=("GITHUB_TOKEN")
[ -z "${OPENROUTER_API_KEY:-}" ] && MISSING_KEYS+=("OPENROUTER_API_KEY")

if [ ${#MISSING_KEYS[@]} -gt 0 ]; then
  CONTEXT_LINES+=("⚠ Missing API keys: ${MISSING_KEYS[*]} — some crux commands may fail")
fi

# ─── 7. Issue detection from branch name ────────────────────────────────────────
# Patterns: claude/issue-605-xxx, claude/resolve-issue-605-xxx

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

if [ ${#ISSUES[@]} -gt 0 ]; then
  echo "SESSION SETUP ISSUES:"
  for issue in "${ISSUES[@]}"; do
    echo "  - $issue"
  done
else
  echo "Environment ready."
fi

for line in "${CONTEXT_LINES[@]}"; do
  echo "$line"
done
