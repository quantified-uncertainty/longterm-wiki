#!/usr/bin/env bash
#
# Claude Code setup script — runs once before a new session launches.
# Skipped when resuming an existing session.
#
# Handles slow, one-time environment prep: dependencies, data layer build,
# git config. The SessionStart hook (.claude/hooks/session-start.sh) handles
# fast context injection that runs every time.
#

set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== longterm-wiki setup ==="

# ─── 1. Dependencies ───────────────────────────────────────────────────────────

if [ ! -d "node_modules" ] || [ ! -d "apps/web/node_modules" ]; then
  echo "Installing dependencies..."
  # PUPPETEER_SKIP_DOWNLOAD: Chrome binary download fails in sandboxed environments
  # and is only needed for screenshot tests, not core development.
  PUPPETEER_SKIP_DOWNLOAD=1 pnpm install --reporter=silent 2>/dev/null || {
    echo "Warning: pnpm install had issues, trying again..."
    PUPPETEER_SKIP_DOWNLOAD=1 pnpm install || true
  }
fi

if [ -d "node_modules" ] && [ -d "apps/web/node_modules" ]; then
  echo "✓ Dependencies installed"
else
  echo "✗ Dependencies incomplete — some commands may fail"
fi

# ─── 2. Data layer ─────────────────────────────────────────────────────────────

if [ ! -f "apps/web/src/data/database.json" ] || [ ! -f "apps/web/src/data/pages.json" ]; then
  echo "Building data layer..."
  (cd apps/web && node --import tsx/esm scripts/build-data.mjs 2>&1) || true
fi

if [ -f "apps/web/src/data/database.json" ]; then
  echo "✓ Data layer built"
else
  echo "✗ Data layer missing — run: pnpm setup:quick"
fi

# ─── 3. Git hooks path ─────────────────────────────────────────────────────────
# Ensures the pre-push gate runs on every push.

CURRENT_HOOKS_PATH=$(git config --get core.hooksPath 2>/dev/null || true)
if [ "$CURRENT_HOOKS_PATH" != ".githooks" ]; then
  git config core.hooksPath .githooks
  echo "✓ Set core.hooksPath → .githooks (pre-push gate enabled)"
else
  echo "✓ Git hooks path already configured"
fi

echo "=== Setup complete ==="
