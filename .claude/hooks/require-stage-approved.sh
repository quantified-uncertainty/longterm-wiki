#!/usr/bin/env bash
# Block `gh pr merge ...` calls when the target PR lacks the `stage:approved`
# label OR has unresolved Major/Critical CodeRabbit review comments.
# Mirrors PR-patrol's own enqueue-eligibility logic; prevents a coord
# session from shipping un-reviewed work as happened on 2026-04-22 (11
# Major findings landed on main because `gh pr merge --auto` was called
# without checking either gate).
#
# Override (use sparingly, document why):
#   ALLOW_UNAPPROVED_MERGE=1 gh pr merge <N> ...
#
# Exit codes: 0 = allow, 2 = block (Claude reads stderr).

COMMAND="${CLAUDE_TOOL_INPUT:-}"
REPO="quantified-uncertainty/longterm-wiki"

# Match `gh pr merge ...` standalone or via pnpm/npx, but NOT in pipes/quotes
# where it might be discussed (e.g. echo "gh pr merge ...").
# Pattern: optional `pnpm `/`npx ` prefix, then `gh pr merge`, with whitespace boundary.
if ! echo "$COMMAND" | grep -qE '(^|[;&|]|^\s*)(pnpm\s+|npx\s+)?gh\s+pr\s+merge\b'; then
  exit 0
fi

# Override escape hatch — used when the user explicitly authorizes.
if [[ "${ALLOW_UNAPPROVED_MERGE:-}" == "1" ]]; then
  echo "[require-stage-approved] Override: ALLOW_UNAPPROVED_MERGE=1 — skipping label/review checks." >&2
  exit 0
fi

# Extract the PR number. Accept these forms:
#   gh pr merge 1234 [...]
#   gh pr merge https://github.com/owner/repo/pull/1234
#   gh pr merge --auto         (no number → current branch PR; we'll query it)
PR=""
PR=$(echo "$COMMAND" | grep -oE 'gh\s+pr\s+merge\s+[^[:space:]]*[[:space:]]*[0-9]+' | grep -oE '[0-9]+$' | head -1)
if [[ -z "$PR" ]]; then
  PR=$(echo "$COMMAND" | grep -oE 'pull/[0-9]+' | grep -oE '[0-9]+' | head -1)
fi
if [[ -z "$PR" ]]; then
  # No explicit PR — try the current branch's PR via gh.
  PR=$(gh pr view --repo "$REPO" --json number --jq .number 2>/dev/null)
fi

if [[ -z "$PR" ]]; then
  # Couldn't determine PR; let it through and let gh report its own error.
  exit 0
fi

# Query labels + bot review threads in one call.
META=$(gh pr view "$PR" --repo "$REPO" --json labels --jq '[.labels[].name]' 2>/dev/null)
if [[ -z "$META" ]]; then
  echo "[require-stage-approved] Could not fetch PR #$PR metadata — letting through." >&2
  exit 0
fi

# Check 1: stage:approved label.
if ! echo "$META" | grep -q '"stage:approved"'; then
  echo "BLOCKED: PR #$PR is missing the \`stage:approved\` label." >&2
  echo "" >&2
  echo "Coord sessions must not merge PRs without explicit human approval (the" >&2
  echo "label is set by the user, not by agents). PR-patrol follows the same rule." >&2
  echo "" >&2
  echo "Current labels: $META" >&2
  echo "" >&2
  echo "If the user explicitly told you to merge this PR anyway, override with:" >&2
  echo "  ALLOW_UNAPPROVED_MERGE=1 gh pr merge $PR ..." >&2
  echo "" >&2
  echo "See: \$CLAUDE_PROJECT_DIR/.claude/memory/feedback_pr_merge_authority.md" >&2
  exit 2
fi

# Check 2: open CodeRabbit Major / Potential issue review comments.
# The list endpoint returns inline review comments (not PR-level comments).
CR_MAJOR=$(gh api "repos/$REPO/pulls/$PR/comments" --jq \
  '[.[] | select(.user.login == "coderabbitai[bot]") | select(.body | test("Major|Critical|Potential issue"))] | length' \
  2>/dev/null)

if [[ -n "$CR_MAJOR" && "$CR_MAJOR" -gt 0 ]]; then
  echo "BLOCKED: PR #$PR has $CR_MAJOR unresolved CodeRabbit Major/Critical/Potential-issue findings." >&2
  echo "" >&2
  echo "Either address them (push fix commits, then re-merge) or, if they've" >&2
  echo "been verified as already-handled / out-of-scope and the user has" >&2
  echo "approved shipping anyway, override with:" >&2
  echo "  ALLOW_UNAPPROVED_MERGE=1 gh pr merge $PR ..." >&2
  echo "" >&2
  echo "Inspect findings: gh api repos/$REPO/pulls/$PR/comments | jq '.[] | select(.user.login == \"coderabbitai[bot]\")'" >&2
  exit 2
fi

# Both checks pass.
exit 0
