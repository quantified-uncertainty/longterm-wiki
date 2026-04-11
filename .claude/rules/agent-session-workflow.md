# Agent Session Workflow — MANDATORY

Every session that involves writing or changing code MUST follow this workflow.

## Step 0: Create a feature branch

Always work on a `claude/short-description` branch. Never commit directly to `main`.

### Naming convention when the task is tracked in an issue tracker

**Linear is the primary issue tracker.** Most work is tracked there. Encode the issue ID in the branch name so `/agent-init` can auto-detect it and post start/done signals without manual flags:

| Source | Pattern | Example |
|--------|---------|---------|
| Linear issue (primary) | `claude/qua-NNN-description` | `claude/qua-184-linear-integration` |
| Legacy GitHub issue | `claude/fix-NNN-description` | `claude/fix-239-broken-scoring` |
| No tracker | `claude/<verb>-<noun>` | `claude/refactor-gate-helpers` |

Both Linear (`qua-NNN`) and GitHub (`fix-NNN`) patterns are auto-detected by `crux sys agent-checklist init`. Linear detection also falls back to any bare `QUA-NNN` token in the task description, and can be overridden with `--linear=QUA-NNN`.

**Linear branch naming is critical for auto-close.** Linear's GitHub integration auto-moves issues to Done on PR merge, but only if the branch name contains `qua-NNN`. If you name the branch `claude/tier0-data-integrity` instead of `claude/qua-155-tier0-data-integrity`, Linear won't link the PR and the issue stays open after merge. `agent-checklist init` warns about this. As a fallback, `crux gh pr create` auto-injects `Fixes QUA-NNN` into the PR body.

### CI-fix dedup check (when triggered by a CI failure, not a GitHub issue)

Before creating a branch to fix a CI failure, check for existing fix attempts:

```bash
# Check if someone is already working on this
gh pr list -R quantified-uncertainty/longterm-wiki --search "head:claude/fix-" --state open --json number,title,headRefName --jq '.[] | "\(.number)\t\(.headRefName)\t\(.title)"'
```

If an open PR already targets the same failure, do NOT create a competing branch. Instead either:
- Comment on the existing PR with your findings, or
- Wait for it to resolve

This prevents the duplicate-work pattern where multiple agents independently race to fix the same trivial CI break, wasting CI runs and creating abandoned PRs (e.g., 7 competing PRs for a single 5-line test fix on 2026-04-03).

## Step 1: Session Start — BEFORE taking any action

Run `/agent-init` as the very first thing — before reading files, running commands, or writing any code. "Before writing code" is not sufficient; quick fixes and file reads count too. If you start without this, you will forget it entirely.

```bash
# If working on a Linear issue (primary — auto-detected from branch, or explicit):
pnpm crux sys agent-checklist init "Task description" --linear=QUA-184

# If working on a legacy GitHub issue:
pnpm crux sys agent-checklist init --issue=N

# If not on any tracked issue:
pnpm crux sys agent-checklist init "Task description" --type=X
```

Valid types: `content`, `infrastructure`, `bugfix`, `refactor`, `commands`. Default: `infrastructure`.

`init` automatically signals start on both Linear (`linear start`) and GitHub (`gh issues start`) when the respective IDs are known — you do not need to call them by hand. Both calls are best-effort: a Linear or GitHub outage never fails init.

Then read `.claude/wip-checklist.md` and keep it updated as you work.

## Step 2: Session End — BEFORE considering work complete

**If shipping a PR:** Run `/agent-ship`. It verifies the checklist, polishes the PR, pushes, monitors CI, and closes the session.

**If NOT shipping** (research, abandoned, maintenance): Run `/agent-end`. It marks the session as completed, updates Linear/GitHub issues, and cleans up local artifacts.

Every session should end with one of these. See `.claude/rules/pr-review-guidelines.md` for the full end-of-session workflow.

## Why this matters

- PRs give the user a chance to review before changes land on main
- The checklist catches issues that are easy to skip under time pressure (security review, no regressions, CI green)
- It creates a paper trail of decisions for future sessions
- Skipping it is how things like "forgot to verify CI" or "no tests written" happen
- Rationalizing "I'll do it after I read a couple files" reliably leads to skipping it — the rule must be unconditional
