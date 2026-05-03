#!/usr/bin/env bash
#
# SessionStart hook — surfaces context that saves the agent early orientation turns.
#
# Runs every time an agent session starts (including resume).
# stdout is injected as context for the agent session.
# stderr is shown as progress during setup.
#
# Heavy env prep (deps, data layer, git config) lives in legacy
# .claude/setup.sh, which runs once before launch and is skipped on resume.
#

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

CONTEXT_LINES=()
WARNINGS=()

# ─── 0pre. Concurrent session detection ──────────────────────────────────────────
# Check if another agent session is already running in this slot.
# Uses a PID lock file — if the PID is still alive, warn about concurrent access.

LOCK_FILE="$REPO_ROOT/.claude/session.pid"
if [ -f "$LOCK_FILE" ]; then
  OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null | tr -d '[:space:]')
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    WARNINGS+=("CONCURRENT SESSION DETECTED: Another agent session (PID ${OLD_PID}) is already running in this slot!")
    WARNINGS+=("Running two sessions in the same directory causes git conflicts and file corruption.")
    WARNINGS+=("Either stop the other session or use a different slot.")
  fi
fi
# Write current parent PID (the agent process that invoked this hook)
echo "$$" > "$LOCK_FILE"

# ─── 0. Clear stale checklist from previous session ─────────────────────────────
# This hook only fires on fresh "startup" (not resume), so removing the checklist
# forces the new session to run `crux sys agent-checklist init` before editing code.
# The PreToolUse hook in require-checklist.sh enforces this.

if [ -f ".claude/wip-checklist.md" ]; then
  rm -f ".claude/wip-checklist.md"
  CONTEXT_LINES+=("⚠ Cleared stale checklist from previous session. Run \`pnpm crux sys agent-checklist init\` before editing code.")
fi

# ─── 0a. Stale stash detection ──────────────────────────────────────────────────
# Stale stashes cause branch confusion when a later session does `git stash pop`
# and restores state from a completely different branch/task. (#3200 incident)

STASH_COUNT=$(git stash list 2>/dev/null | wc -l | tr -d ' ')
if [ "$STASH_COUNT" -gt 0 ]; then
  STASH_BRANCHES=$(git stash list --format='%gs' 2>/dev/null | head -5)
  WARNINGS+=("Found ${STASH_COUNT} stale stash(es) from previous sessions. These cause branch confusion.")
  WARNINGS+=("Stashes: ${STASH_BRANCHES}")
  WARNINGS+=("Run \`git stash drop\` to clean each one, or \`git stash clear\` to drop all.")
fi

# ─── 0b. Branch lock file ───────────────────────────────────────────────────────
# Write .claude/active-branch at session start. If a previous session left one
# and it doesn't match the current branch, something switched the branch between
# sessions without proper cleanup.
# NOTE: Uses CURRENT_BRANCH (read early) since BRANCH is set later in section 2.

CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "detached")

PREV_ACTIVE_BRANCH=""
if [ -f ".claude/active-branch" ]; then
  PREV_ACTIVE_BRANCH=$(cat ".claude/active-branch" 2>/dev/null | tr -d '[:space:]')
fi

if [ -n "$PREV_ACTIVE_BRANCH" ] && [ "$PREV_ACTIVE_BRANCH" != "$CURRENT_BRANCH" ]; then
  WARNINGS+=("Branch mismatch! Previous session was on \`${PREV_ACTIVE_BRANCH}\`, now on \`${CURRENT_BRANCH}\`.")
  WARNINGS+=("A subagent or another session may have switched branches. Verify you're on the right branch before proceeding.")
fi

# Write current branch as the active branch lock
echo "$CURRENT_BRANCH" > ".claude/active-branch"

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

# Prefer PROD_* vars (agent slots don't run a local wiki-server)
if [ -n "${PROD_LONGTERMWIKI_SERVER_URL:-}" ]; then
  WIKI_SERVER_URL="$PROD_LONGTERMWIKI_SERVER_URL"
else
  WIKI_SERVER_URL="${LONGTERMWIKI_SERVER_URL:-}"
fi
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
[ -z "${ANTHROPIC_BILLING_KEY:-}" ] && MISSING_KEYS+=("ANTHROPIC_BILLING_KEY")
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
  CONTEXT_LINES+=("→ Remember to run: pnpm crux sys agent-checklist init --issue=${ISSUE_NUM}")
  CONTEXT_LINES+=("→ Remember to run: pnpm crux gh issues start ${ISSUE_NUM}")
fi

