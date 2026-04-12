# Dispatched Agent Review — MANDATORY

When a coordinator session dispatches subagents to work on issues and create PRs, **every dispatch prompt MUST instruct the agent to run `/agent-review-pr` before creating the PR**. Do not instruct subagents to run `pnpm crux gh pr create` directly.

## Why

The existing `/agent-ship` workflow has `/agent-review-pr` as a mandatory, non-skippable Step 2b. But when a coordinator dispatches subagents with prompts like "do the work, run `pnpm build`, run `pnpm crux gh pr create`", the subagents bypass the entire `/agent-ship` flow and skip the review step.

Session on 2026-04-11: 15 PRs dispatched across 2 waves with "skip-the-ship-flow" prompts. All 15 passed build+tests. Retrospective review found **8 real issues (~53% hit rate)**, including:
- 2 deploy-blockers (CHECK constraints missing enum values, silent sync failure)
- 1 critical correctness bug (validation ran after transaction commit)
- 1 budget double-subtraction
- 1 partial sweep (missed a 3rd entry point for the same check)
- 1 cross-service deploy-order bug
- 1 false claim of "simplification" that was never actually committed

The review step exists. It works. Dispatched agents just weren't reaching it.

## How to apply

### For coordinators dispatching subagents

Every dispatch prompt ending in "create a PR" must include this phrase:

```
### Before creating the PR:
Run `/agent-review-pr` on your changes — it's adaptive and scales to PR size. Address every finding before proceeding to PR creation.

### Creating the PR:
Use `/agent-ship` (not raw `pnpm crux gh pr create`). This runs the full ship workflow including the mandatory review step, deploy task detection, Linear updates, and session logging.
```

### For the coordinator after dispatch

When a dispatched agent reports completion, verify:
1. `gh pr view <N>` — PR exists
2. `gh pr view <N> --json body --jq '.body' | grep -i "review"` — review was mentioned in PR body (optional heuristic)
3. Read the agent's report for the phrase "ran `/agent-review-pr`" or "ran `/agent-ship`"

If an agent reports creating a PR without mentioning the review step, **run `/agent-review-pr` on the PR yourself before considering it shipped**.

### Never trust claims without verification

If an agent claims to have simplified code, fixed bugs, or applied review findings:
- `git log --oneline <branch> -5` — confirm commits exist
- `git show --stat <commit>` — confirm the claim matches the diff
- `gh pr diff <N>` — confirm the remote state

See `.claude/memory/feedback_verify_agent_claims.md` for the pattern.

## Anti-patterns to avoid

**Bad dispatch prompt:**
```
Do the work. Run `pnpm build` and `pnpm test`. Then push and run `pnpm crux gh pr create`.
```

**Good dispatch prompt:**
```
Do the work. Run `pnpm build` and `pnpm test`. Then run `/agent-review-pr` on your changes. Address every finding. Then run `/agent-ship` to push, verify CI, and close the session.
```

The difference: 1 extra line, 50%+ bug rate reduction.
