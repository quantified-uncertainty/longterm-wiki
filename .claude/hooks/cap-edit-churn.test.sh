#!/usr/bin/env bash
#
# Smoke test for cap-edit-churn.sh (QUA-1070).
#
# Run from any directory:
#   bash .claude/hooks/cap-edit-churn.test.sh
#
# Exits 0 on success, 1 on first failure. Prints a TAP-ish report.
#

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$REPO_ROOT/.claude/hooks/cap-edit-churn.sh"
TEST_DIR="$(mktemp -d -t cap-edit-churn-test.XXXXXX)"
trap 'rm -rf "$TEST_DIR"' EXIT

if [ ! -x "$HOOK" ]; then
  echo "FAIL: hook not executable at $HOOK" >&2
  exit 1
fi

PASS=0
FAIL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "ok   $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL $label: expected '$expected', got '$actual'" >&2
    FAIL=$((FAIL + 1))
  fi
}

run_hook() {
  # Each call uses a fresh subdir under TEST_DIR so tests are isolated by default.
  # Pass an explicit project dir to override.
  local pdir="$1" payload="$2"
  mkdir -p "$pdir/.claude"
  echo "$payload" | CLAUDE_PROJECT_DIR="$pdir" bash "$HOOK"
}

# ─── Test 1: edits 1-4 silent, edit 5 blocks ────────────────────────────────────
PDIR="$TEST_DIR/t1"
PAYLOAD='{"tool_name":"Edit","tool_input":{"file_path":"/tmp/foo.ts"}}'
for i in 1 2 3 4; do
  run_hook "$PDIR" "$PAYLOAD" >/dev/null 2>&1
  assert_eq "edit $i exits 0" 0 $?
done
OUT=$(run_hook "$PDIR" "$PAYLOAD" 2>&1)
RC=$?
assert_eq "edit 5 exits 2 (cap reached)" 2 $RC
echo "$OUT" | grep -q "edit-churn cap reached" && \
  assert_eq "edit 5 emits revert message" 1 1 || \
  assert_eq "edit 5 emits revert message" 1 0

# ─── Test 2: 6th edit also blocks (cap stays effective) ─────────────────────────
OUT=$(run_hook "$PDIR" "$PAYLOAD" 2>&1)
RC=$?
assert_eq "edit 6 still exits 2" 2 $RC

# ─── Test 3: different files have separate counters ─────────────────────────────
PDIR="$TEST_DIR/t3"
PAYLOAD_A='{"tool_name":"Edit","tool_input":{"file_path":"/tmp/a.ts"}}'
PAYLOAD_B='{"tool_name":"Edit","tool_input":{"file_path":"/tmp/b.ts"}}'
for i in 1 2 3 4; do
  run_hook "$PDIR" "$PAYLOAD_A" >/dev/null 2>&1
done
run_hook "$PDIR" "$PAYLOAD_B" >/dev/null 2>&1
assert_eq "different file edit 1 exits 0" 0 $?
COUNT_B=$(jq -r '.["/tmp/b.ts"]' "$PDIR/.claude/.edit-counts.json")
assert_eq "different file count is 1" "1" "$COUNT_B"

# ─── Test 4: non-Edit tools ignored ─────────────────────────────────────────────
PDIR="$TEST_DIR/t4"
run_hook "$PDIR" '{"tool_name":"Bash","tool_input":{"command":"ls"}}' >/dev/null 2>&1
assert_eq "Bash tool exits 0" 0 $?
[ ! -f "$PDIR/.claude/.edit-counts.json" ] && \
  assert_eq "Bash tool does not create counts file" 1 1 || \
  assert_eq "Bash tool does not create counts file" 1 0

# ─── Test 5: empty file_path ignored ────────────────────────────────────────────
PDIR="$TEST_DIR/t5"
run_hook "$PDIR" '{"tool_name":"Edit","tool_input":{}}' >/dev/null 2>&1
assert_eq "Edit with no file_path exits 0" 0 $?

