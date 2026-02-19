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

# Output session context (stdout is injected as context for Claude)
if [ ${#ISSUES[@]} -gt 0 ]; then
  echo "SESSION SETUP ISSUES:"
  for issue in "${ISSUES[@]}"; do
    echo "  - $issue"
  done
else
  echo "Environment ready (dependencies installed, data layer built)."
fi
