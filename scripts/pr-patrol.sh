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
#   PR_PATROL_MAX_TURNS    Max Claude turns per fix (default: 40)
#   PR_PATROL_COOLDOWN     Don't re-process same PR within N seconds (default: 1800)
#   PR_PATROL_STALE_HOURS  Hours before a PR is considered stale (default: 48)
#   PR_PATROL_MODEL        Claude model to use (default: sonnet)
#   PR_PATROL_REPO         GitHub repo (default: quantified-uncertainty/longterm-wiki)
#   PR_PATROL_SKIP_PERMS   Set to "1" to add --dangerously-skip-permissions

REPO="${PR_PATROL_REPO:-quantified-uncertainty/longterm-wiki}"
INTERVAL="${PR_PATROL_INTERVAL:-300}"
MAX_TURNS="${PR_PATROL_MAX_TURNS:-40}"
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
      echo "  --max-turns=N     Max Claude turns per fix (default: 40)"
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

# Track max-turns failures per PR
record_max_turns_failure() {
  local pr_num=$1
  local fail_file="$STATE_DIR/max-turns-$pr_num"
  local count=0
  if [[ -f "$fail_file" ]]; then
    count=$(cat "$fail_file")
  fi
  count=$((count + 1))
  echo "$count" >| "$fail_file"
  echo "$count"
}

is_abandoned() {
  local pr_num=$1
  local fail_file="$STATE_DIR/max-turns-$pr_num"
  if [[ -f "$fail_file" ]]; then
    local count
    count=$(cat "$fail_file")
    if (( count >= 2 )); then
      return 0
    fi
  fi
  return 1
}

# ─── PR Detection ────────────────────────────────────────────────────

