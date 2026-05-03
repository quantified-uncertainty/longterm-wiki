---
name: admin-setup
description: Initialize an admin/coordinator session — start background loops (tmux rename, PR patrol), pull latest, and print orientation. Run this once at the start of an admin session.
disable-model-invocation: true
allowed-tools: Bash, Read
---

# Admin Setup

Initialize an admin/coordinator session. This is the **first thing** to run in a long-lived admin session that will dispatch work to slots, monitor PRs, and run periodic maintenance.

The skill is **idempotent** — it can be re-run safely. Background loops are only started if not already running. Status checks are read-only.

## What this skill does

1. Starts background loops (tmux rename, ws refresh, PR patrol)
2. Pulls latest `main/` and `ops/` and runs a one-shot `./ws refresh` to reset merged-PR slots
3. Prints orientation: production health, stale work, ready-for-dispatch queue
4. Reports what's running and what's stale

## Steps

Run each section in order. Skip a section only if the user asks.

### Section 1: Background loops

**1a. tmux rename loop** — keeps tmux window names in sync with slot + branch.

Check if it's already running:
```bash
pgrep -f tmux-rename-loop.sh && echo "✓ rename loop already running" || echo "✗ not running"
```

If not running, start it:
```bash
cd /Users/ozziegooen/Documents/GitHub.nosync/lw
nohup ./scripts/tmux-rename-loop.sh > /tmp/lw-fix-tabs.log 2>&1 &
disown
echo "Started rename loop, PID $!"
```

If `scripts/tmux-rename-loop.sh` doesn't exist, fall back to running `./ws fix-tabs` once and noting that the loop script needs to be created.

**1b. ws refresh loop** — every 15 minutes, resets slots whose PRs merged and pulls latest main in idle slots. Only touches idle/merged slots; never disturbs active work.

Check if it's already running:
```bash
pgrep -f ws-refresh-loop.sh && echo "✓ ws-refresh loop already running" || echo "✗ not running"
```

If not running, start it:
```bash
cd /Users/ozziegooen/Documents/GitHub.nosync/lw
nohup ./scripts/ws-refresh-loop.sh > /tmp/lw-ws-refresh.log 2>&1 &
disown
echo "Started ws-refresh loop, PID $!"
```

If `scripts/ws-refresh-loop.sh` doesn't exist, fall back to noting that the loop script needs to be created; Section 2 still runs a one-shot refresh.

**1c. PR patrol loop** — scans open PRs and dispatches fix agents for broken CI, conflicts, stale branches, and similar patrolable issues. Coordinator is a documented singleton (`README.md`: "Don't run multiple ops sessions"), so duplicate risk is low, and spend is surfaced in Section 6. Auto-start like 1a/1b.

Check if it's already running:
```bash
pgrep -f "crux gh pr-patrol run" && echo "✓ PR patrol already running" || echo "✗ not running"
```

If not running, start it:
```bash
cd /Users/ozziegooen/Documents/GitHub.nosync/lw/main && \
  export GITHUB_TOKEN=$(gh auth token) && \
  nohup pnpm crux gh pr-patrol run > /tmp/lw-pr-patrol.log 2>&1 &
disown
echo "Started PR patrol, PID $!"
```

The daemon itself manages its own PID at `~/.cache/pr-patrol/daemon.pid` (see `crux/pr-patrol/index.ts`) — the `pgrep` guard above is what prevents duplicate starts from this skill. If `--no-loops` is passed, skip this block entirely.

### Section 2: Pull latest + refresh slots

```bash
git -C /Users/ozziegooen/Documents/GitHub.nosync/lw/main pull --ff-only
git -C /Users/ozziegooen/Documents/GitHub.nosync/lw/ops pull --ff-only
```

If either pull fails (diverged), report it and ask the user how to proceed — do not auto-resolve.

Then do a one-shot `./ws refresh` so the coordinator starts with a clean slot map (the loop from Section 1b catches subsequent merges, but the first run gives immediate feedback):

```bash
/Users/ozziegooen/Documents/GitHub.nosync/lw/ws refresh 2>&1 | tail -20
```

This only resets slots whose PRs have merged; slots with active work are left alone.

### Section 3: Production health

```bash
curl -s https://wiki-server.k8s.quantifieduncertainty.org/health | python3 -m json.tool 2>&1 | head -15
```

If unhealthy or unreachable, surface that prominently — admin needs to know immediately.

### Section 4: Stale work detection

