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

# ─── 6. Active agent registration/heartbeat ──────────────────────────────────────
# Register or refresh heartbeat with the active-agents coordination system (E925).
# Uses curl for speed (avoids pnpm/node startup overhead).
# Runs on every session start AND resume, keeping the heartbeat fresh.

if [ -n "$WIKI_SERVER_URL" ] && [ "$BRANCH" != "main" ] && [ "$BRANCH" != "detached" ]; then
  API_KEY="${LONGTERMWIKI_PROJECT_KEY:-${LONGTERMWIKI_SERVER_API_KEY:-}}"
  if [ -n "$API_KEY" ]; then
    # Determine task from existing checklist, or fall back to branch name
    AGENT_TASK=""
    CHECKLIST_PATH=".claude/wip-checklist.md"
    if [ -f "$CHECKLIST_PATH" ]; then
      AGENT_TASK=$(grep -oP '> Task: \K.*' "$CHECKLIST_PATH" 2>/dev/null || true)
      # Also extract issue number from checklist if not already detected
      if [ -z "$ISSUE_NUM" ]; then
        ISSUE_NUM=$(grep -oP '> Issue: #\K\d+' "$CHECKLIST_PATH" 2>/dev/null || true)
      fi
    fi
    if [ -z "$AGENT_TASK" ]; then
      AGENT_TASK="Session on ${BRANCH}"
    fi

    # Build JSON payload safely with jq
    REGISTER_JSON=$(jq -n \
      --arg sessionId "$BRANCH" \
      --arg branch "$BRANCH" \
      --arg task "$AGENT_TASK" \
      --arg issueNumber "${ISSUE_NUM:-}" \
      '{sessionId: $sessionId, branch: $branch, task: $task} +
       (if $issueNumber != "" then {issueNumber: ($issueNumber | tonumber)} else {} end)' 2>/dev/null || true)

    if [ -n "$REGISTER_JSON" ]; then
      REGISTER_RESULT=$(curl -s --max-time 3 \
        -X POST "${WIKI_SERVER_URL}/api/active-agents" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${API_KEY}" \
        -d "$REGISTER_JSON" 2>/dev/null || true)

      if echo "$REGISTER_RESULT" | grep -q '"id"' 2>/dev/null; then
        AGENT_ID=$(echo "$REGISTER_RESULT" | grep -oE '"id":[0-9]+' | grep -oE '[0-9]+' | head -1)
        if [ -n "$AGENT_ID" ]; then
          echo "$AGENT_ID" > .claude/agent-id
          touch .claude/last-heartbeat
          CONTEXT_LINES+=("✓ Active agent: registered #${AGENT_ID} (E925 dashboard)")
        fi
      fi
    fi
  fi
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
