#!/usr/bin/env bash
#
# Stop hook — blocks session end when .claude/wip-checklist.md has unchecked
# items AND the agent's last message signals ship intent.
#
# Why: /agent-ship verifies the checklist as part of the ship workflow, but
# nothing catches the path where the agent tries to END the session WITHOUT
# going through /agent-ship (announcing "ready to ship", /agent-end, etc.).
# This hook is the second line of defense for QUA-515.
#
# Why not block every Stop unconditionally: Stop fires after every assistant
# turn, not just at session-end. Blocking every Stop would force Claude into
# a forced-continue loop on every single turn — agent would never yield to
# the user until the checklist was 100% clear. Far too aggressive.
#
# Instead, we narrow to ship-intent: only block if the agent's final message
# contains language suggesting it's trying to wrap the session (ship, done,
# ready, /agent-ship, /agent-end, "ready to ship", etc.). That's the exact
# moment /agent-ship verification would fire, so the hook catches the same
# class of bypass without the turn-by-turn overhead.
#
# Fail-open: any error reading the transcript or checklist → allow the stop.
# We never brick sessions.
#

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECKLIST="$REPO_ROOT/.claude/wip-checklist.md"

# No checklist → allow. Sessions without /agent-init shouldn't trip.
if [ ! -f "$CHECKLIST" ]; then
  exit 0
fi

# Read hook input JSON. The Stop hook receives transcript_path (JSONL file
# with the conversation) via stdin. Parse defensively — if stdin is empty or
# malformed, fail open.
INPUT_JSON=$(cat 2>/dev/null || true)
if [ -z "$INPUT_JSON" ]; then
  exit 0
fi

TRANSCRIPT_PATH=$(echo "$INPUT_JSON" | jq -r '.transcript_path // empty' 2>/dev/null || true)
if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  exit 0
fi

# If stop_hook_active is true, this hook has already fired in the current
# forced-continue cycle — don't re-block or we risk a loop.
STOP_HOOK_ACTIVE=$(echo "$INPUT_JSON" | jq -r '.stop_hook_active // false' 2>/dev/null || echo "false")
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  exit 0
fi

# Pull the text of the last assistant turn from the JSONL transcript. Claude
# Code writes one message per line. We filter to assistant messages and take
# the last non-empty one (macOS has no `tac`, so filter-then-tail).
LAST_ASSISTANT_TEXT=$(jq -rR 'fromjson? | select(.message.role == "assistant") | .message.content // [] | map(select(.type == "text") | .text // "") | join(" ")' "$TRANSCRIPT_PATH" 2>/dev/null \
  | grep -v '^$' \
  | tail -n 1 || true)

# If we can't find an assistant message, fail open. Transcript may be empty
# (first-turn) or in a different format.
if [ -z "$LAST_ASSISTANT_TEXT" ]; then
  exit 0
fi

# Detect ship intent. Case-insensitive, word-boundary-ish match against a
# compact list of phrases agents commonly use when trying to wrap the session.
# Deliberately narrow — false positives here cause turn-by-turn blocking,
# which is exactly what we're avoiding.
if ! echo "$LAST_ASSISTANT_TEXT" | grep -iqE '(/agent-ship|/agent-end|ready to ship|ready to merge|ready for review|shipping (now|the pr)|session (is )?(done|complete)|work is (done|complete)|wrap (this|the session) up|time to ship)'; then
  exit 0
fi

# Ship intent detected. Now check the checklist.
UNCHECKED=$(awk '
  /^[[:space:]]*[0-9]+\.[[:space:]]+\[ \][[:space:]]+`/ {
    n = split($0, parts, "`")
    if (n >= 3) print parts[2]
  }
' "$CHECKLIST" 2>/dev/null)

if [ -z "$UNCHECKED" ]; then
  exit 0
fi

SLUG_LIST=$(echo "$UNCHECKED" | paste -sd ',' - | sed 's/,/, /g')
COUNT=$(echo "$UNCHECKED" | wc -l | tr -d '[:space:]')

cat >&2 <<EOF
BLOCKED: Your last message signals the session is ready to wrap up, but the
session checklist has $COUNT unchecked item(s):

  $SLUG_LIST

Before ending the session, do ONE of the following:
  1. Work through each item, then mark it [x] in .claude/wip-checklist.md
  2. Mark items N/A with a justification — change "[ ]" to "[~]" and add
     "<!-- N/A: <reason> -->" on the same line
  3. Run /agent-ship — it performs this same verification with more context
     and runs the full review + push + CI flow
  4. If you're abandoning the session, run /agent-end — it marks unchecked
     items as abandoned with the reason and removes the local checklist

See QUA-515 for why this hook exists. Do NOT mark items [x] without
actually doing them — the checklist is the only gate that catches review,
test, and security gaps before they ship.
EOF
exit 2
