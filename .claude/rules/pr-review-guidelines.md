# PR Review & Ship Workflow — MANDATORY

Before considering any session complete, you MUST execute the review-and-ship workflow. Do not skip steps. Do not ask the user whether to do this — it is always required.

## Preferred: `/finalize`

The recommended end-of-session command is `/finalize`. It verifies the session checklist (from `/kickoff`), polishes the PR description, updates GitHub issues, creates a session log, and calls `/push-and-ensure-green` to ship.

If `/kickoff` was run at session start and `.claude/wip-checklist.md` exists, just run `/finalize` — it handles everything.

## Fallback: Manual sequence

If `/kickoff` was not run (e.g., a quick fix session), the minimum end-of-session sequence is:

1. **`/paranoid-pr-review`** — code review. Fix all CRITICAL and WARNING issues found.
2. **`/push-and-ensure-green`** — push and confirm CI green.
3. **Conflict check** — verify PR is mergeable:
```bash
curl -s -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/quantified-uncertainty/longterm-wiki/pulls?head=quantified-uncertainty:$(git branch --show-current)&state=open" \
  | python3 -c "
import sys, json; prs = json.load(sys.stdin)
for pr in prs:
    print(f\"PR #{pr['number']}: mergeable_state={pr.get('mergeable_state', 'unknown')}\")
    if pr.get('mergeable_state') == 'dirty':
        print('  WARNING: PR has merge conflicts — rebase needed')
    elif pr.get('mergeable_state') == 'behind':
        print('  INFO: PR is behind main — auto-rebase workflow will handle this')
    else:
        print('  OK: No conflicts')
"
```

If conflicts exist, rebase onto main and re-run step 2.

Only after all steps pass should you report the session as complete.