**4a. Stale Linear "In Progress" + ready-for-dispatch queue** — uses the maintain triage-linear command which detects stale In Progress (>3 days), stuck In Review (>5 days), and surfaces P1/P2 backlog items.

```bash
pnpm crux sys maintain triage-linear
```

This replaces the manual GraphQL queries. If `LINEAR_API_KEY` is not set, it reports that and skips gracefully.

**4b. Actionable active-issue audit** — correlates Linear In Progress + In Review state with GitHub PR activity. Surfaces `SHIPPED` (PR merged but state not updated) and `PARENT-EPIC` (all sub-issues resolved) — these are one-keystroke cleanups that `triage-linear` doesn't catch because it only looks at staleness by time. The In-Review case is QUA-812: Linear's GitHub integration occasionally drops the In-Review → Done transition on PR merge (~1.4–5% rate), and the audit catches the gap mechanically.

```bash
# Run the audit once and split by bucket in Python to avoid doubling the
# GitHub /search/issues budget used for PR correlation.
pnpm crux linear audit --json 2>/dev/null | python3 -c "
import json, sys
try:
  entries = json.load(sys.stdin)
  shipped = [e for e in entries if e.get('bucket') == 'shipped']
  parent_epics = [e for e in entries if e.get('bucket') == 'parent-epic']
  if shipped:
    print(f'⚠ {len(shipped)} issue(s) SHIPPED but still In Progress / In Review:')
    for e in shipped:
      print(f\"  {e['issue']['identifier']} — {e['reason']}\")
    print('  Run: pnpm crux linear audit --fix')
  if parent_epics:
    print(f'⚠ {len(parent_epics)} parent epic(s) with all sub-issues resolved:')
    for e in parent_epics:
      print(f\"  {e['issue']['identifier']} — {e['reason']}\")
    print('  Run: pnpm crux linear audit --fix')
except Exception:
  pass
"
```

Use `pnpm crux linear audit` (no args) for the full report.

**4c. Stale agent slots** — slots on a non-main branch with no recent activity.

```bash
/Users/ozziegooen/Documents/GitHub.nosync/lw/ws list 2>&1 | tail -25
```

### Section 5: Production failures

**5a. Recent CI failures on main** (last 24h):
```bash
gh run list -R quantified-uncertainty/longterm-wiki --branch=main --limit=10 \
  --json status,conclusion,name,createdAt \
  --jq '.[] | select(.conclusion == "failure") | "\(.createdAt[:16]) \(.name)"' | head -5
```

**5b. Overdue audits**:
```bash
cd /Users/ozziegooen/Documents/GitHub.nosync/lw/main && pnpm crux sys audits list 2>&1 | grep -E "OVERDUE|DUE TODAY" | head -5
```

### Section 6: Print orientation summary

**6a. Compute PR patrol status — alive, age, 24h activity.**

PR patrol doesn't currently log dollar cost (see QUA-324 — follow-up to add `cost_usd` to `runs.jsonl`). As a proxy until that lands, count `pr_result` entries in the last 24h from `~/.cache/pr-patrol/runs.jsonl`. **Also surface the daemon's age** — long-running daemons (>2 days) are running stale code and miss every patrol fix that has merged since they started. Empirically the daemon dies silently on credit-balance issues + races, so users need a visible signal (this skill is the only place it surfaces).