# ─── 5b. Self-heal .agent-slot + Tmux window naming ──────────────────────────
# .agent-slot gets deleted by git operations on stale branches that still track it.
# See: https://github.com/quantified-uncertainty/longterm-wiki/discussions/3779
# Self-heal: derive slot number from directory name (a7 → 7) and recreate if missing/wrong.
AGENT_SLOT_FILE="$REPO_ROOT/.agent-slot"
DIR_NAME=$(basename "$REPO_ROOT")
SLOT_FROM_DIR=""
if [[ "$DIR_NAME" =~ ^a([0-9]+)$ ]]; then
  SLOT_FROM_DIR="${BASH_REMATCH[1]}"
fi

if [ -n "$SLOT_FROM_DIR" ]; then
  CURRENT_SLOT=$(cat "$AGENT_SLOT_FILE" 2>/dev/null | tr -d '[:space:]' || true)
  if [ "$CURRENT_SLOT" != "$SLOT_FROM_DIR" ]; then
    echo "$SLOT_FROM_DIR" > "$AGENT_SLOT_FILE"
    if [ -z "$CURRENT_SLOT" ]; then
      WARNINGS+=(".agent-slot was missing — recreated with value ${SLOT_FROM_DIR} (self-healed from dir name)")
    else
      WARNINGS+=(".agent-slot had wrong value '${CURRENT_SLOT}' — fixed to ${SLOT_FROM_DIR} (self-healed from dir name)")
    fi
  fi
fi

# Tmux window naming — derive from directory name, not .agent-slot file
# See: https://github.com/quantified-uncertainty/longterm-wiki/discussions/3798
# IMPORTANT: Use -t with pane ID to target THIS session's window specifically.
# Without -t, tmux rename-window targets the user's currently-viewed window,
# which may belong to a different session entirely.
if [ -n "$SLOT_FROM_DIR" ] && command -v tmux >/dev/null 2>&1 && [ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ]; then
  tmux rename-window -t "$TMUX_PANE" "A${SLOT_FROM_DIR}:${BRANCH}" 2>/dev/null || true
  CONTEXT_LINES+=("Tmux: window renamed to A${SLOT_FROM_DIR}:${BRANCH}")
fi

# ─── 6. Active agent registration/heartbeat ──────────────────────────────────────
# Register or refresh heartbeat with the active-agents coordination system (E925).
# Uses curl for speed (avoids pnpm/node startup overhead).
# Runs on every session start AND resume, keeping the heartbeat fresh.

if [ -n "$WIKI_SERVER_URL" ] && [ "$BRANCH" != "main" ] && [ "$BRANCH" != "detached" ]; then
  # Use prod API key when targeting prod server
  if [ -n "${PROD_LONGTERMWIKI_SERVER_API_KEY:-}" ]; then
    API_KEY="$PROD_LONGTERMWIKI_SERVER_API_KEY"
  else
    API_KEY="${LONGTERMWIKI_SERVER_API_KEY:-}"
  fi
  if [ -z "$API_KEY" ]; then
    CONTEXT_LINES+=("⚠ Active agent registration skipped: LONGTERMWIKI_SERVER_API_KEY not set")
  else
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

    # Include agent slot in metadata — derive from directory name, not file
    SLOT_NUM="$SLOT_FROM_DIR"

    # Build JSON payload safely with jq
    REGISTER_JSON=$(jq -n \
      --arg sessionId "$BRANCH" \
      --arg branch "$BRANCH" \
      --arg task "$AGENT_TASK" \
      --arg issueNumber "${ISSUE_NUM:-}" \
      --arg slot "${SLOT_NUM:-}" \
      '{sessionId: $sessionId, branch: $branch, task: $task} +
       (if $issueNumber != "" then {issueNumber: ($issueNumber | tonumber)} else {} end) +
       (if $slot != "" then {metadata: {slot: ($slot | tonumber)}} else {} end)' 2>/dev/null || true)

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

# ─── 7. Idle slot detection ──────────────────────────────────────────────────────
# When on main with no checklist and no task, signal that this slot is ready for work.
# This makes the post-/agent-reset + /clear experience seamless.

if [ "$BRANCH" = "main" ] && [ ! -f ".claude/wip-checklist.md" ] && [ ! -f ".agent-task" ]; then
  SLOT_LABEL=""
  if [ -n "$SLOT_FROM_DIR" ]; then
    SLOT_LABEL="Slot A${SLOT_FROM_DIR} is "
  fi
  CONTEXT_LINES+=("")
  CONTEXT_LINES+=("═══════════════════════════════════════════════════════")
  CONTEXT_LINES+=("${SLOT_LABEL}idle on main — ready for a new task.")
  CONTEXT_LINES+=("Tell me what to work on, or run /agent-init.")
  CONTEXT_LINES+=("═══════════════════════════════════════════════════════")
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
