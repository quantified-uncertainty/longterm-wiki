# Next Issue

Pick up the next highest-priority GitHub issue and start working on it.

## Overview

This command helps you start a focused session on the most important open issue. It fetches open issues, applies priority ordering, filters out issues already being worked on (`claude-working` label), and presents the top candidates for selection.

## Phase 1: Fetch and rank open issues

```bash
pnpm crux issues next
```

This will output a ranked list of open issues — highest priority first — with their labels, age, and a brief description. The ranking uses:

1. **Priority labels** — `P0` > `P1` > `P2` > `P3` > unlabeled
2. **Issue age** — older issues rank slightly higher within the same tier
3. **Excluded** — issues labeled `claude-working`, `wontfix`, or `on-hold`

Review the list. If the top issue looks right, proceed. If not, pick a different one from the list and note why you skipped the top one.

## Phase 2: Signal start on the chosen issue

Once you've chosen an issue, use the crux CLI to announce work:

```bash
pnpm crux issues start <ISSUE_NUM>
```

This will:
1. Post a comment on the issue: "Claude Code starting work on this issue (branch: `<current-branch>`)"
2. Add the `claude-working` label to signal it's in flight
3. Print a summary of the issue title and body for context

**Output the issue title and key details** to your working context before starting implementation — this ensures you understand what's being asked.

## Phase 3: Understand the issue

Read the issue carefully. If the body contains acceptance criteria or examples, list them explicitly before coding. Ask yourself:

- What is the desired outcome?
- What files are likely to be involved?
- Are there related issues or PRs mentioned?

If the issue is ambiguous, look at context in the issue comments or related code before proceeding.

## Phase 4: Implement

Work through the issue using the standard development workflow:

1. Use TodoWrite to plan the implementation steps
2. Make changes, following all relevant rules in `.claude/rules/`
3. Run validation: `pnpm crux validate gate`
4. Create a session log entry

## Phase 5: Ship and close the loop

After the work is done:

```bash
pnpm crux issues done <ISSUE_NUM> --pr=<PR_URL>
```

Then run `/push-and-ensure-green` as usual.

## Quick reference

```bash
pnpm crux issues next              # Show next priority issue
pnpm crux issues list              # List all open issues with priority order
pnpm crux issues start <N>         # Announce start + add claude-working label
pnpm crux issues done <N> --pr=URL # Announce completion + remove label
```
