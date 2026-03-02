# Retrospective

Analyze recent PR patterns, session logs, and development process to identify what's working, what's not, and what to change. Produces a written report focused on process improvements.

**Recommended cadence:** Weekly, or after a particularly intense development period.

**Relationship to other commands:**
- `/maintain` handles tactical cleanup (close issues, fix cruft)
- `/audit` reviews codebase health and complexity
- `/retrospective` reviews the development *process* — how work is getting done, not what the code looks like

## Phase 1: Gather Data

Collect recent development activity. Default lookback is 7 days; adjust with the date range in the commands below.

```bash
# Merged PRs in the last 7 days
gh pr list --state merged --limit 50 --json number,title,additions,deletions,mergedAt,author,labels --jq '.[] | select(.mergedAt > (now - 7*86400 | strftime("%Y-%m-%dT%H:%M:%SZ")))' 2>/dev/null || echo "gh CLI unavailable — check GITHUB_TOKEN"

# PR size distribution
gh pr list --state merged --limit 50 --json number,title,additions,deletions,mergedAt --jq '.[] | select(.mergedAt > (now - 7*86400 | strftime("%Y-%m-%dT%H:%M:%SZ"))) | "\(.number)\t+\(.additions)/-\(.deletions)\t\(.title)"' 2>/dev/null

# Session logs from the period
pnpm crux maintain review-prs --since=$(date -v-7d +%Y-%m-%d) 2>/dev/null || echo "review-prs unavailable"

# Recent commit classification (feature vs fix vs refactor)
git log --since="7 days ago" --oneline | head -50

# Open issues snapshot
gh issue list --limit 30 --json number,title,labels,createdAt --jq '.[] | "\(.number)\t\(.labels | map(.name) | join(","))\t\(.title)"' 2>/dev/null
```

Also read the session log review from `crux maintain` output if available — it extracts issues and learnings from session logs and flags recurring problems.

## Phase 2: Analyze Patterns

Work through each of these lenses. Use the data from Phase 1 as evidence.

### 2a. PR Patterns

**Fix chains:** Look for sequences where a feature PR was followed by 2+ fix PRs. These indicate the original PR shipped incomplete or without sufficient testing. List specific chains by PR number.

**Size distribution:** Flag any PRs over 500 lines added. Were they reviewable? Could they have been split?

**Feature vs. fix ratio:** Count how many PRs were new features vs. bug fixes vs. infrastructure. A healthy ratio depends on project phase, but if fixes outnumber features 3:1, something is wrong upstream.

**Revert/close rate:** Were any PRs closed without merging or reverted? Why?

### 2b. Session Log Analysis

Read the session log issues and learnings from the `crux maintain review-prs` output. Look for:

**Recurring friction:** Problems that appear in 2+ session logs. These are systemic issues worth fixing at the root.

**Time sinks:** Sessions that spent most of their time on setup, debugging infrastructure, or fighting tooling rather than delivering value.

**Learnings that weren't propagated:** Session log learnings that should have been added to CLAUDE.md, rules files, or common-issues.md but weren't.

### 2c. Agent-Filed Issues Quality

If agents filed issues during the period, review them:
- Are they specific and actionable, or speculative?
- Do they correspond to real bugs or concrete tech debt?
- Were any duplicates of existing issues?

### 2d. CI and Tooling

- Did CI break during the period? How long was it broken?
- Were there any gate check false positives or false negatives?
- Did any tooling changes cause downstream problems?

### 2e. Content vs. Infrastructure Balance

Count:
- Wiki content pages created or substantively updated
- Lines of infrastructure code added (net)
- Number of internal dashboards or monitoring systems added

Is the ratio reasonable for the project's current goals?

## Phase 3: Write the Report

### Report structure

```
## Retrospective — [DATE RANGE]

### Summary Stats
- PRs merged: X
- Net lines: +X/-Y
- Content pages updated: X
- Fix-to-feature ratio: X:Y
- Largest PR: #N (+X lines)

### What Went Well
[2-4 specific things that worked, with evidence]

### What Didn't Go Well
[2-4 specific problems, with PR numbers and details]

### Fix Chains
[List each chain: Feature PR → Fix 1 → Fix 2 → ...]

### Recurring Friction
[Problems that appeared in multiple sessions]

### Process Recommendations
[Specific, actionable changes — not vague "we should do better"]
Each recommendation should state:
- What to change
- Why (with evidence from this retrospective)
- Expected impact
```

## Phase 4: Act

For each recommendation:
- **Process changes** (updating rules, CLAUDE.md, or conventions): Make the change now if it's clear-cut, or note it for user discussion if it involves tradeoffs.
- **Tooling fixes**: File a GitHub issue if you can't fix it in this session.
- **Propagate learnings**: Update `.claude/rules/` or `CLAUDE.md` with any recurring patterns identified.

## Guardrails

- **Be specific.** "PRs are too big" is not useful. "#1453 was 2,246 lines because the semantic diff module was added as a single PR instead of being split into core + tests + integration" is useful.
- **Praise what works.** The report should include positive observations, not just problems. Reinforcing good patterns is as important as flagging bad ones.
- **Recommendations must be actionable.** "Improve code quality" is not a recommendation. "Add a 500-line soft cap to the PR template with a checklist item asking whether the PR can be split" is.
- **Don't relitigate closed decisions.** If something was decided and shipped, evaluate the outcome rather than arguing it should have been done differently.
- **Keep it short.** The report should be readable in 5 minutes. If it's longer, the most important findings will get lost.