detect_all_pr_issues() {
  # Fetch all open PRs with relevant fields
  local prs
  prs=$(gh pr list --repo "$REPO" --state open --limit 50 \
    --json number,title,headRefName,mergeable,mergedAt,createdAt,statusCheckRollup,updatedAt,body,labels 2>/dev/null) || {
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
      (if ((((.updatedAt // .createdAt // "") | fromdateiso8601?) // 0) < ($stale | tonumber))
       then "stale" else empty end),
      (if (.labels // [] | map(.name) | any(. == "claude-working"))
       then "in-progress" else empty end)
    ] as $issues |
    # Skip PRs with no issues (other than in-progress)
    ($issues | map(select(. != "in-progress"))) as $actionable |
    select($actionable | length > 0) |
    # Skip PRs currently being worked on
    select($issues | any(. == "in-progress") | not) |
    "\(.number)\t\($actionable | join(","))\t\(.title)\t\(.headRefName)\t\(.createdAt)"
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
  local created_at=$2
  local score=0
  [[ "$issues" == *conflict* ]]                   && score=$((score + 100))
  [[ "$issues" == *ci-failure* ]]                  && score=$((score + 80))
  [[ "$issues" == *review-changes-requested* ]]    && score=$((score + 70))
  [[ "$issues" == *missing-issue-ref* ]]           && score=$((score + 40))
  [[ "$issues" == *stale* ]]                       && score=$((score + 30))
  [[ "$issues" == *missing-testplan* ]]            && score=$((score + 20))

  # Age bonus: older PRs get up to +50 points (1 point per hour, capped at 50)
  if [[ -n "$created_at" ]]; then
    local created_epoch
    # macOS: -u treats input as UTC (the Z suffix). Linux: -d handles ISO 8601 natively.
    created_epoch=$(date -u -jf "%Y-%m-%dT%H:%M:%SZ" "$created_at" +%s 2>/dev/null || date -d "$created_at" +%s 2>/dev/null || echo 0)
    if [[ "$created_epoch" -gt 0 ]]; then
      local now
      now=$(date -u +%s)
      local age_hours=$(( (now - created_epoch) / 3600 ))
      local age_bonus=$(( age_hours > 50 ? 50 : (age_hours < 0 ? 0 : age_hours) ))
      score=$((score + age_bonus))
    fi
  fi

  echo "$score"
}

# ─── Fix a PR using Claude Code ──────────────────────────────────────

build_prompt() {
  local pr_num=$1
  local issues=$2
  local title=$3
  local branch=$4

  local prompt=""
  prompt+="You are a PR maintenance agent for the ${REPO} repository."
  prompt+=$'\n\n## Target'
  prompt+=$'\nPR #'"${pr_num}"': "'"${title}"'" (branch: '"${branch}"')'
  prompt+=$'\n\n## Issues Detected'
  prompt+=$'\n'"${issues}"
  prompt+=$'\n\n## Instructions'
  prompt+=$'\n\n1. First, fetch PR details to understand context:'
  prompt+=$'\n   gh pr view '"${pr_num}"' --repo '"${REPO}"' --json headRefName,body,statusCheckRollup,reviews'
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
    prompt+=$'\n- Check CI status: gh pr checks '"${pr_num}"' --repo '"${REPO}"
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
    prompt+=$'\n- Search for related issues: gh issue list --search "keywords from PR title" --repo '"${REPO}"
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
  prompt+=$'\n- Do NOT run /agent-session-start or /agent-session-ready-PR — this is a targeted fix, not a full session'
  prompt+=$'\n- Do NOT create new branches — work on the existing PR branch'

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
  local claimed_label=false
  cleanup_claim() {
    if $claimed_label; then
      gh pr edit "$pr_num" --repo "$REPO" --remove-label "claude-working" 2>/dev/null || true
      claimed_label=false
    fi
  }

  if gh pr edit "$pr_num" --repo "$REPO" --add-label "claude-working" 2>/dev/null; then
    claimed_label=true
  else
    log "  Warning: could not add claude-working label"
  fi

  # Ensure label is removed on any exit (signals, errors, normal return)
  trap 'cleanup_claim; exit 1' INT TERM
  trap 'cleanup_claim' EXIT

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
  local output_file
  output_file=$(mktemp "$STATE_DIR/output-XXXXXX.txt")
  local exit_code=0
  env -u CLAUDECODE claude "${claude_args[@]}" < "$prompt_file" 2>&1 | tee -a "$LOG_FILE" "$output_file" || exit_code=$?

  local elapsed=$(( $(date +%s) - start_time ))
  local claude_output
  claude_output=$(cat "$output_file")
  local hit_max_turns=false

  if echo "$claude_output" | grep -q "Reached max turns"; then
    hit_max_turns=true
  fi

  if [[ $exit_code -eq 0 ]] && ! $hit_max_turns; then
    log "✓ PR #$pr_num processed successfully (${elapsed}s)"
  elif $hit_max_turns; then
    log "⚠ PR #$pr_num hit max turns ($MAX_TURNS) after ${elapsed}s"
    local fail_count
    fail_count=$(record_max_turns_failure "$pr_num")
    if (( fail_count >= 2 )); then
      log "✗ PR #$pr_num abandoned after $fail_count max-turns failures — needs human intervention"
      gh pr comment "$pr_num" --repo "$REPO" --body "$(cat <<GHEOF
🤖 **PR Patrol**: Abandoning automatic fix after $fail_count failed attempts (hit max turns each time).

**Issues detected**: $issues
**Last attempt**: ${elapsed}s, $MAX_TURNS turns

This PR likely needs human intervention to resolve. The conflict or issue is too complex for automated resolution.
GHEOF
)" 2>/dev/null || log "  Warning: could not post abandonment comment"
    fi
  else
    log "✗ PR #$pr_num processing failed (exit: $exit_code, ${elapsed}s)"
  fi

  # Post a summary comment on the PR with what was done
  # Truncate output to last 500 chars to keep comment concise
  local summary
  summary=$(echo "$claude_output" | tail -c 1500 | head -c 500)
  if [[ -n "$summary" ]] && ! $hit_max_turns; then
    gh pr comment "$pr_num" --repo "$REPO" --body "$(cat <<GHEOF
🤖 **PR Patrol** ran for ${elapsed}s (${MAX_TURNS} max turns, model: ${MODEL}).

**Issues detected**: $issues

**Result**:
$summary
GHEOF
)" 2>/dev/null || log "  Warning: could not post summary comment"
  fi

  rm -f "$prompt_file" "$output_file"

  # Release the PR label via cleanup function
  cleanup_claim

  # Restore default traps
  trap - EXIT
  trap 'log "Shutting down..."; exit 0' INT TERM

  # Clean up any in-progress rebase/merge left by the spawned session
  git rebase --abort 2>/dev/null || true
  git merge --abort 2>/dev/null || true

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
  while IFS=$'\t' read -r pr_num issues title branch created_at; do
    if (( count < 5 )); then
      local review_issues
      review_issues=$(check_review_comments "$pr_num" 2>/dev/null || true)
      if [[ -n "$review_issues" ]]; then
        issues="${issues},${review_issues}"
      fi
    fi
    enriched+="${pr_num}\t${issues}\t${title}\t${branch}\t${created_at}\n"
    count=$((count + 1))
  done <<< "$work_items"

  # 3. Score and sort by priority, filtering out recently processed and abandoned
  local sorted=""
  while IFS=$'\t' read -r pr_num issues title branch created_at; do
    [[ -z "$pr_num" ]] && continue
    if is_abandoned "$pr_num"; then
      log "  Skipping PR #$pr_num (abandoned — needs human intervention)"
      continue
    fi
    if was_recently_processed "$pr_num"; then
      log "  Skipping PR #$pr_num (recently processed)"
      continue
    fi
    local score
    score=$(priority_score "$issues" "$created_at")
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
  # Preflight: must be in a git repo with clean working tree
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "ERROR: Must run inside a git worktree" >&2
    exit 1
  fi
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "ERROR: Working tree must be clean before starting PR Patrol" >&2
    echo "  Commit or stash your changes first." >&2
    exit 1
  fi

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
