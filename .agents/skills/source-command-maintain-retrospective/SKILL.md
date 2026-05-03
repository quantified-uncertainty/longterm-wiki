---
name: "source-command-maintain-retrospective"
description: "Analyze recent PR patterns, session logs, and development process. Produces a process improvements report."
---

# source-command-maintain-retrospective

Use this skill when the user asks to run the migrated source command `maintain-retrospective`.

## Command Template

# Retrospective

Analyze recent PR patterns, session logs, and development process to identify what's working, what's not, and what to change. Produces a written report focused on process improvements.

**Recommended cadence:** Weekly, or after a particularly intense development period.

**Relationship to other commands:**
- `/maintain` handles tactical cleanup (close issues, fix cruft)
- `/maintain-audit` reviews codebase health and complexity
- `/maintain-retrospective` reviews the development *process* — how work is getting done, not what the code looks like

## Phase 1: Gather Data

Collect recent development activity. Default lookback is 7 days; adjust with the date range in the commands below.

```bash
# Merged PRs in the last 7 days
gh pr list --state merged --limit 50 --json number,title,additions,deletions,mergedAt,author,labels --jq '.[] | select(.mergedAt > (now - 7*86400 | strftime("%Y-%m-%dT%H:%M:%SZ")))' 2>/dev/null || echo "gh CLI unavailable — check GITHUB_TOKEN"

# PR size distribution
gh pr list --state merged --limit 50 --json number,title,additions,deletions,mergedAt --jq '.[] | select(.mergedAt > (now - 7*86400 | strftime("%Y-%m-%dT%H:%M:%SZ"))) | "\(.number)\t+\(.additions)/-\(.deletions)\t\(.title)"' 2>/dev/null

# Session logs from the period
pnpm crux sys maintain review-prs --since=$(date -v-7d +%Y-%m-%d) 2>/dev/null || echo "review-prs unavailable"

# Recent commit classification (feature vs fix vs refactor)
git log --since="7 days ago" --oneline | head -50

# Open issues snapshot
gh issue list --limit 30 --json number,title,labels,createdAt --jq '.[] | "\(.number)\t\(.labels | map(.name) | join(","))\t\(.title)"' 2>/dev/null
```

Also read the session log review from `crux sys maintain` output if available — it extracts issues and learnings from session logs and flags recurring problems.

### Codex Usage Patterns

Analyze the user's actual Codex conversation logs to understand how they interact with the tool:

```bash
# Usage patterns from the same period (reads ~/.codex/projects/ JSONL files)
pnpm crux sys usage-patterns --since=$(date -v-7d +%Y-%m-%d 2>/dev/null || date -d '7 days ago' +%Y-%m-%d) 2>/dev/null || echo "usage-patterns unavailable"
```

This surfaces: message style distribution (questions vs directives), slash command frequency, tool usage rankings, session timing (by hour/day), entrypoint breakdown (CLI vs mobile vs web), and session length distribution. Use this data in Phase 2 analysis.

**Note:** On a multi-slot setup (lw/a1–a15), each slot has its own `~/.codex/projects/` directory. To get a full picture, run with `--dir=` pointing to each slot's home, or run on the main machine where all slots are visible.

## Phase 2: Analyze Patterns

Work through each of these lenses. Use the data from Phase 1 as evidence.

### 2a. PR Patterns

**Fix chains:** Look for sequences where a feature PR was followed by 2+ fix PRs. These indicate the original PR shipped incomplete or without sufficient testing. List specific chains by PR number.

**Size distribution:** Flag any PRs over 500 lines added. Were they reviewable? Could they have been split?

**Feature vs. fix ratio:** Count how many PRs were new features vs. bug fixes vs. infrastructure. A healthy ratio depends on project phase, but if fixes outnumber features 3:1, something is wrong upstream.

**Revert/close rate:** Were any PRs closed without merging or reverted? Why?

### 2b. Session Log Analysis

Read the session log issues and learnings from the `crux sys maintain review-prs` output. Look for:

**Recurring friction:** Problems that appear in 2+ session logs. These are systemic issues worth fixing at the root.

**Time sinks:** Sessions that spent most of their time on setup, debugging infrastructure, or fighting tooling rather than delivering value.

**Learnings that weren't propagated:** Session log learnings that should have been added to AGENTS.md, rules files, or common-issues.md but weren't.

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

### 2f. Usage Patterns (from Codex logs)

Using the `crux sys usage-patterns` output from Phase 1:

**Interaction style:** What's the question-to-directive ratio? A high question ratio may indicate the user is exploring/uncertain; a high directive ratio means they know what they want. Look for shifts over time.

**Session efficiency:** Are there many short sessions (≤2 messages)? These may indicate false starts, misrouted tasks, or sessions that should have been combined. Flag if short sessions exceed 30% of total.

**Entrypoint distribution:** Where is the user primarily working from (CLI, mobile, web, IDE)? Different entrypoints suggest different usage contexts — mobile sessions tend to be shorter and more conversational.

**Tool usage trends:** Which tools dominate? If Bash dominates over dedicated tools (Grep, Read, Edit), the agent may not be using the right tools. If Agent subagent calls are very high, check whether they're being used efficiently.