# ─── Test 6: DISABLE knob bypasses entirely ─────────────────────────────────────
PDIR="$TEST_DIR/t6"
mkdir -p "$PDIR/.claude"
echo '{"/tmp/x.ts": 99}' > "$PDIR/.claude/.edit-counts.json"
PAYLOAD='{"tool_name":"Edit","tool_input":{"file_path":"/tmp/x.ts"}}'
RC=$(echo "$PAYLOAD" | CLAUDE_PROJECT_DIR="$PDIR" CLAUDE_EDIT_CHURN_DISABLE=1 bash "$HOOK" >/dev/null 2>&1; echo $?)
assert_eq "DISABLE=1 exits 0 even over cap" 0 $RC
COUNT=$(jq -r '.["/tmp/x.ts"]' "$PDIR/.claude/.edit-counts.json")
assert_eq "DISABLE=1 does not modify counts" "99" "$COUNT"

# ─── Test 7: configurable cap ──────────────────────────────────────────────────
PDIR="$TEST_DIR/t7"
mkdir -p "$PDIR/.claude"
PAYLOAD='{"tool_name":"Edit","tool_input":{"file_path":"/tmp/y.ts"}}'
for i in 1 2; do
  RC=$(echo "$PAYLOAD" | CLAUDE_PROJECT_DIR="$PDIR" CLAUDE_EDIT_CHURN_CAP=3 bash "$HOOK" >/dev/null 2>&1; echo $?)
  assert_eq "cap=3 edit $i exits 0" 0 $RC
done
RC=$(echo "$PAYLOAD" | CLAUDE_PROJECT_DIR="$PDIR" CLAUDE_EDIT_CHURN_CAP=3 bash "$HOOK" >/dev/null 2>&1; echo $?)
assert_eq "cap=3 edit 3 exits 2" 2 $RC

# ─── Test 8: corrupted state file recovers ──────────────────────────────────────
PDIR="$TEST_DIR/t8"
mkdir -p "$PDIR/.claude"
echo "this is not json {" > "$PDIR/.claude/.edit-counts.json"
PAYLOAD='{"tool_name":"Edit","tool_input":{"file_path":"/tmp/z.ts"}}'
RC=$(echo "$PAYLOAD" | CLAUDE_PROJECT_DIR="$PDIR" bash "$HOOK" >/dev/null 2>&1; echo $?)
assert_eq "corrupted state recovers, exits 0" 0 $RC
COUNT=$(jq -r '.["/tmp/z.ts"]' "$PDIR/.claude/.edit-counts.json")
assert_eq "corrupted state was reset to {}, count is 1" "1" "$COUNT"

# ─── Test 9: empty stdin handled ────────────────────────────────────────────────
PDIR="$TEST_DIR/t9"
mkdir -p "$PDIR/.claude"
RC=$(printf '' | CLAUDE_PROJECT_DIR="$PDIR" bash "$HOOK" >/dev/null 2>&1; echo $?)
assert_eq "empty stdin exits 0" 0 $RC

# ─── Test 10: realistic slot-style path (per QUA-471 lore) ──────────────────────
# QUA-471 was about Claude Code path-derivation bugs in lw/a*/.claude/ paths.
# This hook doesn't derive paths from CWD, so the bug doesn't apply directly,
# but exercise a path-with-dots to confirm.
PDIR="$TEST_DIR/GitHub.nosync/lw/a10"
mkdir -p "$PDIR/.claude"
PAYLOAD='{"tool_name":"Edit","tool_input":{"file_path":"/Users/x/GitHub.nosync/lw/a10/foo.ts"}}'
for i in 1 2 3 4 5; do
  echo "$PAYLOAD" | CLAUDE_PROJECT_DIR="$PDIR" bash "$HOOK" >/dev/null 2>&1
  RC=$?
done
assert_eq "5th edit on dotted-path slot exits 2" 2 $RC
COUNT=$(jq -r '.["/Users/x/GitHub.nosync/lw/a10/foo.ts"]' "$PDIR/.claude/.edit-counts.json")
assert_eq "dotted-path file count is 5" "5" "$COUNT"

# ─── Report ─────────────────────────────────────────────────────────────────────
echo ""
echo "1..$((PASS + FAIL))"
echo "$PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
