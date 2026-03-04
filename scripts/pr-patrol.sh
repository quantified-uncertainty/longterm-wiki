#!/usr/bin/env bash
set -euo pipefail

# PR Patrol — Continuous PR maintenance daemon
# Uses Claude Code subscription via `claude -p` for fixes
#
# Usage:
#   ./scripts/pr-patrol.sh                    # Run continuously (5 min interval)
#   ./scripts/pr-patrol.sh --once             # Single pass, then exit
#   ./scripts/pr-patrol.sh --dry-run          # Show what would be done, don't fix
#   ./scripts/pr-patrol.sh --interval=120     # Custom interval (seconds)
#   ./scripts/pr-patrol.sh --max-turns=25     # More turns for complex fixes
#
# Environment variables (all optional):
#   PR_PATROL_INTERVAL     Seconds between checks (default: 300)
#   PR_PATROL_MAX_TURNS    Max Claude turns per fix (default: 20)
#   PR_PATROL_COOLDOWN     Don't re-process same PR within N seconds (default: 1800)
#   PR_PATROL_STALE_HOURS  Hours before a PR is considered stale (default: 48)
#   PR_PATROL_MODEL        Claude model to use (default: sonnet)
#   PR_PATROL_REPO         GitHub repo (default: quantified-uncertainty/longterm-wiki)
#   PR_PATROL_SKIP_PERMS   Set to "1" to add --dangerously-skip-permissions

REPO="${PR_PATROL_REPO:-quantified-uncertainty/longterm-wiki}"
INTERVAL="${PR_PATROL_INTERVAL:-300}"
MAX_TURNS="${PR_PATROL_MAX_TURNS:-20}"
COOLDOWN="${PR_PATROL_COOLDOWN:-1800}"
STALE_HOURS="${PR_PATROL_STALE_HOURS:-48}"
MODEL="${PR_PATROL_MODEL:-sonnet}"
SKIP_PERMS="${PR_PATROL_SKIP_PERMS:-0}"

STATE_DIR="/tmp/pr-patrol-shared"
LOG_FILE="${STATE_DIR}/patrol.log"
ONCE=false
DRY_RUN=false

# Parse CLI flags
for arg in "$@"; do
  case "$arg" in
    --once) ONCE=true ;;
    --dry-run) DRY_RUN=true ;;
    --interval=*) INTERVAL="${arg#*=}" ;;
    --max-turns=*) MAX_TURNS="${arg#*=}" ;;
    --cooldown=*) COOLDOWN="${arg#*=}" ;;
    --model=*) MODEL="${arg#*=}" ;;
    --help|-h)
      echo "PR Patrol — Continuous PR maintenance daemon"
      echo ""
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --once            Single pass, then exit"
      echo "  --dry-run         Show what would be done, don't fix"
      echo "  --interval=N      Seconds between checks (default: 300)"
      echo "  --max-turns=N     Max Claude turns per fix (default: 20)"
      echo "  --cooldown=N      Skip recently-processed PRs for N seconds (default: 1800)"
      echo "  --model=MODEL     Claude model (default: sonnet)"
      echo "  -h, --help        Show this help"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)"
      exit 1
      ;;
  esac
done

mkdir -p "$STATE_DIR"

# ─── Logging ───────────────────────────────────────────────────────────

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$msg" >&2
  echo "$msg" >> "$LOG_FILE"
}

log_header() {
  echo ""
  log "═══════════════════════════════════════════════════════"
  log "$1"
  log "═══════════════════════════════════════════════════════"
}

# ─── Cooldown tracking ────────────────────────────────────────────────

was_recently_processed() {
  local pr_num=$1
  local stamp_file="$STATE_DIR/processed-$pr_num"
  if [[ -f "$stamp_file" ]]; then
    local last
    last=$(cat "$stamp_file")
    local now
    now=$(date +%s)
    if (( now - last < COOLDOWN )); then
      return 0
    fi
  fi
  return 1
}

mark_processed() {
  local pr_num=$1
  date +%s >| "$STATE_DIR/processed-$pr_num"
}

# ─── PR Detection ────────────────────────────────────────────────────

