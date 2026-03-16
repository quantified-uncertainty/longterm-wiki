#!/usr/bin/env bash
#
# matrix-multi-slot.sh — Orchestrate parallel matrix improvement loops across agent slots
#
# Assigns different matrix dimensions or entity types to separate agent slots,
# then launches matrix-loop.sh in each via tmux for parallel content improvement.
#
# Usage:
#   ./scripts/matrix-multi-slot.sh [OPTIONS]
#
# Options:
#   --slots=1,2,3            Agent slots to use (default: 1,2,3)
#   --strategy=by-dimension  How to split work: by-dimension | by-type (default: by-dimension)
#   --iterations=N           Max iterations per slot (default: 5)
#   --tier=TIER              Content improve tier: polish | standard | deep (default: standard)
#   --dry-run                Show what would be launched without executing
#   --help, -h               Show this help
#
# Strategies:
#   by-dimension   Assign one matrix dimension per slot:
#                    Slot 1 -> content (improve low-quality/short/stale pages)
#                    Slot 2 -> coverage (fill missing coverage items)
#                    Slot 3 -> quality (re-ranking + grading)
#                  Extra slots beyond 3 get the 'all' dimension.
#
#   by-type        Find the lowest-scoring entity types and assign one per slot.
#                  Uses `crux matrix scores` to rank types by content score and
#                  distributes the worst-scoring types round-robin across slots.
#
# Prerequisites:
#   - Agent slots must exist (../aN/ directories, set up via `crux agent-workspace setup N`)
#   - database.json must exist in each slot (run `pnpm build-data:content` first)
#   - tmux session must be active
#   - ANTHROPIC_API_KEY must be set for content improve
#
# Examples:
#   ./scripts/matrix-multi-slot.sh                                # default: 3 slots, by-dimension
#   ./scripts/matrix-multi-slot.sh --slots=1,2 --strategy=by-type
#   ./scripts/matrix-multi-slot.sh --slots=1,2,3,4 --tier=deep --iterations=3
#   ./scripts/matrix-multi-slot.sh --dry-run                      # preview only
#

set -euo pipefail

# ---------------------------------------------------------------------------
# Colors & helpers
# ---------------------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

info()  { echo -e "  ${BLUE}▸${RESET} $1"; }
ok()    { echo -e "  ${GREEN}✓${RESET} $1"; }
warn()  { echo -e "  ${YELLOW}⚠${RESET} $1"; }
err()   { echo -e "  ${RED}✗${RESET} $1"; }

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

SLOTS="1,2,3"
STRATEGY="by-dimension"
MAX_ITERATIONS="5"
TIER="standard"
DRY_RUN=false

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------

for arg in "$@"; do
  case "$arg" in
    --slots=*)       SLOTS="${arg#*=}" ;;
    --strategy=*)    STRATEGY="${arg#*=}" ;;
    --iterations=*)  MAX_ITERATIONS="${arg#*=}" ;;
    --tier=*)        TIER="${arg#*=}" ;;
    --dry-run)       DRY_RUN=true ;;
    --help|-h)
      # Print the header comment block as usage
      sed -n '2,/^$/{ s/^# \?//; p; }' "$0"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown argument: $arg${RESET}"
      echo "Run with --help for usage."
      exit 1
      ;;
  esac
done

# Validate strategy
if [[ "$STRATEGY" != "by-dimension" && "$STRATEGY" != "by-type" ]]; then
  echo -e "${RED}Error: --strategy must be 'by-dimension' or 'by-type'${RESET}"
  exit 1
fi

# Validate tier
if [[ "$TIER" != "polish" && "$TIER" != "standard" && "$TIER" != "deep" ]]; then
  echo -e "${RED}Error: --tier must be 'polish', 'standard', or 'deep'${RESET}"
  exit 1
fi

# Validate iterations is a number
if ! [[ "$MAX_ITERATIONS" =~ ^[0-9]+$ ]]; then
  echo -e "${RED}Error: --iterations must be a positive integer${RESET}"
  exit 1
fi

# Parse slot numbers into an array
IFS=',' read -ra SLOT_NUMS <<< "$SLOTS"

if [ "${#SLOT_NUMS[@]}" -eq 0 ]; then
  echo -e "${RED}Error: no slots specified${RESET}"
  exit 1
fi

# ---------------------------------------------------------------------------
# Resolve directories
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# Agent slots live at ../aN/ relative to the repo root (i.e., sibling dirs under lw/)
LW_DIR="$(cd "$PROJECT_ROOT/.." && pwd)"
DATE_TAG=$(date +%Y%m%d)

