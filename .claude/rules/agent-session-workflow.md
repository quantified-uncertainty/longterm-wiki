# Agent Session Workflow — MANDATORY

Every session that involves writing or changing code MUST follow this workflow.

## Step 0: Create a feature branch

Always work on a `claude/short-description` branch. Never commit directly to `main`.

### Duplicate work prevention (ALL sessions, not just CI fixes)

Before creating a branch, check if someone is already working on the same thing:

```bash
# If working on a GitHub issue — check for agent:working label and open PRs
pnpm crux gh issues search "is:open label:agent:working <ISSUE_NUM>"
# Check for open PRs that close the same issue
pnpm crux gh pr detect  # or search manually:
gh pr list -R quantified-uncertainty/longterm-wiki --search "head:claude/" --state open --json number,title,headRefName --jq '.[] | "\(.number)\t\(.headRefName)\t\(.title)"'
```

```bash
# If fixing a CI failure — check for existing fix PRs
gh pr list -R quantified-uncertainty/longterm-wiki --search "head:claude/fix-" --state open --json number,title,headRefName --jq '.[] | "\(.number)\t\(.headRefName)\t\(.title)"'
```

**If an open PR or active session already targets the same issue/failure**, do NOT create a competing branch. Instead:
- Comment on the existing PR with your findings, or
- Wait for it to resolve, or
- Ask the user whether to proceed

This prevents duplicate-work waste: 13 competing PRs for a single test fix (2026-04-03), two independent PRs for the same issue #3983 (2026-04-07), and two competing 242-file renames for issue #4001 (2026-04-07).

## Step 1: Session Start — BEFORE taking any action

Run `/agent-init` as the very first thing — before reading files, running commands, or writing any code. "Before writing code" is not sufficient; quick fixes and file reads count too. If you start without this, you will forget it entirely.

```bash
# If working on a GitHub issue:
pnpm crux sys agent-checklist init --issue=N
pnpm crux gh issues start <N>

# If not on an issue:
pnpm crux sys agent-checklist init "Task description" --type=X
```

Valid types: `content`, `infrastructure`, `bugfix`, `refactor`, `commands`. Default: `infrastructure`.

Then read `.claude/wip-checklist.md` and keep it updated as you work.

## Step 2: Session End — BEFORE considering work complete

**If shipping a PR:** Run `/agent-ship`. It verifies the checklist, polishes the PR, pushes, monitors CI, and closes the session.

**If NOT shipping** (research, abandoned, maintenance): Run `/agent-end`. It marks the session as completed, updates GitHub issues, and cleans up local artifacts.

Every session should end with one of these. See `.claude/rules/pr-review-guidelines.md` for the full end-of-session workflow.

## Why this matters

- PRs give the user a chance to review before changes land on main
- The checklist catches issues that are easy to skip under time pressure (security review, no regressions, CI green)
- It creates a paper trail of decisions for future sessions
- Skipping it is how things like "forgot to verify CI" or "no tests written" happen
- Rationalizing "I'll do it after I read a couple files" reliably leads to skipping it — the rule must be unconditional
