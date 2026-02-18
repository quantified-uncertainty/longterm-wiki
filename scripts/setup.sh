#!/usr/bin/env bash
#
# Longterm Wiki — Development Setup
#
# Usage:
#   ./scripts/setup.sh          # Full setup (install + build data + verify)
#   ./scripts/setup.sh --quick  # Skip validation, just install + build data
#   ./scripts/setup.sh --check  # Only check environment, don't install anything
#
# What this does:
#   1. Checks prerequisites (Node.js ≥20, pnpm ≥9)
#   2. Installs dependencies (pnpm install)
#   3. Builds the data layer (YAML/MDX → database.json)
#   4. Verifies git hooks are configured
#   5. Checks environment variables for content pipeline
#   6. Runs validation gate to confirm everything works
#

set -euo pipefail

# --- Colors & helpers ---

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

step() { echo -e "\n${BLUE}${BOLD}▸ $1${NC}"; }
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
info() { echo -e "  $1"; }

ERRORS=0
WARNINGS=0

# --- Parse flags ---

MODE="full"
for arg in "$@"; do
  case "$arg" in
    --quick) MODE="quick" ;;
    --check) MODE="check" ;;
    --help|-h)
      echo "Usage: ./scripts/setup.sh [--quick|--check|--help]"
      echo ""
      echo "  (default)  Full setup: install, build data, validate"
      echo "  --quick    Install and build data only, skip validation"
      echo "  --check    Check environment only, don't install anything"
      exit 0
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo -e "${BOLD}Longterm Wiki — Development Setup${NC}"
echo -e "Mode: ${BOLD}${MODE}${NC}"

# --- Step 1: Check prerequisites ---

step "Checking prerequisites"

# Node.js
if command -v node &>/dev/null; then
  NODE_VERSION=$(node -v | sed 's/^v//')
  NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 20 ]; then
    ok "Node.js $NODE_VERSION (≥20 required)"
  else
    fail "Node.js $NODE_VERSION — version ≥20.0.0 required"
    ERRORS=$((ERRORS + 1))
  fi
else
  fail "Node.js not found — install Node.js ≥20.0.0"
  ERRORS=$((ERRORS + 1))
fi

# pnpm
if command -v pnpm &>/dev/null; then
  PNPM_VERSION=$(pnpm -v)
  PNPM_MAJOR=$(echo "$PNPM_VERSION" | cut -d. -f1)
  if [ "$PNPM_MAJOR" -ge 9 ]; then
    ok "pnpm $PNPM_VERSION (≥9 required)"
  else
    fail "pnpm $PNPM_VERSION — version ≥9.0.0 required"
    ERRORS=$((ERRORS + 1))
  fi
else
  fail "pnpm not found — install with: npm install -g pnpm"
  ERRORS=$((ERRORS + 1))
fi

# git
if command -v git &>/dev/null; then
  ok "git $(git --version | awk '{print $3}')"
else
  fail "git not found"
  ERRORS=$((ERRORS + 1))
fi

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  fail "Prerequisites not met ($ERRORS errors). Fix the above and re-run."
  exit 1
fi

# Early exit for --check mode before install steps
if [ "$MODE" = "check" ]; then
  # Still check env vars and git hooks in check mode
  step "Checking git hooks"
  HOOKS_PATH=$(git config --get core.hooksPath 2>/dev/null || echo "")
  if [ "$HOOKS_PATH" = ".githooks" ]; then
    ok "Git hooks configured (core.hooksPath = .githooks)"
  else
    warn "Git hooks not configured — run: git config core.hooksPath .githooks"
    WARNINGS=$((WARNINGS + 1))
  fi

  step "Checking environment variables"

  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    ok "ANTHROPIC_API_KEY is set"
  else
    warn "ANTHROPIC_API_KEY not set — needed for content creation/improvement"
    WARNINGS=$((WARNINGS + 1))
  fi

  if [ -n "${OPENROUTER_API_KEY:-}" ]; then
    ok "OPENROUTER_API_KEY is set"
  else
    warn "OPENROUTER_API_KEY not set — needed for content pipeline"
    WARNINGS=$((WARNINGS + 1))
  fi

  if [ -n "${FIRECRAWL_KEY:-}" ]; then
    ok "FIRECRAWL_KEY is set"
  else
    info "FIRECRAWL_KEY not set (optional — used for web scraping in content pipeline)"
  fi

  if [ -n "${SCRY_API_KEY:-}" ]; then
    ok "SCRY_API_KEY is set"
  else
    info "SCRY_API_KEY not set (optional)"
  fi

  if [ -n "${GITHUB_TOKEN:-}" ]; then
    ok "GITHUB_TOKEN is set"
  else
    warn "GITHUB_TOKEN not set — needed for CI status checks and PR operations"
    WARNINGS=$((WARNINGS + 1))
  fi

  step "Checking data layer"
  if [ -f "app/src/data/database.json" ] && [ -f "app/src/data/pages.json" ]; then
    ok "Data layer exists (database.json + pages.json)"
  else
    warn "Data layer not built — run: pnpm run --filter longterm-next sync:data"
    WARNINGS=$((WARNINGS + 1))
  fi

  echo ""
  if [ "$WARNINGS" -gt 0 ]; then
    echo -e "${YELLOW}${BOLD}Environment check complete with $WARNINGS warning(s).${NC}"
  else
    echo -e "${GREEN}${BOLD}Environment check passed — everything looks good.${NC}"
  fi
  exit 0
