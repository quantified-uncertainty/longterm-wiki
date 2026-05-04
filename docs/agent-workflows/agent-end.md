# Agent End Workflow

Use this workflow when an agent session is done but there is no PR to ship:
research, abandoned work, maintenance, or a quick fix that was already handled.
For sessions that ship code through a PR, use `/agent-ship` / the
`source-command-agent-push-and-verify` skill instead.

This is the canonical cross-agent close-out workflow. Tool-specific slash
commands or skills should stay thin and point here.

## 0. Choose the Right Workflow

| Scenario | Use |
| --- | --- |
| Shipping a PR | `/agent-ship` / `source-command-agent-push-and-verify` |
| Research or investigation only | `agent-end` |
| Work abandoned or folded into another session | `agent-end` |
| Quick fix already pushed by hand | `agent-end` |
| PR patrol or maintenance with no PR from this slot | `agent-end` |

Before running this workflow, enumerate every problem observed during the
session and give each a disposition: `fixed`, `filed:QUA-NNN`, or
`deferred:<reason>`.

## 1. Complete the Checklist

If the checklist does not exist (for example, a quick fix session), skip this
step. Otherwise, inspect it first:

```bash
pnpm crux sys agent-checklist status
```

If any checklist item remains open, either complete it or mark it N/A with a
reason:

```bash
pnpm crux sys agent-checklist check --na <item-id> --reason="<why this is not applicable>"
```

Then validate completion:

```bash
pnpm crux sys agent-checklist complete
```

## 2. Update Linear

Linear is the primary issue tracker. If this session was working on a Linear
issue, move it to the right terminal state.

Set `PR_URL` first. If a PR was created during this session, export it. If no
PR was created, leave it empty so the issue goes straight to `Done`.

```bash
# Example: if a PR exists
# export PR_URL="https://github.com/quantified-uncertainty/longterm-wiki/pull/123"
PR_URL="${PR_URL:-}"

LINEAR_ID=$(grep -oE '^> Linear: [A-Z]+-[0-9]+' .claude/wip-checklist.md 2>/dev/null | awk '{print $3}')
if [ -z "$LINEAR_ID" ]; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  LINEAR_ID=$(echo "$BRANCH" | grep -oE '\bclaude/qua-[0-9]+' | sed 's|claude/||' | tr 'a-z' 'A-Z')
fi

if [ -n "$LINEAR_ID" ]; then
  if [ -n "$PR_URL" ]; then
    pnpm crux linear done "$LINEAR_ID" --pr="$PR_URL" || echo "Linear update failed; check LINEAR_API_KEY and rerun"
  else
    pnpm crux linear done "$LINEAR_ID" || echo "Linear update failed; check LINEAR_API_KEY and rerun"
  fi
fi
```

If Linear updates fail, fix the key and rerun the relevant
`pnpm crux linear done <QUA-NNN>` command manually.

## 3. Leak-Check Related Linear IDs

Scan for secondary Linear references that may have been worked on but not
closed:

```bash
pnpm crux linear leak-check || true
```

If it surfaces a leak, decide whether the issue was genuinely worked on,
only mentioned, or left as scope creep. Update Linear accordingly.

## 4. Update Legacy GitHub Issues

Only use this for legacy GitHub issues, not Linear issues.

If a PR was created:

```bash
pnpm crux gh issues done <ISSUE_NUM> --pr=<PR_URL>
```

If no PR was created, remove the working label:

```bash
gh api repos/quantified-uncertainty/longterm-wiki/issues/<N>/labels/agent:working -X DELETE 2>/dev/null || true
```

## 5. Stop Local Session Processes

Stop patrol if it is running:

```bash
pnpm crux gh pr-patrol stop
```

Kill only this slot's dev server. Never use broad process kills such as
`pkill -f "next dev"`.

```bash
DEV_PORT=$(grep -m1 '^DEV_PORT=' .env 2>/dev/null | cut -d= -f2-)
if [ -n "$DEV_PORT" ] && [[ "$DEV_PORT" =~ ^[0-9]+$ ]]; then
  PIDS=$(lsof -ti:$DEV_PORT -sTCP:LISTEN 2>/dev/null)
  if [ -n "$PIDS" ]; then
    kill $PIDS 2>/dev/null
    echo "Killed dev server on port $DEV_PORT (PIDs: $PIDS)"
  fi
fi
```

## 6. Clean Session Artifacts

Remove transient checklist/context files and restore transient review markers:

```bash
rm -f .claude/wip-checklist.md .claude/wip-context.md
git checkout -- .claude/review-done 2>/dev/null || rm -f .claude/review-done
git checkout -- .claude/review-phases-done 2>/dev/null || rm -f .claude/review-phases-done
git checkout -- .claude/simplify-done 2>/dev/null || rm -f .claude/simplify-done
git checkout -- .claude/hooks/ 2>/dev/null || true
```

## 7. Close the Agent Session

Close the active agent in the DB:

```bash
pnpm crux sys agents close 2>/dev/null || true
```

This is best-effort; if the wiki-server is down, continue with local cleanup.

## 8. Reset the Slot

Show the current state before discarding anything:

```bash
BRANCH=$(git branch --show-current)
echo "Current branch: $BRANCH"
git status --porcelain
git log --oneline "@{u}..HEAD" 2>/dev/null || echo "(no upstream to compare)"
```

If there are uncommitted changes or unpushed commits on a non-main branch,
ask the user before proceeding. They may want to commit, push, or preserve
work first.

If the branch has merged or the user confirms the reset, continue:

```bash
git checkout -- .
git clean -fd --exclude=.agent-slot --exclude=.envrc --exclude=.env

if [ "$BRANCH" != "main" ]; then
  AGENT_RESET=1 git checkout main
  git pull --ff-only origin main || git reset --hard origin/main
  git branch -D "$BRANCH" 2>/dev/null || true
fi
```

Rename the tmux window back to the idle slot name:

```bash
SLOT=$(cat .agent-slot 2>/dev/null | tr -d '[:space:]')
if [ -n "$SLOT" ] && [ -n "$TMUX" ]; then
  tmux rename-window "A${SLOT}"
fi
```

## 9. Final Summary

Report:

- Branch that was ended and whether it was deleted
- What was done in one or two sentences
- PR URL, if any
- Whether the checklist was completed
- Final branch and clean/dirty status

If the client supports session reset commands, tell the user to clear context
and reset the session name after this workflow finishes.