```bash
PATROL_PID=$(pgrep -f "crux[[:space:]]+(gh[[:space:]]+)?pr-patrol[[:space:]]+(run|parallel)" | head -1)
if [ -n "$PATROL_PID" ]; then
  # Daemon age in days (compare lstart timestamp to now). BSD `ps -p PID -o lstart=`
  # returns e.g. "Tue Apr 22 09:26:17 2026". macOS-only; on Linux use --etime.
  STARTED=$(ps -p "$PATROL_PID" -o lstart= 2>/dev/null | sed 's/^ *//')
  STARTED_TS=$(date -j -f "%a %b %d %T %Y" "$STARTED" "+%s" 2>/dev/null || echo 0)
  NOW_TS=$(date +%s)
  if [ "$STARTED_TS" -gt 0 ]; then
    AGE_DAYS=$(( (NOW_TS - STARTED_TS) / 86400 ))
    AGE_NOTE=" — started ${AGE_DAYS}d ago"
    [ "$AGE_DAYS" -ge 2 ] && AGE_NOTE="${AGE_NOTE} ⚠ STALE (running pre-${AGE_DAYS}d code; restart to pick up fixes)"
  else
    AGE_NOTE=""
  fi

  RUNS_24H=$(awk -v cutoff="$(date -u -v-24H +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%S)" '
    /"type":"pr_result"/ {
      if (match($0, /"timestamp":"[^"]+"/)) {
        ts = substr($0, RSTART+13, RLENGTH-14)
        if (ts >= cutoff) count++
      }
    }
    END { print count+0 }
  ' ~/.cache/pr-patrol/runs.jsonl 2>/dev/null || echo 0)
  # Warn threshold: >40 fix attempts in 24h is unusually high (normal is ~5-15).
  # 40+ suggests a runaway loop or an oscillating PR. Downgrade to raw $ when QUA-324 lands.
  if [ "$RUNS_24H" -gt 40 ]; then
    PATROL_STATUS="⚠ pr-patrol ✓ (${RUNS_24H} runs/24h — unusually high)${AGE_NOTE}"
  else
    PATROL_STATUS="pr-patrol ✓ (${RUNS_24H} runs/24h)${AGE_NOTE}"
  fi

  # Also flag if patrol source code has changed since the daemon started — a
  # restart will pick up new turn-budget tunings, scoring rules, etc.
  if [ "$STARTED_TS" -gt 0 ]; then
    LAST_PATROL_COMMIT_TS=$(cd "${CODEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$PWD}}" 2>/dev/null && git log -1 --format=%ct -- crux/pr-patrol/ 2>/dev/null || echo 0)
    if [ "$LAST_PATROL_COMMIT_TS" -gt "$STARTED_TS" ]; then
      PATROL_STATUS="${PATROL_STATUS} | ⚠ source updated since daemon start — restart recommended"
    fi
  fi
else
  PATROL_STATUS="pr-patrol – (NOT RUNNING — restart with the Section 1c block)"
fi
echo "$PATROL_STATUS"
```

**If the daemon is stale (≥2d) or its source code has been updated**, offer to restart it before reporting the summary:

```bash
echo "Restart patrol now? (Re-runs the Section 1c block — kill old daemon + start fresh.)"
```

Restart steps (use only on user confirmation, OR automatically if `--auto-restart-stale` is passed):
```bash
pkill -f "crux[[:space:]]+(gh[[:space:]]+)?pr-patrol[[:space:]]+(run|parallel)" 2>/dev/null
sleep 2
cd /Users/ozziegooen/Documents/GitHub.nosync/lw/main && \
  export GITHUB_TOKEN=$(gh auth token) && \
  nohup pnpm crux gh pr-patrol run > /tmp/lw-pr-patrol.log 2>&1 &
disown
```

**6b. Print the summary block:**

```text
=== Admin session ready ===
Date:        2026-04-10
Background:  rename-loop ✓ | ws-refresh ✓ | <PATROL_STATUS from 6a>
                                              # PATROL_STATUS now includes age + stale-source warning
Production:  healthy | uptime Xs
Linear:      N stale In Progress | M ready P1/P2
CI (main):   N failures in last 24h
Slots:       N active | M idle
```

If `PATROL_STATUS` contains `⚠ STALE` or `⚠ source updated`, surface that prominently in your first user message — those signal the patrol is running pre-fix code and needs a restart cycle.

Then ask the user: "What would you like to work on?"

## Arguments

- `/admin-setup` — full setup with all sections
- `/admin-setup --no-loops` — skip starting background processes (for read-only audits)
- `/admin-setup --quiet` — only print orientation summary, suppress section headers
- `/admin-setup --auto-restart-stale` — restart patrol without confirmation if it's ≥2d old or its source has been updated

## Important

- **Idempotent**: re-running this skill should not start duplicate loops or change state. Always check `pgrep` before starting a process.
- **Section 1 starts background processes** (rename loop, ws-refresh loop, PR patrol). Each is guarded by `pgrep` to prevent duplicates. Sections 2-6 are read-only. Use `--no-loops` to skip Section 1 for read-only audits.
- **Don't dispatch work automatically**: this skill prepares the session, then asks the user what to do.
- **Logs**: background loop logs go to `/tmp/lw-*.log`. Show their tail in the orientation summary if they have errors.
- **Reboot persistence**: the rename loop dies on reboot or coordinator session end. To survive reboots, add `/admin-setup` to your post-reboot routine, or set up Full Disk Access for launchd separately.