fi

# --- Step 2: Install dependencies ---

step "Installing dependencies"
# PUPPETEER_SKIP_DOWNLOAD: Chrome binary download often fails in CI/sandboxed
# environments and is only needed for screenshot tests, not core development.
if PUPPETEER_SKIP_DOWNLOAD=1 pnpm install; then
  ok "Dependencies installed"
else
  # pnpm install can fail for non-critical reasons (postinstall scripts, etc.)
  # Check if node_modules actually got created
  if [ -d "node_modules" ] && [ -d "app/node_modules" ]; then
    warn "pnpm install had warnings/errors but node_modules exists — continuing"
    WARNINGS=$((WARNINGS + 1))
  else
    fail "pnpm install failed — check output above"
    exit 1
  fi
fi

# --- Step 3: Build the data layer ---

step "Building data layer (YAML + MDX → database.json)"
BUILD_OK=true
(cd "$REPO_ROOT/app" && node --import tsx/esm scripts/build-data.mjs) || BUILD_OK=false

if [ "$BUILD_OK" = true ] && [ -f "app/src/data/database.json" ] && [ -f "app/src/data/pages.json" ]; then
  ok "Data layer built successfully"
  ENTITY_COUNT=$(node -e "const d=JSON.parse(require('fs').readFileSync('app/src/data/database.json','utf8')); console.log(Object.keys(d.typedEntities||d.entities||{}).length)")
  PAGE_COUNT=$(node -e "const d=JSON.parse(require('fs').readFileSync('app/src/data/pages.json','utf8')); console.log(Array.isArray(d)?d.length:Object.keys(d).length)")
  info "$ENTITY_COUNT entities, $PAGE_COUNT pages"
else
  fail "Data layer build failed — check output above"
  ERRORS=$((ERRORS + 1))
fi

# --- Step 4: Verify git hooks ---

step "Verifying git hooks"
HOOKS_PATH=$(git config --get core.hooksPath 2>/dev/null || echo "")
if [ "$HOOKS_PATH" = ".githooks" ]; then
  ok "Git hooks already configured"
else
  # The pnpm prepare script should have set this, but verify
  git config core.hooksPath .githooks
  ok "Git hooks configured (core.hooksPath = .githooks)"
fi

if [ -x ".githooks/pre-push" ]; then
  ok "Pre-push hook is executable"
else
  chmod +x .githooks/pre-push
  ok "Pre-push hook made executable"
fi

# --- Step 5: Check environment variables ---

step "Checking environment variables"

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  ok "ANTHROPIC_API_KEY is set"
else
  warn "ANTHROPIC_API_KEY not set — needed for content creation/improvement"
  WARNINGS=$((WARNINGS + 1))
fi

if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  ok "OPENROUTER_API_KEY is set"
else
  warn "OPENROUTER_API_KEY not set — needed for content pipeline"
  WARNINGS=$((WARNINGS + 1))
fi

if [ -n "${FIRECRAWL_KEY:-}" ]; then
  ok "FIRECRAWL_KEY is set"
else
  info "FIRECRAWL_KEY not set (optional — used for web scraping in content pipeline)"
fi

if [ -n "${SCRY_API_KEY:-}" ]; then
  ok "SCRY_API_KEY is set"
else
  info "SCRY_API_KEY not set (optional)"
fi

if [ -n "${GITHUB_TOKEN:-}" ]; then
  ok "GITHUB_TOKEN is set"
else
  warn "GITHUB_TOKEN not set — needed for CI status checks and PR operations"
  WARNINGS=$((WARNINGS + 1))
fi

# --- Step 6: Validation (full mode only) ---

if [ "$MODE" = "full" ]; then
  step "Running validation gate"
  if pnpm crux validate gate; then
    ok "All gate checks passed"
  else
    fail "Validation gate failed — see output above for details"
    ERRORS=$((ERRORS + 1))
  fi
fi

# --- Summary ---

echo ""
echo -e "${BOLD}─────────────────────────────────${NC}"

if [ "$ERRORS" -gt 0 ]; then
  echo -e "${RED}${BOLD}Setup completed with $ERRORS error(s) and $WARNINGS warning(s).${NC}"
  echo ""
  echo "Fix the errors above and re-run: ./scripts/setup.sh"
  exit 1
elif [ "$WARNINGS" -gt 0 ]; then
  echo -e "${YELLOW}${BOLD}Setup completed with $WARNINGS warning(s).${NC}"
  echo ""
  echo "Warnings are non-blocking. The dev server and tests will work."
  echo "Set the missing env vars if you need the content pipeline."
else
  echo -e "${GREEN}${BOLD}Setup complete — ready to develop.${NC}"
fi

echo ""
echo "Next steps:"
echo "  pnpm dev                    # Start dev server on port 3001"
echo "  pnpm test                   # Run tests"
echo "  pnpm crux validate          # Full validation"
echo "  pnpm crux content create    # Create a new wiki page"