detect_all_pr_issues() {
  # Fetch all open PRs with relevant fields
  local prs
  prs=$(gh pr list --repo "$REPO" --state open --limit 50 \
    --json number,title,headRefName,mergeable,mergedAt,statusCheckRollup,updatedAt,body,labels 2>/dev/null) || {
    log "ERROR: Failed to fetch PR list"
    return 1
  }

  local pr_count
  pr_count=$(echo "$prs" | jq 'length')
  log "Found $pr_count open PRs"

  if [[ "$pr_count" == "0" ]]; then
    return 0
  fi

  # Calculate stale threshold (epoch seconds)
  local stale_threshold
  stale_threshold=$(date -v-"${STALE_HOURS}"H +%s 2>/dev/null || date -d "${STALE_HOURS} hours ago" +%s 2>/dev/null || echo 0)

  # Process each PR and detect issues
  echo "$prs" | jq -r --arg stale "$stale_threshold" '
    .[] |
    # Skip already-merged PRs (GitHub API can lag on state updates)
    select(.mergedAt == null) |
    # Detect issues
    [
      (if .mergeable == "CONFLICTING" then "conflict" else empty end),
      (if ([(.statusCheckRollup // [])[] | select(.conclusion == "FAILURE")] | length) > 0
       then "ci-failure" else empty end),
      (if (.body // "" | test("## Test [Pp]lan") | not) then "missing-testplan" else empty end),
      (if (.body // "" | test("(Closes|Fixes|Resolves) #[0-9]") | not) then "missing-issue-ref" else empty end),
      (if (.labels // [] | map(.name) | any(. == "claude-working"))
       then "in-progress" else empty end)
    ] as $issues |
    # Skip PRs with no issues (other than in-progress)
    ($issues | map(select(. != "in-progress"))) as $actionable |
    select($actionable | length > 0) |
    # Skip PRs currently being worked on
    select($issues | any(. == "in-progress") | not) |
    "\(.number)\t\($actionable | join(","))\t\(.title)\t\(.headRefName)"
  ' 2>/dev/null || true
}

# Check for unresolved review comments (per-PR, more expensive)
check_review_comments() {
  local pr_num=$1
  local reviews
  reviews=$(gh pr view "$pr_num" --repo "$REPO" --json reviews,reviewRequests 2>/dev/null) || return 1

  local changes_requested
  changes_requested=$(echo "$reviews" | jq '[.reviews[] | select(.state == "CHANGES_REQUESTED")] | length')

  if [[ "$changes_requested" -gt 0 ]]; then
    echo "review-changes-requested"
  fi
}

# ─── Priority Scoring ────────────────────────────────────────────────

priority_score() {
  local issues=$1
  local score=0
  [[ "$issues" == *conflict* ]]                   && score=$((score + 100))
  [[ "$issues" == *ci-failure* ]]                  && score=$((score + 80))
  [[ "$issues" == *review-changes-requested* ]]    && score=$((score + 70))
  [[ "$issues" == *missing-issue-ref* ]]           && score=$((score + 40))
  [[ "$issues" == *stale* ]]                       && score=$((score + 30))
  [[ "$issues" == *missing-testplan* ]]            && score=$((score + 20))
  echo "$score"
}

# ─── Fix a PR using Claude Code ──────────────────────────────────────

build_prompt() {
  local pr_num=$1
  local issues=$2
  local title=$3
  local branch=$4

  local prompt=""
  prompt+="You are a PR maintenance agent for the longterm-wiki repository (quantified-uncertainty/longterm-wiki)."
  prompt+=$'\n\n## Target'
  prompt+=$'\nPR #'"${pr_num}"': "'"${title}"'" (branch: '"${branch}"')'
  prompt+=$'\n\n## Issues Detected'
  prompt+=$'\n'"${issues}"
  prompt+=$'\n\n## Instructions'
  prompt+=$'\n\n1. First, fetch PR details to understand context:'
  prompt+=$'\n   gh pr view '"${pr_num}"' --json headRefName,body,statusCheckRollup,reviews'
  prompt+=$'\n\n2. Check out the PR branch:'
  prompt+=$'\n   git fetch origin '"${branch}"
  prompt+=$'\n   git checkout '"${branch}"
  prompt+=$'\n\n3. Fix each detected issue:'

  if [[ "$issues" == *conflict* ]]; then
    prompt+=$'\n\n### Merge Conflict'
    prompt+=$'\n- Rebase onto main: git rebase origin/main'
    prompt+=$'\n- Resolve any conflicts (prefer keeping PR changes where intent is clear)'
    prompt+=$'\n- If conflicts are in generated files (database.json, lock files), regenerate them'
    prompt+=$'\n- After resolving: git rebase --continue, then git push --force-with-lease'
  fi

  if [[ "$issues" == *ci-failure* ]]; then
    prompt+=$'\n\n### CI Failure'
    prompt+=$'\n- Check CI status: gh pr checks '"${pr_num}"' --repo quantified-uncertainty/longterm-wiki'
    prompt+=$'\n- Read the failing check logs to understand the failure'
    prompt+=$'\n- Fix the issue (build error, test failure, lint error)'
    prompt+=$'\n- Run locally to verify: pnpm build and/or pnpm test'
    prompt+=$'\n- Commit and push the fix'
  fi

  if [[ "$issues" == *missing-testplan* ]]; then
    prompt+=$'\n\n### Missing Test Plan'
    prompt+=$'\n- Read the PR diff to understand what changed'
    prompt+=$'\n- Update the PR body to add a "## Test plan" section with relevant verification steps'
    prompt+=$'\n- Use gh pr edit to update the body'
  fi

  if [[ "$issues" == *missing-issue-ref* ]]; then
    prompt+=$'\n\n### Missing Issue Reference'
    prompt+=$'\n- Search for related issues: gh issue list --search "keywords from PR title" --repo quantified-uncertainty/longterm-wiki'
    prompt+=$'\n- If a matching issue exists, add "Closes #N" to the PR body'
    prompt+=$'\n- If no matching issue exists, this may be fine — skip this fix'
  fi

  if [[ "$issues" == *review-changes-requested* ]]; then
    prompt+=$'\n\n### Review Changes Requested'
    prompt+=$'\n- Read the review comments: gh pr view '"${pr_num}"' --comments'
    prompt+=$'\n- Address each comment by making the requested changes'
    prompt+=$'\n- Commit and push the fixes'
    prompt+=$'\n- Do NOT dismiss the review — let the reviewer re-approve'
  fi

  prompt+=$'\n\n## Guardrails'
  prompt+=$'\n- Only fix the detected issues — do not refactor or improve unrelated code'
  prompt+=$'\n- If a conflict is too complex to resolve confidently, skip it and note why'
  prompt+=$'\n- After any code changes, run: pnpm crux validate gate --fix'
  prompt+=$'\n- Use git push --force-with-lease (never --force) when pushing rebased branches'
  prompt+=$'\n- Do not modify files unrelated to the fix'

  echo "$prompt"
}

fix_pr() {
  local pr_num=$1
  local issues=$2
  local title=$3
  local branch=$4

  log "→ Fixing PR #$pr_num ($title)"
  log "  Issues: $issues"
  log "  Branch: $branch"

  if $DRY_RUN; then
    log "  [DRY RUN] Would invoke Claude to fix"
    mark_processed "$pr_num"
    return 0
  fi

  # Save current branch to restore after fix
  local original_branch
  original_branch=$(git branch --show-current 2>/dev/null || echo "")

  # Claim the PR by adding claude-working label (prevents other patrol instances from grabbing it)
  gh pr edit "$pr_num" --repo "$REPO" --add-label "claude-working" 2>/dev/null || log "  Warning: could not add claude-working label"

  # Ensure label is removed even if the script is killed mid-fix
  trap 'gh pr edit '"$pr_num"' --repo '"$REPO"' --remove-label "claude-working" 2>/dev/null; exit 1' INT TERM

  # Write prompt to temp file to avoid arg-length limits
  local prompt_file
  prompt_file=$(mktemp "$STATE_DIR/prompt-XXXXXX.txt")
  build_prompt "$pr_num" "$issues" "$title" "$branch" > "$prompt_file"

  # Build claude command
  local claude_args=(--print --model "$MODEL" --max-turns "$MAX_TURNS" --verbose)
  if [[ "$SKIP_PERMS" == "1" ]]; then
    claude_args+=(--dangerously-skip-permissions)
  fi

  local start_time
  start_time=$(date +%s)

  # Run Claude Code, piping the prompt via stdin
  # Unset CLAUDECODE to allow spawning from within a Claude Code session
  local exit_code=0
  env -u CLAUDECODE claude "${claude_args[@]}" < "$prompt_file" 2>&1 | tee -a "$LOG_FILE" || exit_code=$?

  local elapsed=$(( $(date +%s) - start_time ))
  if [[ $exit_code -eq 0 ]]; then
    log "✓ PR #$pr_num processed successfully (${elapsed}s)"
  else
    log "✗ PR #$pr_num processing failed (exit: $exit_code, ${elapsed}s)"
  fi

  rm -f "$prompt_file"

  # Release the PR by removing claude-working label
  gh pr edit "$pr_num" --repo "$REPO" --remove-label "claude-working" 2>/dev/null || log "  Warning: could not remove claude-working label"

  # Restore default trap (the per-PR cleanup trap is no longer needed)
  trap 'log "Shutting down..."; exit 0' INT TERM

  # Clean up any in-progress rebase/merge left by the spawned session
  git rebase --abort 2>/dev/null || true
  git merge --abort 2>/dev/null || true
  git checkout -- . 2>/dev/null || true

  # Restore original branch
  if [[ -n "$original_branch" ]]; then
    git checkout "$original_branch" 2>/dev/null || log "  Warning: could not restore branch $original_branch"
  fi

  mark_processed "$pr_num"
}

# ─── Main Loop ───────────────────────────────────────────────────────

run_check_cycle() {
  log_header "Check cycle"

  # 1. Detect issues on all PRs
  local work_items
  work_items=$(detect_all_pr_issues) || return 1

  if [[ -z "$work_items" ]]; then
    log "All PRs clean — nothing to do"
    return 0
  fi

  # 2. Enrich with review comments for top candidates (limited to avoid API rate limits)
  local enriched=""
  local count=0
  while IFS=$'\t' read -r pr_num issues title branch; do
    if (( count < 5 )); then
      local review_issues
      review_issues=$(check_review_comments "$pr_num" 2>/dev/null || true)
      if [[ -n "$review_issues" ]]; then
        issues="${issues},${review_issues}"
      fi
    fi
    enriched+="${pr_num}\t${issues}\t${title}\t${branch}\n"
    count=$((count + 1))
  done <<< "$work_items"

  # 3. Score and sort by priority, filtering out recently processed
  local sorted=""
  while IFS=$'\t' read -r pr_num issues title branch; do
    [[ -z "$pr_num" ]] && continue
    if was_recently_processed "$pr_num"; then
      log "  Skipping PR #$pr_num (recently processed)"
      continue
    fi
    local score
    score=$(priority_score "$issues")
    sorted+="${score}\t${pr_num}\t${issues}\t${title}\t${branch}\n"
  done < <(echo -e "$enriched")

  sorted=$(echo -e "$sorted" | grep -v '^$' | sort -rn)

  if [[ -z "$sorted" ]]; then
    log "All issues recently processed — nothing to do"
    return 0
  fi

  # 4. Display priority queue
  local queue_size
  queue_size=$(echo "$sorted" | wc -l | tr -d ' ')
  log ""
  log "Priority queue ($queue_size items):"
  while IFS=$'\t' read -r score pr_num issues title branch; do
    log "  [score=$score] PR #$pr_num: $issues — $title"
  done <<< "$sorted"
  log ""

  # 5. Process highest priority item
  local top
  top=$(echo "$sorted" | head -1)
  IFS=$'\t' read -r score pr_num issues title branch <<< "$top"

  fix_pr "$pr_num" "$issues" "$title" "$branch"
}

main() {
  log_header "PR Patrol starting"
  log "Config: interval=${INTERVAL}s, max-turns=${MAX_TURNS}, cooldown=${COOLDOWN}s, model=${MODEL}"
  log "Repo: $REPO"
  log "State: $STATE_DIR"
  log "Mode: $(if $ONCE; then echo "single pass"; elif $DRY_RUN; then echo "dry run"; else echo "continuous"; fi)"

  trap 'log "Shutting down..."; exit 0' INT TERM

  if $ONCE; then
    run_check_cycle
    log "Single pass complete."
    return
  fi

  while true; do
    run_check_cycle || log "Check cycle failed — will retry next interval"

    log "Sleeping ${INTERVAL}s until next check..."
    sleep "$INTERVAL"
  done
}

main
