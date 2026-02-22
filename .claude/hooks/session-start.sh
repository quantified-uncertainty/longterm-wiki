#!/usr/bin/env bash
#
# SessionStart hook — ensures the dev environment is ready.
#
# Runs automatically when a Claude Code session starts.
# Checks for the data layer and builds it if missing.
# Outputs context that gets injected into the session.
#

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

ISSUES=()

# Check if dependencies are installed
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

# Check if data layer exists, build if missing
if [ ! -f "apps/web/src/data/database.json" ] || [ ! -f "apps/web/src/data/pages.json" ]; then
  echo "Building data layer..." >&2
  if (cd apps/web && node --import tsx/esm scripts/build-data.mjs 2>/dev/null); then
    echo "Data layer built." >&2
  else
    ISSUES+=("Data layer build failed. Run: pnpm setup:quick")
  fi
fi

# Check wiki-server connectivity
WIKI_SERVER_URL="${LONGTERMWIKI_SERVER_URL:-}"
if [ -z "$WIKI_SERVER_URL" ]; then
  WIKI_SERVER_STATUS="ℹ Wiki server: LONGTERMWIKI_SERVER_URL not set (crux query commands unavailable)"
else
  HEALTH_RESPONSE=$(curl -s --max-time 3 "${WIKI_SERVER_URL}/health" 2>/dev/null || true)
  if [ -n "$HEALTH_RESPONSE" ] && echo "$HEALTH_RESPONSE" | grep -q '"status":"healthy"'; then
    PAGES=$(echo "$HEALTH_RESPONSE" | grep -oE '"totalPages":[0-9]+' | grep -oE '[0-9]+' || true)
    ENTITIES=$(echo "$HEALTH_RESPONSE" | grep -oE '"totalEntities":[0-9]+' | grep -oE '[0-9]+' || true)
    if [ -n "$PAGES" ] && [ -n "$ENTITIES" ]; then
      WIKI_SERVER_STATUS="✓ Wiki server: available at ${WIKI_SERVER_URL} (${PAGES} pages, ${ENTITIES} entities) — use \`pnpm crux query\` to search"
    else
      WIKI_SERVER_STATUS="✓ Wiki server: available at ${WIKI_SERVER_URL} — use \`pnpm crux query\` to search"
    fi
  else
    WIKI_SERVER_STATUS="⚠ Wiki server: not reachable at ${WIKI_SERVER_URL} (crux query, citations, edit-log unavailable)"
  fi
fi

# Output session context (stdout is injected as context for Claude)
if [ ${#ISSUES[@]} -gt 0 ]; then
  echo "SESSION SETUP ISSUES:"
  for issue in "${ISSUES[@]}"; do
    echo "  - $issue"
  done
else
  echo "Environment ready (dependencies installed, data layer built)."
fi
echo "${WIKI_SERVER_STATUS}"
