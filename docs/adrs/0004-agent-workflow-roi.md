# ADR-0004: Agent workflow infrastructure ROI

## Status

`Charter`

## Context

The agent workflow infrastructure is large and growing:

- `CLAUDE.md` (18KB)
- 29 rule files in `.claude/rules/` (~180KB total)
- 17 hooks in `.claude/hooks/`
- 3 skills in `.claude/skills/`
- `agent-checklist` system (init, snapshot, validation)
- Dispatch system (`crux sys dispatch` with pre-flight checks, dedup)
- Linear-GH integration (auto-close, branch dedup, ship workflow)
- PR patrol (health gate, fleet-level signals)
- Subagent permissions hooks
- Many crux commands supporting the lifecycle

Each piece was added in response to a specific incident or pattern (QUA-302 deploy stuck, QUA-406 duplicate work, QUA-440 dedup hardening, the 2026-04-11 cascade, QUA-515 enforcement layers). The aggregate, however, may be over-built — some guardrails could be preventing problems that no longer occur because the rest of the system caught up.

A prior 7-agent investigation (2026-04-27) categorized all 29 rules as "load-bearing" but acknowledged this was a quick read. The deeper question of incident recurrence per rule was deferred to this ADR.

## Question

For each piece of agent workflow infrastructure (rules, hooks, dispatch checks, dedup layers):

1. What incident drove its creation?
2. Has the underlying cause been fixed elsewhere, or is the rule still the only thing preventing recurrence?
3. Is the cognitive overhead per session (rule must be loaded, understood, applied) worth the rate of incidents prevented?
4. Are some pieces overlapping enough to merge or delete?

## What counts as a decision

Per-piece disposition:

- **Load-bearing** (keep — incident pattern is permanent and this is the only mitigation)
- **Scar tissue** (delete — incident was fixed elsewhere; this rule is no longer needed)
- **Mergeable** (combine with X — overlapping with another rule)
- **Distillable** (compress to 1 paragraph in CLAUDE.md or a parent rule)
- **Reframe** (the rule is right but the incident framing is wrong; rewrite focused on the actual mechanism)

Plus principles for when to add new agent workflow infrastructure (what's the bar?).

## In scope

- Incident archaeology for each rule (originating QUA-NNN or commit, recurrence in last 90 days)
- Per-hook analysis (when does it fire, what does it block, how often, is it ever wrong)
- Cognitive overhead estimate (per-rule context tokens consumed in average session)
- Overlap mapping (rules that say partially the same thing)
- Recommendations: 29 rules → N rules; 17 hooks → M hooks
- Principles for adding future workflow rules

## Out of scope

- Rewriting the agent-checklist system itself
- Designing entirely new rules (separate ADRs if needed)
- Changes to skills (3 of them, low surface area)

## Time-box

5 working days from charter to decision.

## Success criteria

ADR ends with named deletions/merges/distillations (e.g., "29 → 22 rules with these specific changes"). A "keep all 29" outcome is acceptable but must defend each rule against the recurrence test, not just rest on the prior investigation's quick-read result.
