#!/usr/bin/env bash
#
# PreToolUse Bash hook — detects cat-polling on dispatched-subagent task
# output files (a wait-for-completion anti-pattern) and forces the agent
# to use Monitor instead. See QUA-1069.
#
# At >= THRESHOLD matched commands in a single session, exits 2 with a
# system-reminder pointing at Monitor with the canonical invocation.
# Earlier matches are silently counted (a one-shot forensic read of a
# task file is fine; the pattern fires on busy-wait).
#
# Patterns matched (representative shapes from the W18 worst-case
# transcript):
#   cat /private/tmp/claude-501/.../tasks/<id>.output
#   cat /tmp/claude-501/.../tasks/<id>.output
#   tail [-f] /tmp/claude-.../tasks/<id>.output
#   stat -f %z /tmp/claude-.../tasks/<id>.output
#
# State: .claude/.poll-counts/<session_id> per-session counter file.
# Slot-local (no /tmp global) — see PR #4812 slot-leak fix.
#
# Fails open on missing jq / unparseable input — never bricks Bash.

set -uo pipefail

REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
COUNTS_DIR="$REPO_ROOT/.claude/.poll-counts"
THRESHOLD=3

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat 2>/dev/null || true)
[ -z "$INPUT" ] && exit 0

# Three jq calls (rather than one @tsv) so we preserve real newlines
# inside .tool_input.command — @tsv encodes embedded newlines as
# literal "\n" which would defeat the head -n1 first-line filter
# below.
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
[ "$TOOL_NAME" = "Bash" ] || exit 0

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""' 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)
[ -z "$COMMAND" ] && exit 0

# Real cat-polls are single-line chained one-liners
# (cat ... ; ps -p N && echo RUN || echo DONE). Multi-line scripts
# and heredocs aren't poll patterns, so look only at the first line —
# this naturally drops heredoc bodies and Python/JS code blocks that
# happen to mention the path shape in a string literal.
#
# Then strip -m "..." / -m '...' quoted args so a git commit message
# describing the bug, or a crux gh pr body, doesn't trip the counter.
# (Same defense pattern as block-no-verify.sh.)
FIRST_LINE=$(echo "$COMMAND" | head -n1)
STRIPPED=$(echo "$FIRST_LINE" \
  | sed -E "s/-m \"[^\"]*\"//g" \
  | sed -E "s/-m '[^']*'//g")

# The signature is the *path shape*, not the verb — we match cat/tail/stat
# (the common waiters) reading a (/private)?/tmp/claude*/.../tasks/<id>.*
# file. Word boundaries on the verb avoid matching e.g. "concat" or random
# subcommands. Allow command-start, pipe, semicolon, &&, or paren before
# the verb so we catch chained polls (`cat ... ; ps -p N`).
POLL_REGEX='(^|[[:space:]|;&(])(cat|tail|stat)([[:space:]]+-[^[:space:]]+)*[[:space:]]+[^|;&]*(/private)?/tmp/claude[-_][^[:space:]]*/tasks/[^[:space:]|;&)>]+'

echo "$STRIPPED" | grep -qE "$POLL_REGEX" || exit 0

mkdir -p "$COUNTS_DIR" 2>/dev/null || exit 0

# UUIDs are safe but defense-in-depth: filenames cannot escape the dir.
SAFE_ID=$(printf '%s' "$SESSION_ID" | tr -cd 'a-zA-Z0-9-')
[ -n "$SAFE_ID" ] || exit 0
COUNT_FILE="$COUNTS_DIR/$SAFE_ID"

CURRENT=$(cat "$COUNT_FILE" 2>/dev/null | tr -d '[:space:]' || true)
[[ "$CURRENT" =~ ^[0-9]+$ ]] || CURRENT=0
NEW=$((CURRENT + 1))
echo "$NEW" > "$COUNT_FILE"

if [ "$NEW" -lt "$THRESHOLD" ]; then
  exit 0
fi

# Strip angle brackets from anything we echo in the reminder body (defense
# against a hypothetical session_id or command containing </system-reminder>
# fragments). The command itself isn't echoed back, but be safe with the count.
SAFE_NEW=$(printf '%s' "$NEW" | tr -d '<>')

cat >&2 <<EOF
BLOCKED: subagent task-output cat-polling detected ($SAFE_NEW occurrences this session, threshold=$THRESHOLD).

This is the polling anti-pattern: when waiting on a dispatched subagent
or background process, agents reach for repeated 'cat /tmp/.../tasks/*.output'
instead of streaming the output. The W18 simulation showed this wastes
5-16% of bash calls in long sessions; one session burned 143 cat-polls in
325 minutes.

Use Monitor instead — it streams stdout events as they happen, with no
busy-wait. If Monitor's schema isn't loaded yet, fetch it first:

  ToolSearch({ query: "select:Monitor", max_results: 1 })

Then call Monitor with the target you were polling and a predicate that
matches your exit condition. For 'wait until done', the runtime emits one
event per stdout line and resolves when the loop exits.

If you genuinely need a one-shot forensic read of a finished task file,
that's fine — the counter only fires on the third occurrence in a
session. To unblock the current call, switch to Monitor.

See .claude/rules/wait-on-subagents.md for the full pattern guide and
QUA-1069 for the data behind this hook.
EOF
exit 2
