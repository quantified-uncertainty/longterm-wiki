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

### How the checklist is enforced mid-session — hook layers (QUA-515)

The checklist is not a nice-to-have piece of paper the agent can forget exists. Two hooks surface and enforce it:

- **`.claude/hooks/inject-wip-checklist.sh`** (`UserPromptSubmit` event) — emits a compact `<system-reminder>` on every user turn with the progress count (`3/16 done`) and the slugs of still-unchecked items. If the file is missing (quick-fix session, pre-init turn), the hook is a silent no-op. The point: the checklist is in the prompt on every turn, so "I forgot the file existed" is no longer a possible failure mode. Same mechanism `MEMORY.md` auto-context uses.
- **`.claude/hooks/verify-checklist-on-stop.sh`** (`Stop` event) — reads the agent's last assistant message from the transcript and checks for ship-intent phrases (`/agent-ship`, `ready to ship`, `ready for review`, `session done`, etc.). If the agent is trying to wrap the session AND there are still unchecked items, the hook blocks the stop (exit 2) and lists what's left. The hook is narrow on purpose: blocking every Stop would loop the agent on every turn, so it only fires at the moment of real shipping intent. Fails open on transcript read errors and no-ops when the checklist file is missing.

Both hooks are registered in `.claude/settings.json`. If you need to bypass one (e.g., debugging the hook itself), temporarily move the file aside — do not add an `env` bypass flag, the enforcement exists precisely because bypasses get left on.

To check items off during a session, edit `.claude/wip-checklist.md` directly: change `[ ]` to `[x]` for done items, or `[~]` with `<!-- N/A: reason -->` for items that don't apply. The Layer 1 reminder updates on the next user turn.

## Step 2: Session End — BEFORE considering work complete

### Step 2a: Enumerate every problem you observed this session — MANDATORY

Before running `/agent-ship` or `/agent-end`, produce an explicit list of **every problem you noticed during the session**, including ones that weren't part of your task. For each, mark one of three dispositions:

- `fixed` — resolved inside the PR(s) this session shipped. No ticket needed.
- `filed:QUA-NNN` — a Linear (or legacy GitHub) ticket exists. Paste the ID. If you're the one filing, file before ending.
- `deferred:<reason>` — knowingly not fixed and not filed. Reason must be one the user would accept (e.g., "out of scope and already known — see QUA-NNN", "speculative, no observed impact yet"). "I'll remember" is not a valid deferral.

This list should appear in your session-end summary to the user, verbatim. Example:

```
Observed this session:
- Build fails for entities without lastEdited         → filed:QUA-412
- Duplicate validation block in gate.ts               → deferred: tech debt, not blocking
- /internal/facts 404 on prod                         → fixed (this PR)
- QUA-156 marked Done but migration actually stuck    → filed:QUA-302 (Urgent)
```

You cannot end the session until every observation has a disposition. **"I'll remember for next time" is explicitly forbidden** — the 2026-04-11 incident cascade happened because problems were noticed but never tracked. See `.claude/rules/proactive-github-filing.md` § "Mandatory tracking — red flags" for which observations *must* be filed (not just deferred).

### Step 2b: Close out

**If shipping a PR:** Run `/agent-ship`. It verifies the checklist, polishes the PR, pushes, monitors CI, and closes the session.

**Multi-PR sessions — review each PR before the next one, not in a batch at the end.** When a single session ships N independent PRs in sequence (e.g. a coordinator clearing a ticket list), run `/agent-review-pr` *per PR* between ship and moving to the next ticket. Batching reviews to the end of the session means findings can only ship as follow-up PRs once the originals have merged — inverting the "review before ship" intent of `.claude/rules/dispatched-agent-review.md`. The 2026-04-13 tier1/tier2 session generated 3 follow-up PRs this way; one caught a real "fix-instance-not-system" miss (QUA-418 table dead-links) that grep-before-ship would have found in the original PR.

**If NOT shipping** (research, abandoned, maintenance): Run `/agent-end`. It marks the session as completed, updates Linear/GitHub issues, and cleans up local artifacts.

Every session should end with one of these. See `.claude/rules/pr-review-guidelines.md` for the full end-of-session workflow.

## Rescoping a ticket — MANDATORY enumeration

When you (as a coordinator or individual contributor) rescope a ticket based on new information — changing the stated scope, updating the work plan, or writing a correction comment — you MUST run the same live-enumeration step that the ticket's own dispatch brief would require.

**Specifically**: before posting a rescope comment that changes migration plans, CHECK constraint shapes, FK audit counts, row counts, or format distributions, run a direct data query (via prod wiki-server or the `/internal/data-quality` dashboard if its classifier is trustworthy for the columns in question) and paste the output into the rescope comment under an `### Enumeration` heading.

A rescope based on "I read the schema and believe X" is as unreliable as a migration written without `SELECT COUNT(*)`. **The mental model is not enough — you have to count the actual rows.**

This rule is the same lesson encoded in `.claude/rules/database-migrations.md` § "Adding CHECK constraints on enum columns", applied to a different context: that rule binds dispatch briefs and migration authors; this rule binds coordinators rewriting scope.

### Why the rule exists

Two real incidents in a single coordinator session on 2026-04-14 (QUA-408 work in slot a6) shipped because the dispatcher trusted code inspection instead of counting rows:

- **QUA-492 (halt)**: I wrote a dispatch brief saying "Phase 1 is 90% done — add CHECK constraints and delete legacy branches." Slot a15 ran the mandatory enumeration as its first step and discovered `entity_resources.resource_id` was 0% canonical (4,182 legacy rows), `resources.id` was 0% canonical (22,878 legacy rows), and `facts.fact_id` was only 65% canonical (776 legacy rows). The CHECK constraint would have failed `VALIDATE CONSTRAINT` against 35–100% of the target columns. Slot a15 halted cleanly per `.claude/rules/proactive-github-filing.md` § "Misdiagnosis discovered". I (the dispatcher) had never run the enumeration before writing the brief — I pattern-matched from the epic body's claim that "migration is done" and trusted it.
- **QUA-498 (incomplete rescope)**: After the QUA-492 halt, I rescoped QUA-498 from "design canonical format" to "populate `resources.stable_id` for NULL rows + migrate FKs to sid_". I inspected the schema, confirmed the column existed, and wrote the rescope comment. Shortly after, another session (QUA-503) ran a full enumeration and found 5,002 **bare10 legacy rows** I had missed — they had populated stable_ids in legacy format. My rescope was directionally correct but incomplete; Phase A as written would have shipped a CHECK constraint that rejected those 5,002 rows. Another potential re-halt.

Both incidents have the same shape: **read the code, find what you need, stop before running a data query, ship a brief that's wrong**. See QUA-492 / QUA-498 / QUA-503 comments and QUA-508 for the full discovery trail.

### Exceptions

Trivial rescopes that don't depend on data don't need enumeration:
- Renaming a ticket
- Adding a pointer to a related ticket
- Correcting a typo in the description
- Changing priority or assignee

The rule fires when the rescope **changes data assumptions** — row counts, format distributions, schema state, FK populations, migration shapes, CHECK constraint contents.

## Why this matters

- PRs give the user a chance to review before changes land on main
- The checklist catches issues that are easy to skip under time pressure (security review, no regressions, CI green)
- It creates a paper trail of decisions for future sessions
- Skipping it is how things like "forgot to verify CI" or "no tests written" happen
- Rationalizing "I'll do it after I read a couple files" reliably leads to skipping it — the rule must be unconditional