echo -e "${BOLD}Matrix Multi-Slot Orchestrator${RESET}"
echo -e "${DIM}Strategy: $STRATEGY | Slots: ${SLOTS} | Iterations: $MAX_ITERATIONS | Tier: $TIER${RESET}"
if $DRY_RUN; then
  echo -e "${YELLOW}${BOLD}DRY RUN — nothing will be launched${RESET}"
fi
echo ""

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------

echo -e "${BOLD}Checking prerequisites...${RESET}"

ERRORS=0

# tmux
if [ -z "${TMUX:-}" ] && ! $DRY_RUN; then
  err "Not inside a tmux session. tmux is required to launch background loops."
  ERRORS=$((ERRORS + 1))
fi

# Check each slot directory exists
for SLOT in "${SLOT_NUMS[@]}"; do
  SLOT_DIR="${LW_DIR}/a${SLOT}"
  if [ ! -d "$SLOT_DIR" ]; then
    err "Slot a${SLOT} not found at ${SLOT_DIR}"
    echo -e "    ${DIM}Run: pnpm crux agent-workspace setup ${SLOT}${RESET}"
    ERRORS=$((ERRORS + 1))
  elif [ ! -f "${SLOT_DIR}/.agent-slot" ]; then
    err "Slot a${SLOT} exists but has no .agent-slot file — may not be initialized"
    ERRORS=$((ERRORS + 1))
  else
    ok "Slot a${SLOT} exists at ${SLOT_DIR}"

    # Check database.json
    if [ ! -f "${SLOT_DIR}/apps/web/src/data/database.json" ]; then
      warn "Slot a${SLOT} is missing database.json — run 'pnpm build-data:content' in that slot first"
    fi
  fi
done

# Check matrix-loop.sh exists (used by by-dimension strategy)
if [ "$STRATEGY" = "by-dimension" ] && [ ! -f "${SCRIPT_DIR}/matrix-loop.sh" ]; then
  err "matrix-loop.sh not found at ${SCRIPT_DIR}/matrix-loop.sh"
  ERRORS=$((ERRORS + 1))
fi

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  err "Cannot proceed — $ERRORS error(s) found. Fix them and re-run."
  exit 1
fi

echo ""

# ---------------------------------------------------------------------------
# Dimension assignments (ordered by priority)
# ---------------------------------------------------------------------------

DIMENSIONS=("content" "coverage" "quality" "all")

# ---------------------------------------------------------------------------
# Build slot assignment table
# ---------------------------------------------------------------------------

# Arrays to track assignments (parallel arrays indexed by position in SLOT_NUMS)
declare -a ASSIGN_LABELS=()    # Human-readable label for the status table
declare -a ASSIGN_BRANCHES=()  # Branch name to create
declare -a ASSIGN_COMMANDS=()  # Command to send via tmux

if [ "$STRATEGY" = "by-dimension" ]; then
  echo -e "${BOLD}Strategy: by-dimension${RESET}"
  echo -e "${DIM}Assigning matrix dimensions to slots...${RESET}"
  echo ""

  for i in "${!SLOT_NUMS[@]}"; do
    SLOT="${SLOT_NUMS[$i]}"
    # Cycle through dimensions; slots beyond the dimension list get 'all'
    if [ "$i" -lt "${#DIMENSIONS[@]}" ]; then
      DIM_NAME="${DIMENSIONS[$i]}"
    else
      DIM_NAME="all"
    fi

    BRANCH="claude/matrix-${DIM_NAME}-${DATE_TAG}"
    SLOT_DIR="${LW_DIR}/a${SLOT}"

    ASSIGN_LABELS+=("${DIM_NAME} dimension")
    ASSIGN_BRANCHES+=("${BRANCH}")
    # Switch to the slot dir, create/checkout branch, then run matrix-loop.sh
    ASSIGN_COMMANDS+=("cd '${SLOT_DIR}' && git checkout -b '${BRANCH}' 2>/dev/null || git checkout '${BRANCH}' && ./scripts/matrix-loop.sh ${MAX_ITERATIONS} ${DIM_NAME} ${TIER}")
  done

