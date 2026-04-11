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

1. Starts background loops (tmux rename, optionally PR patrol)
2. Pulls latest `main/` and `ops/` to get current state
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

**1b. PR patrol loop** (optional — ask user before starting)

Check for an existing PR patrol process:
```bash
pgrep -f "pr-patrol" && echo "✓ PR patrol already running" || echo "✗ not running"
```

If the user wants it started, follow the standard PR patrol startup procedure (typically `pnpm crux pr-patrol watch` from `lw/coord` or `lw/main`). Do NOT start it without user confirmation — PR patrol uses real LLM budget.

### Section 2: Pull latest

```bash
git -C /Users/ozziegooen/Documents/GitHub.nosync/lw/main pull --ff-only
git -C /Users/ozziegooen/Documents/GitHub.nosync/lw/ops pull --ff-only
```

If either pull fails (diverged), report it and ask the user how to proceed — do not auto-resolve.

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

Print a single concise summary block:

```
=== Admin session ready ===
Date:        2026-04-10
Background:  rename-loop ✓ | pr-patrol [✓ or –]
Production:  healthy | uptime Xs
Linear:      N stale In Progress | M ready P1/P2
CI (main):   N failures in last 24h
Slots:       N active | M idle
```

Then ask the user: "What would you like to work on?"

## Arguments

- `/admin-setup` — full setup with all sections
- `/admin-setup --no-loops` — skip starting background processes (for read-only audits)
- `/admin-setup --quiet` — only print orientation summary, suppress section headers

## Important

- **Idempotent**: re-running this skill should not start duplicate loops or change state. Always check `pgrep` before starting a process.
- **Read-only by default**: sections 2-6 only read state. Section 1 starts processes; section 1b requires user confirmation.
- **Don't dispatch work automatically**: this skill prepares the session, then asks the user what to do.
- **Logs**: background loop logs go to `/tmp/lw-*.log`. Show their tail in the orientation summary if they have errors.
- **Reboot persistence**: the rename loop dies on reboot or coordinator session end. To survive reboots, add `/admin-setup` to your post-reboot routine, or set up Full Disk Access for launchd separately.
