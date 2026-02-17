# PR Review & Ship Workflow — MANDATORY

Before considering any session complete, you MUST execute the full review-and-ship workflow below. Do not skip steps. Do not ask the user whether to do this — it is always required.

## Phase 1: Self-Review (run `/review`)

Before the final push, run the `/review` slash command. This triggers the paranoid 6-step code review defined in `.claude/commands/review.md`.

**Additional review focus areas** (beyond the standard checklist):
- **Codebase integration**: Check whether changes require updates elsewhere — new types need consumers, new data fields need UI, new config needs documentation. Grep for patterns related to what you changed and verify nothing is stale.
- **DRY violations**: Look for logic you introduced that duplicates existing utilities in `crux/lib/`, `app/src/lib/`, or shared components. If you find duplication, refactor to use the existing code.
- **Refactoring opportunities**: If your changes touch code that has clear structural problems (dead branches, confusing naming, unnecessary indirection), fix them in the same PR rather than leaving tech debt.

If the review finds CRITICAL or WARNING issues: fix them, re-run `/review`, and repeat until the verdict is **GOOD TO GO**.

## Phase 2: Push & Monitor CI (run `/push-safe`)

Once the review passes, run the `/push-safe` slash command. This handles:
1. Local gate checks (`pnpm crux validate gate`)
2. Pushing to the remote branch
3. Polling CI until all check runs report `conclusion: success`
4. Auto-fixing and retrying if CI fails (up to 3 cycles)

Do NOT consider work complete until `/push-safe` confirms all CI checks are green.

## Phase 3: Conflict Check

After CI is green, verify the PR has no merge conflicts:
```bash
SHA=$(git rev-parse HEAD)
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

If conflicts exist, rebase onto main and re-run Phase 2.

Note: The `auto-rebase.yml` and `resolve-conflicts.yml` GitHub workflows handle most conflicts automatically after the session ends, but checking here catches issues early.

## Summary

The minimum end-of-session sequence is:
1. `/review` — fix all issues found
2. `/push-safe` — push and confirm CI green
3. Conflict check — verify PR is mergeable

Only after all three phases pass should you report the session as complete.
