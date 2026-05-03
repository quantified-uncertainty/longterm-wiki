#!/usr/bin/env bash
#
# Stop hook — blocks session end when .claude/wip-checklist.md has unchecked
# items AND the agent's last message signals ship intent. Narrowed to
# ship-intent on purpose: blocking every Stop would force Claude into a
# forced-continue loop on every single assistant turn. Fails open on any
# error — never bricks sessions. See QUA-515.
#

set -uo pipefail

# CODEX_PROJECT_DIR is preferred; CLAUDE_PROJECT_DIR keeps the hook usable in legacy sessions.
REPO_ROOT="${CODEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}}"
CHECKLIST="$REPO_ROOT/.claude/wip-checklist.md"

if [ ! -f "$CHECKLIST" ]; then
  exit 0
fi

# A silent no-op when jq is missing would be a defense-in-depth failure we
# want to know about. Fail open with a loud stderr warning instead.
if ! command -v jq >/dev/null 2>&1; then
  echo "verify-checklist-on-stop: jq not found — hook disabled" >&2
  exit 0
fi

INPUT_JSON=$(cat 2>/dev/null || true)
if [ -z "$INPUT_JSON" ]; then
  exit 0
fi

# Single jq call extracts both fields — saves a subprocess spawn on the
# hot path (this hook fires on every assistant turn).
read -r TRANSCRIPT_PATH STOP_HOOK_ACTIVE < <(echo "$INPUT_JSON" \
  | jq -r '[(.transcript_path // ""), ((.stop_hook_active // false) | tostring)] | @tsv' 2>/dev/null \
  || echo $'\tfalse')

if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  exit 0
fi

# stop_hook_active=true means we already fired in the current forced-continue
# cycle — don't re-block or we risk a loop.
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  exit 0
fi

# Pull the last assistant turn's text from the transcript.
# - `.message.content` may be a string (simple turn) or an array of typed
#   blocks (text, tool_use, thinking, ...). Handle both.
# - `tail -n 500` caps input — long sessions produce tens of MB of JSONL and
#   this hook has a 5s timeout.
# - Filter to non-empty text AFTER the join, so turns that are entirely
#   tool_use (no text) don't shadow the previous real message.
# - Ordering assumption: the triggering assistant turn is written to the
#   transcript before Stop fires. If that's ever wrong, we inspect a stale
#   message and fall through to fail-open — no worse than not having the hook.
LAST_ASSISTANT_TEXT=$(tail -n 500 "$TRANSCRIPT_PATH" 2>/dev/null \
  | jq -rR '
      fromjson?
      | select(.message.role == "assistant")
      | .message.content
      | if type == "string" then .
        elif type == "array" then
          (map(select(.type == "text") | .text // "") | join(" "))
        else "" end
    ' 2>/dev/null \
  | grep -v '^$' \
  | tail -n 1 || true)

if [ -z "$LAST_ASSISTANT_TEXT" ]; then
  exit 0
fi

# Only match the last 600 chars of the message. Ship intent lives in the
# closing paragraph; historical mentions of "the PR" or "ready for review"
# while discussing other work shouldn't trip the hook.
TAIL_TEXT=$(printf '%s' "$LAST_ASSISTANT_TEXT" | tail -c 600)

if ! printf '%s' "$TAIL_TEXT" | grep -iqE '(/agent-ship|/agent-end|ready to (ship|merge|review)|ready for review|shipping (now|the pr)|session (is )?(done|complete)|work is (done|complete)|wrap (this|the session) up|time to ship|pr is (up|ready|open(ed)?)|opened (the )?pr|pushed (and|the) (changes|pr|commit)|committed and pushed|nothing (else|more) to do|all done|all set|pr #[0-9]+)'; then
  exit 0
fi

UNCHECKED=$(awk '
  /^[[:space:]]*[0-9]+\.[[:space:]]+\[ \][[:space:]]+`/ {
    n = split($0, parts, "`")
    if (n >= 3) print parts[2]
  }
' "$CHECKLIST" 2>/dev/null)

if [ -z "$UNCHECKED" ]; then
  exit 0
fi

# Strip angle brackets from slugs before echoing. Stderr on a blocked Stop
# becomes context for the agent's next turn, so a crafted slug with
# `</system-reminder>` could inject instructions otherwise.
SLUG_LIST=$(echo "$UNCHECKED" | tr -d '<>' | paste -sd ',' - | sed 's/,/, /g')
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
