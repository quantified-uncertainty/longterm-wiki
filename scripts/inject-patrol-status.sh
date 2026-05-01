#!/usr/bin/env bash
#
# UserPromptSubmit hook — surfaces abandoned PRs and dead patrol process to
# the coordinator (Opus) on every turn. Silent no-op when patrol is alive
# and no PRs are abandoned.
#
# Patrol abandons a PR after 2 consecutive max-turns or error fixes; it then
# posts "Escalating to coordinator (Opus)" on the PR and skips it on future
# cycles. Without this hook, the coord session has to remember to check the
# patrol log — easy to miss across turn boundaries.
#

set -uo pipefail

STATE_DIR="$HOME/.cache/pr-patrol/state"
CACHE_FILE="/tmp/.patrol-status-open-prs"
CACHE_TTL=300  # 5 min — open-PR list rarely changes faster

# ─── Patrol liveness ──────────────────────────────────────────────────────────
# Match any of:
#   - the patrol process itself (`node ... gh pr-patrol run` or the pnpm parent)
#   - the launchd supervisor in its 30s sleep window between patrol invocations
# Without the supervisor case we'd flap into "patrol dead" reminders every 30s
# whenever launchd-managed patrol is between cycles. The pattern is loose
# (`pr-patrol run`) on purpose — it matches whether the launcher is `pnpm crux`,
# direct `node`, or a future replacement, and `status` in pr-patrol.sh uses
# the same loose pattern for consistency. See QUA-987.
patrol_pid=$(pgrep -f "pr-patrol run" 2>/dev/null | head -1)
if [ -z "$patrol_pid" ]; then
  patrol_pid=$(pgrep -f "pr-patrol-supervisor.sh" 2>/dev/null | head -1)
fi

# ─── Abandoned PR collection ──────────────────────────────────────────────────
abandoned=""
if [ -d "$STATE_DIR" ]; then
  abandoned=$(ls "$STATE_DIR" 2>/dev/null | grep -E '^abandoned-[0-9]+$' | sed 's/^abandoned-//' | tr '\n' ' ')
fi

# Fast exit: nothing to report
if [ -z "$abandoned" ] && [ -n "$patrol_pid" ]; then
  exit 0
fi

# ─── Cross-reference abandoned with currently-open PRs ────────────────────────
open_prs=""
if [ -n "$abandoned" ]; then
  if [ -f "$CACHE_FILE" ]; then
    cache_mtime=$(stat -f %m "$CACHE_FILE" 2>/dev/null || stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0)
    if [ $(($(date +%s) - cache_mtime)) -lt $CACHE_TTL ]; then
      open_prs=$(cat "$CACHE_FILE")
    fi
  fi
  if [ -z "$open_prs" ]; then
    open_prs=$(gh pr list -R quantified-uncertainty/longterm-wiki --state open --json number --jq '.[].number' 2>/dev/null | tr '\n' ' ')
    [ -n "$open_prs" ] && echo "$open_prs" > "$CACHE_FILE"
  fi
fi

still_open_abandoned=""
for pr in $abandoned; do
  if [ -z "$open_prs" ] || echo " $open_prs " | grep -q " $pr "; then
    still_open_abandoned="$still_open_abandoned $pr"
  fi
done
still_open_abandoned=$(echo "$still_open_abandoned" | xargs)

# ─── Emit reminder if anything to report ──────────────────────────────────────
if [ -z "$still_open_abandoned" ] && [ -n "$patrol_pid" ]; then
  exit 0
fi

# Derive the installer path from this script's own location. When deployed
# from a wiki clone, this script lives at <wiki>/scripts/inject-patrol-status.sh
# and the installer lives at <wiki>/scripts/launchd/pr-patrol.sh — siblings
# under scripts/. Hardcoding the user's machine path was wrong both because
# the path included the user's home dir AND because it pointed at the
# now-defunct lw/scripts/launchd/ location instead of lw/main/scripts/launchd/.
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$HOOK_DIR/launchd/pr-patrol.sh"

echo "<system-reminder>"
if [ -z "$patrol_pid" ]; then
  echo "⚠ PR patrol is NOT running."
  if launchctl list 2>/dev/null | grep -q com.qu.pr-patrol; then
    echo "  launchd lists com.qu.pr-patrol but no patrol/supervisor process found —"
    echo "  check ~/.cache/pr-patrol/launchd.err and ~/.cache/pr-patrol/run.log."
    echo "  Status: $INSTALLER status"
  else
    echo "  No launchd agent installed. Either install it (preferred):"
    echo "    $INSTALLER install"
    echo "  …or fall back to a tmux window:"
    echo '    tmux new-window -t 0: -n PATROL -d "while true; do pnpm crux gh pr-patrol run; sleep 30; done 2>&1 | tee -a ~/.cache/pr-patrol/run.log"'
  fi
  echo ""
fi
if [ -n "$still_open_abandoned" ]; then
  n=$(echo "$still_open_abandoned" | wc -w | tr -d ' ')
  formatted=$(echo "$still_open_abandoned" | sed 's/ /, #/g; s/^/#/')
  echo "⚠ $n open PR(s) abandoned by patrol — needs Opus pickup: $formatted"
  echo ""
  echo "Each has a '🤖 PR Patrol — Escalating to coordinator (Opus)' comment. Pick up via worktree + dispatched agent, or close as not-pursuable."
  echo "To clear an abandoned state without acting (e.g. PR is irrelevant): rm $STATE_DIR/abandoned-<PR#>"
fi
echo "</system-reminder>"
