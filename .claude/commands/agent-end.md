---
description: End the current session — log it, update issues, clean up. No shipping required.
effort: low
---

# Agent End — Close Out a Session

Lightweight session close. Use this when the session is done but you don't need to ship a PR.

For sessions that DO ship code, use `/agent-ship` instead (it calls `/agent-end` internally after shipping).

## When to use `/agent-end` vs `/agent-ship`

| Scenario | Use |
|----------|-----|
| Shipping a PR (normal work) | `/agent-ship` |
| Research / investigation only | `/agent-end` |
| Work abandoned or folded into another session | `/agent-end` |
| Quick fix already pushed by hand | `/agent-end` |
| PR patrol / maintenance (no PR from this slot) | `/agent-end` |

## Step 1: Update session status in DB

Mark the session as completed:

```bash
pnpm crux sys agent-checklist complete 2>/dev/null || true
```

If the checklist doesn't exist (e.g., quick fix session), that's fine — skip it.

## Step 2: Update GitHub issue (if applicable)

If this session was working on a GitHub issue and a PR was created:

```bash
pnpm crux gh issues done <ISSUE_NUM> --pr=<PR_URL>
```

If no PR was created (research/abandoned), just remove the working label:

```bash
gh api repos/quantified-uncertainty/longterm-wiki/issues/<N>/labels/agent:working -X DELETE 2>/dev/null || true
```

## Step 3: Stop patrol daemon (if running)

```bash
pnpm crux gh pr-patrol stop
```

## Step 4: Kill this slot's dev server (if running)

Each slot uses its own port (`3010 + slot number`, e.g. `lw/a2` → 3012). Kill it so it doesn't linger:

```bash
# Read DEV_PORT from .env (set by the slot scaffolding); fall back to nothing.
DEV_PORT=$(grep -m1 '^DEV_PORT=' .env 2>/dev/null | cut -d= -f2-)
if [ -n "$DEV_PORT" ]; then
  PIDS=$(lsof -ti:$DEV_PORT -sTCP:LISTEN 2>/dev/null)
  if [ -n "$PIDS" ]; then
    kill $PIDS 2>/dev/null
    echo "Killed dev server on port $DEV_PORT (PIDs: $PIDS)"
  fi
fi
```

**Never** `pkill -f "next dev"` — that would kill dev servers in other slots and the user's main server. Always scope to this slot's port (use `lsof -ti:$PORT -sTCP:LISTEN`, never bare `lsof -ti:$PORT` which also matches browser connections).

## Step 5: Clean up local artifacts

Remove untracked session artifacts and discard any unstaged changes (modified hooks, deleted markers, etc.):

```bash
rm -f .claude/wip-checklist.md .claude/wip-context.md
git checkout -- .claude/review-done 2>/dev/null || rm -f .claude/review-done
git checkout -- .claude/hooks/ 2>/dev/null || true
```

## Step 6: Session summary

Output a brief summary:
- Branch name
- What was done (1-2 sentences)
- PR URL (if any)
- Whether the checklist was completed

That's it. The slot is now ready for the next session (or run `crux sys agent-reset --kill` for a full reset including pulling main).
