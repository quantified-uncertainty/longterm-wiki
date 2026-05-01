# Linear Refactor — 2026-04-14

One-page summary of the Linear hygiene / project / epic / description deep-audit pass that ran during a 2026-04-14 agent session. This doc is **historical reference only** — all findings were fixed during the session. The ongoing tooling that replaces ad-hoc audits is `crux linear hygiene` (added in this pass).

Linked from:

- [`docs/audits/README.md`](./README.md)
- [`docs/agent-rules/linear-project-ownership.md`](../../docs/agent-rules/linear-project-ownership.md) (the doctrine this session produced)
- [`docs/agent-rules/linear-integration.md`](../../docs/agent-rules/linear-integration.md) § 9 (hygiene tool reference)

## What triggered it

After completing the Tablebase Route Systematization project (QUA-367/454/455/456 + cleanup, 5 PRs), I ran a routine orphan-scan against the QUA team's open issues. The user's reaction — *"these aren't that many changes, given tons of issues. some have a bunch of labels, some have none"* — triggered a deeper pass that uncovered systematic label, description, and scope-boundary problems the first-pass audit missed.

## Methodology

Three parallel subagents analyzed a single snapshot dump of all 183 open QUA issues + 8 projects, each focused on a different dimension:

1. **Projects subagent** — scope drift, description staleness, inter-project overlap, dead umbrella refs
2. **Epics subagent** — parent-child hierarchy, orphaned sub-issues, epic candidates without structure
3. **Descriptions subagent** — stub markers, stale PR references, self-contained titles, vague temporal language

A verification pass then ground-truthed the load-bearing claims against live Linear state before execution (one subagent false positive was caught: QUA-385 is legitimate open work, not a done-and-forgot).

## Findings

### Project scope
- **16 orphan issues** (no project)
- **22 issues in the wrong project** — worst cluster: sourcing work split across 3 projects (Source-Check & Verification, Data Integrity, Automation & Infrastructure)
- **3 closed umbrella issues** still cited as "Current focus" in live project descriptions: QUA-110 (Source-Check parent umbrella, Done), QUA-356 + QUA-363 (Coordinator "HIGH priority", both Done)
- **2 projects at 97-83% progress** with single trailing issues — Tablebase Route Systematization and AI Power & Influence Mapping, both closable after moving the tagalongs

### Labels (the biggest surprise)
- **66% of issues had 0 labels** before cleanup
- **22 unique labels** in use, half of which were migration-era cruft from a past tool import:
  - `Migrated` (56 issues) — legacy one-shot marker
  - `priority:urgent/high/medium/low` (69 issues, 19 disagreeing with Linear's built-in priority field — evidence of one-way drift)
  - `model:haiku/sonnet/opus` (58 issues) — which LLM worked the issue, archaeology
  - `agent:filed` (38 issues) — "an agent filed this," always-true signal
  - 8 singleton labels (`groundskeeper-autofix`, `data-quality`, `tech-debt`, etc.)
- **`Bug` label at 2/189 coverage** — 10% of actual bugs had the label; filtering by `Bug` hid 90% of bugs
- **`content` label was 100% redundant** with Content Quality & Enrichment project — all 7 instances in that project
- **`epic` label was 100% redundant** with Linear's native parent-issue feature — all 3 instances had actual sub-issues

### Epic / parent-child hierarchy
- **QUA-183 "Coordinator & Agent Tooling" umbrella** was 64% done (7/11 children) but still in Backlog state — evidence of stale parent states across the team
- **QUA-362 "Epic: Finish EntityProfileShell migration — 12 detail pages remain"** had **zero sub-issues** despite explicitly calling itself an Epic in the title. 14 actionable detail pages listed in the body.
- **QUA-408 was closed** but had 4 open orphaned children (QUA-425, QUA-424, QUA-442, QUA-470)
- **7 issues orphaned from closed QUA-110** (Source-Check Quality Push) — intentional, continuing as independent work

### Descriptions
- 17% of open issues had detectable rot (mostly minor temporal-language drift)
- 2 P0 intake stubs with unresolved TBD/XXX markers (QUA-391, QUA-383) — judgment call: real bugs with minor nits in Scope sections, not blockers
- 1 false positive from the descriptions subagent (QUA-385 misread as "should-close" — actually legitimate follow-up work)

## Fixes applied

| Action | Count |
|---|---|
| Orphan issues assigned to projects | 16 → 0 (cleanup), 4 new drift by EOD |
| Duplicate issues closed | 1 (QUA-465 duplicate of QUA-470) |
| Project content rewrites | 2 (Coordinator, Source-Check) |
| Projects completed | 2 (Tablebase Route Systematization, AI Power & Influence Mapping) |
| Issues re-projected | 22 |
| Labels deleted (definitions) | 23 → 0 (full purge, Option B) |
| Label associations removed | ~204 |
| Priority fields synced from stale labels | 10 |
| Umbrella issues closed | 1 (QUA-183) |
| Epics decomposed | 1 (QUA-362 → 6 child issues QUA-485..QUA-490) |
| Parent title fixes | 1 (QUA-362 "12 pages" → "14 pages") |

## Before / after

| Metric | Before | After |
|---|---|---|
| Open issues | 194 | ~185 (8 closed mid-session + new filings) |
| Orphans | 16 (8%) | 0 |
| Duplicates | 1 | 0 |
| Active projects | 8 | 6 |
| Unique labels | 22 | 0 |
| Issues with ≥5 labels | 41 | 0 |
| Issues with 0 labels | 124 (66%) | 185 (100%) |
| Stuck "In Progress" (>14d) | 0 | 0 |
| Unprioritized | 33 (17%) | 23 (12%) |

## What this pass produced

1. **`crux/lib/linear/hygiene.ts`** + **`crux linear hygiene`** CLI command — re-runnable metadata hygiene scan (orphans, label coverage, priority gaps, stuck tickets, per-project counts). Run quarterly to catch drift.
2. **[`docs/agent-rules/linear-project-ownership.md`](../../docs/agent-rules/linear-project-ownership.md)** — the scope-boundary doctrine that now prevents the 3-way sourcing split from re-emerging, clarifies dashboards vs automation, and lists what doesn't belong in Coordinator.
3. **This document** — archive of the 2026-04-14 findings, linked from the README and rule docs so it's findable when someone asks "why did we do X with labels / projects / QUA-183?"

## The one takeaway for future agents

**Labels were the real discovery.** The team had been running for months with a label taxonomy inherited from a past tool migration, where labels duplicated the built-in priority field, tracked which LLM worked the issue, or were pure migration markers. 66% of issues had 0 labels anyway — the team had effectively decided not to use labels, without actually deleting them. The aggressive fix (Option B: zero labels, use projects + priority + parent-issue hierarchy for everything) matched actual team behavior and removed decision anxiety about whether to label new issues.

If label hygiene drifts back into "some issues have many, some have none," that's evidence the same thing is happening again — trust the empty state over the populated one, because the empty state reflects revealed preference.

## Cross-references

- **Rule**: [`docs/agent-rules/linear-project-ownership.md`](../../docs/agent-rules/linear-project-ownership.md) — scope-boundary doctrine derived from this audit
- **Tool**: `pnpm crux linear hygiene` (source: `crux/lib/linear/hygiene.ts`, `crux/commands/linear.ts`)
- **Related audit**: [`docs/audits/things-denormalization-audit.md`](./things-denormalization-audit.md) — adjacent-dimension audit for PG write-site inventory