**Slash command adoption:** Which slash commands are used most? Are there commands that should be used more (e.g., `/agent-init` should appear in most sessions)?

**Timing patterns:** When does the user work? Are there productivity peaks at certain hours? Weekend vs weekday distribution?

**Optimization opportunities:** Based on all the above, identify 2-3 concrete suggestions for improving the user's workflow. Examples:
- "You ask 'where is X' frequently — consider using the Explore agent or grep more"
- "40% of sessions are from mobile with short messages — consider a mobile-optimized prompt template"
- "You rarely use /maintain — consider scheduling it weekly"

The output of Phase 2 is a *draft* recommendation list. Do not write the final report yet — Phase 3 fact-checks each draft.

## Phase 3: Verify Recommendations

**Most retrospective recommendations sound right at first glance and turn out to be misinformed when fact-checked.** Before writing the final report, run each draft recommendation through verification. This phase exists because the 2026-04-29 retro produced 4 recommendations and 3 were wrong on inspection (one was already-filed, one was a misdiagnosis, one was about an intentionally-long-running epic that should not be triaged).

For each draft recommendation, do all three steps:

### 3a. Linear-search for existing tickets

```bash
pnpm crux linear search "<2-3 keyword variants>"
```

Read the top hits. The work may already be tracked:
- **Open + actively-tracked** (recent comments / updates) → cite as `prioritize:QUA-NNN`. Do not re-file.
- **Closed as duplicate / Done** → check whether the closed work actually addressed your concern. Often `drop:already-tracked`.
- **Backlog with no activity in >30 days** → may be `new` (file or update), but note the relationship.

### 3b. Verify the diagnosis with a current-state check

Confirm the problem still exists with concrete evidence:
- Recommending a baseline cleanup? Read the actual baseline file + current count.
- Recommending a rename sweep? `grep` for the pattern; count results.
- Calling a ticket "stuck"? Read its recent comments — it may be intentionally long-running.
- Pointing at a "leaking integration" or auto-filer? Trace the code path to confirm the mechanism, not just the symptom.

If verification falsifies the diagnosis, **drop the recommendation**. Do not reframe it to fit the data.

### 3c. Pick a disposition for each recommendation

| Disposition | Meaning | Action |
|---|---|---|
| `new` | Novel finding, not yet tracked, user-actionable | File or implement; include in report |
| `prioritize:QUA-NNN` | Already tracked; retro's value is signaling priority | Cite ticket; optionally comment with retro evidence (skip if ticket is rich) |
| `drop:already-tracked` | Tracked + ticket is rich enough that more evidence is noise | Mention in passing; no new filing |
| `drop:misdiagnosed` | Verification falsified the premise | Surface as a meta-finding about the retro itself |

### 3d. Honesty rule

If verification reveals the original framing was wrong, **say so in the report**. A retrospective that buries its own misdiagnoses to look polished is worse than no retrospective. List `drop:misdiagnosed` items in the report so the reader can recalibrate their trust in the rest.

## Phase 4: Write the Report

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
- What to change (or: which existing ticket to prioritize)
- **Disposition** from Phase 3: `new` / `prioritize:QUA-NNN` / `drop:already-tracked` / `drop:misdiagnosed`
- Why (with evidence from this retrospective)
- Expected impact

Include `drop:*` items in the report — they reveal where the retro's pattern recognition was directionally off, which is information the reader needs to calibrate trust in the surviving recommendations.

### Usage Pattern Insights
- Sessions: X total, Y short (≤2 msgs), Z avg messages/session
- Interaction style: X% questions, Y% directives
- Top entrypoints: [CLI: N, mobile: N, web: N]
- Peak hours: [list top 3]
- Most-used slash commands: [top 5]
- Workflow optimization opportunities: [2-3 specific suggestions]
```

## Phase 5: Act

Drive each recommendation by its disposition (set in Phase 3):
- `new` — Make the change now if clear-cut, file a Linear ticket if not, or note for user discussion if it involves tradeoffs. Update `.claude/rules/` or `AGENTS.md` for recurring patterns.
- `prioritize:QUA-NNN` — Optionally post a comment on the existing ticket with this retro's evidence. Skip if the ticket is already rich.
- `drop:already-tracked` / `drop:misdiagnosed` — No further action; the disposition already lives in the report for next time.

## Guardrails

- **Be specific.** "PRs are too big" is not useful. "#1453 was 2,246 lines because the semantic diff module was added as a single PR instead of being split into core + tests + integration" is useful.
- **Praise what works.** The report should include positive observations, not just problems. Reinforcing good patterns is as important as flagging bad ones.
- **Recommendations must be actionable.** "Improve code quality" is not a recommendation. "Add a 500-line soft cap to the PR template with a checklist item asking whether the PR can be split" is.
- **Don't relitigate closed decisions.** If something was decided and shipped, evaluate the outcome rather than arguing it should have been done differently.
- **Keep it short.** The report should be readable in 5 minutes. If it's longer, the most important findings will get lost.