elif [ "$STRATEGY" = "by-type" ]; then
  echo -e "${BOLD}Strategy: by-type${RESET}"
  echo -e "${DIM}Querying matrix scores to find lowest-scoring entity types...${RESET}"
  echo ""

  # Get entity types sorted by content score (ascending = worst first).
  # Uses the current project root's crux to query the matrix.
  TYPES_JSON=$(cd "$PROJECT_ROOT" && pnpm --silent crux matrix scores --ci 2>/dev/null || echo "[]")

  # Extract type names sorted by contentScore ascending, take as many as we have slots.
  # Filters to types with >= 3 pages to avoid tiny categories.
  NUM_SLOTS="${#SLOT_NUMS[@]}"
  WORST_TYPES=$(echo "$TYPES_JSON" | node -e "
    process.stdin.setEncoding('utf8');
    let d = '';
    process.stdin.on('data', c => d += c);
    process.stdin.on('end', () => {
      try {
        const types = JSON.parse(d);
        const sorted = types
          .filter(t => t.pageCount >= 3)
          .sort((a, b) => a.contentScore - b.contentScore)
          .slice(0, ${NUM_SLOTS});
        console.log(sorted.map(t => t.type + ':' + t.contentScore + ':' + t.pageCount).join('\n'));
      } catch(e) {
        console.error('Failed to parse matrix scores:', e.message);
        process.exit(1);
      }
    });
  ")

  if [ -z "$WORST_TYPES" ]; then
    err "Could not determine entity types from matrix scores."
    echo -e "  ${DIM}Make sure database.json is built: pnpm build-data:content${RESET}"
    exit 1
  fi

  # Read types into an array
  readarray -t TYPE_ENTRIES <<< "$WORST_TYPES"

  info "Lowest-scoring entity types (assigned to slots):"
  for entry in "${TYPE_ENTRIES[@]}"; do
    IFS=':' read -r TYPE_NAME TYPE_SCORE TYPE_COUNT <<< "$entry"
    echo -e "    ${RED}${TYPE_NAME}${RESET} — score: ${TYPE_SCORE}, pages: ${TYPE_COUNT}"
  done
  echo ""

  for i in "${!SLOT_NUMS[@]}"; do
    SLOT="${SLOT_NUMS[$i]}"
    SLOT_DIR="${LW_DIR}/a${SLOT}"

    if [ "$i" -lt "${#TYPE_ENTRIES[@]}" ]; then
      IFS=':' read -r TYPE_NAME TYPE_SCORE TYPE_COUNT <<< "${TYPE_ENTRIES[$i]}"
    else
      # More slots than types — assign 'all' as fallback
      TYPE_NAME="mixed"
      TYPE_SCORE="-"
      TYPE_COUNT="-"
    fi

    BRANCH="claude/matrix-type-${TYPE_NAME}-${DATE_TAG}"

    if [ "$TYPE_NAME" = "mixed" ]; then
      ASSIGN_LABELS+=("all types (overflow)")
      ASSIGN_BRANCHES+=("claude/matrix-all-${DATE_TAG}")
      ASSIGN_COMMANDS+=("cd '${SLOT_DIR}' && git checkout -b 'claude/matrix-all-${DATE_TAG}' 2>/dev/null || git checkout 'claude/matrix-all-${DATE_TAG}' && ./scripts/matrix-loop.sh ${MAX_ITERATIONS} content ${TIER}")
    else
      ASSIGN_LABELS+=("type: ${TYPE_NAME} (score: ${TYPE_SCORE})")
      ASSIGN_BRANCHES+=("${BRANCH}")
      # For by-type, we construct a custom inline loop that filters by entity type.
      # matrix-loop.sh uses next-task which does not support --type filtering,
      # so we get page IDs via `matrix pages --type=X --format=ids` and then
      # run the improve pipeline on each.
      ASSIGN_COMMANDS+=("cd '${SLOT_DIR}' && git checkout -b '${BRANCH}' 2>/dev/null || git checkout '${BRANCH}' && MATRIX_ENTITY_TYPE='${TYPE_NAME}' MATRIX_ITERATIONS='${MAX_ITERATIONS}' MATRIX_TIER='${TIER}' bash -c '"'
        TYPE="$MATRIX_ENTITY_TYPE"
        ITERATIONS="$MATRIX_ITERATIONS"
        TIER="$MATRIX_TIER"
        echo "Matrix loop for entity type: $TYPE ($ITERATIONS iterations, tier: $TIER)"
        IDS=$(pnpm --silent crux matrix pages --type="$TYPE" --format=ids --limit="$ITERATIONS" 2>/dev/null)
        if [ -z "$IDS" ]; then
          echo "No pages found for type: $TYPE"
          exit 0
        fi
        IFS="," read -ra PAGE_IDS <<< "$IDS"
        SUCCEEDED=0; FAILED=0; TOTAL=${#PAGE_IDS[@]}
        for idx in "${!PAGE_IDS[@]}"; do
          PID="${PAGE_IDS[$idx]}"
          echo "--- Iteration $((idx+1))/$TOTAL: $PID ---"
          if pnpm crux content improve "$PID" --tier="$TIER" --apply --skip-session-log 2>&1; then
            pnpm crux fix escaping 2>&1 || true
            pnpm crux fix markdown 2>&1 || true
            if pnpm crux validate gate --fix 2>&1; then
              git add -A && git commit -m "Improve $PID via matrix loop (type: $TYPE, tier: $TIER)" --quiet
              echo "Committed $PID"
              SUCCEEDED=$((SUCCEEDED + 1))
            else
              echo "Gate failed for $PID, reverting"
              git checkout -- . 2>/dev/null || true
              FAILED=$((FAILED + 1))
            fi
          else
            echo "Improve failed for $PID, skipping"
            FAILED=$((FAILED + 1))
          fi
          if [ $((idx+1)) -lt "$TOTAL" ]; then
            pnpm build-data:content 2>&1 | tail -1 || true
          fi
        done
        echo "Done: $SUCCEEDED succeeded, $FAILED failed out of $TOTAL"
      '"'")
    fi
  done
fi

# ---------------------------------------------------------------------------
# Launch (or dry-run)
# ---------------------------------------------------------------------------

echo -e "${BOLD}Launching loops...${RESET}"
echo ""

for i in "${!SLOT_NUMS[@]}"; do
  SLOT="${SLOT_NUMS[$i]}"
  LABEL="${ASSIGN_LABELS[$i]}"
  BRANCH="${ASSIGN_BRANCHES[$i]}"
  CMD="${ASSIGN_COMMANDS[$i]}"
  WINDOW_NAME="A${SLOT}:matrix"

  if $DRY_RUN; then
    echo -e "  ${DIM}[dry-run]${RESET} Slot a${SLOT} -> ${LABEL}"
    echo -e "           ${DIM}Branch: ${BRANCH}${RESET}"
    echo -e "           ${DIM}Window: ${WINDOW_NAME}${RESET}"
  else
    # Create a new tmux window for this slot and send the command
    tmux new-window -n "$WINDOW_NAME" -d 2>/dev/null || true
    tmux send-keys -t "$WINDOW_NAME" "$CMD" Enter
    ok "Slot a${SLOT} -> ${LABEL} (window: ${WINDOW_NAME})"
  fi
done

# ---------------------------------------------------------------------------
# Status table
# ---------------------------------------------------------------------------

echo ""
echo -e "${BOLD}+------------------------------------------------------------------+${RESET}"
echo -e "${BOLD}|  Matrix Multi-Slot Summary                                       |${RESET}"
echo -e "${BOLD}+--------+------------------------------+-------------------------+${RESET}"
printf  "${BOLD}|${RESET} %-6s ${BOLD}|${RESET} %-28s ${BOLD}|${RESET} %-23s ${BOLD}|${RESET}\n" "Slot" "Assignment" "Branch"
echo -e "${BOLD}+--------+------------------------------+-------------------------+${RESET}"

for i in "${!SLOT_NUMS[@]}"; do
  SLOT="a${SLOT_NUMS[$i]}"
  LABEL="${ASSIGN_LABELS[$i]}"
  BRANCH="${ASSIGN_BRANCHES[$i]}"
  # Truncate branch for display (remove claude/ prefix for readability)
  SHORT_BRANCH="${BRANCH#claude/}"
  printf "${BOLD}|${RESET} %-6s ${BOLD}|${RESET} %-28s ${BOLD}|${RESET} %-23s ${BOLD}|${RESET}\n" "$SLOT" "$LABEL" "$SHORT_BRANCH"
done

echo -e "${BOLD}+--------+------------------------------+-------------------------+${RESET}"
printf  "${BOLD}|${RESET} Iterations: %-4s  Tier: %-10s  Strategy: %-14s ${BOLD}|${RESET}\n" "$MAX_ITERATIONS" "$TIER" "$STRATEGY"
echo -e "${BOLD}+------------------------------------------------------------------+${RESET}"

if $DRY_RUN; then
  echo ""
  echo -e "${YELLOW}Dry run complete. Remove --dry-run to launch.${RESET}"
else
  echo ""
  echo -e "${DIM}Monitor progress:${RESET}"
  echo -e "  tmux list-windows                # see all windows"
  echo -e "  tmux select-window -t A1:matrix  # switch to slot 1"
  echo -e "  pnpm crux agent-workspace list   # slot branch/PR status"
fi
