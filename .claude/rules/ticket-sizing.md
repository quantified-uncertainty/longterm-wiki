# Ticket Sizing — Catch Oversized Tickets at Filing Time

Every oversized ticket — the kind an agent has to split mid-session — has a detectable red flag at filing time. This rule lists them, and what to do when you see one.

## Why this rule exists

Between 2026-04-13 and 2026-04-17, at least 5 tickets had to be split after dispatch: QUA-24 (plumbing + execution mixed), QUA-549 (17 FK tables, one PR per table was wrong — ended up as 9 sub-tickets), QUA-22 (pilot + long tail), QUA-556 (audit + implement), and others. Every late discovery cost ~30-60min of coordination overhead and a context rebuild for the next agent.

All 5 had at least one of the red flags below, visible at the moment the ticket was filed.

## Red flags — split before dispatch if any are present

| Red flag | Why it's a problem | Example |
|---|---|---|
| **≥3 tables or code surfaces affected** | PR spans multiple review areas; test + CI surface explodes | QUA-549 (17 FK tables), QUA-24 (divisions + personnel + funding + benchmarks) |
| **Mixed shapes in one ticket** | Plumbing + execution, migration + backfill, audit + implement — each shape has a different completion semantic | QUA-24 (extend scanner AND run enrichment), QUA-556 (audit AND decide AND implement) |
| **"Phase" / "Wave" language in title or body** | Implies multi-step; each step is usually its own PR | QUA-492 "Phase 1 closeout", QUA-549 "Phase B" |
| **Row counts >1K requiring batching** | Batch execution is budget-gated, not PR-gated; should be a separate ticket from the plumbing that enables it | QUA-545 (610 facts), QUA-536 (17,750 rows) |
| **"and" connecting two different deliverables** | Almost always splittable at the "and" | "Scanner and improve pipeline", "Audit and fix" |
| **Umbrella-like title** | "Bring all X to Y state", "Complete all Z", "Finish all N" | QUA-544 umbrella — intentionally, with child tickets |

## What to do when you see a red flag

1. **Stop before creating the ticket.** Don't file a ticket you know will need splitting.
2. **Decompose into session-sized children.** Each child should fit one PR OR one budget-gated batch, not both.
3. **File a parent** if the decomposition is cleaner with a parent (e.g., epic + 4 children). File children first, then parent referencing them.
4. **If the ticket is legitimately large and atomic** (no decomposition possible), file it with `--allow-big` on `crux linear create`. This bypasses the warning but flags it for review.

## Session-sized = what?

A well-sized ticket fits one of these shapes:

- **PR-shaped**: 1-5 files touched, acceptance criteria verifiable in ~2 hours, stated diff shape fits in one sentence.
- **Batch-shaped**: single budget line item, single data-run acceptance (row counts, coverage %), no code changes.
- **Design-shaped**: produces a doc or decision, ≤2 days, acceptance is "doc merged" or "decision comment posted".

Anything mixing two of those shapes needs to split.

## Group by code footprint, not row count

The QUA-549 lesson: a migration across 17 tables can't be split by table. Tables with 1 FK reference need ~1 file of changes; tables with 12 FK references need ~12 files and more review. Group tables that touch similar code footprints into one ticket; split when the footprint diverges.

## Pre-dispatch sanity check

Before writing a dispatch brief for any ticket, answer in one sentence each:

- "What's the PR diff shape?" — If you can't describe it in 20 words, the ticket is too big.
- "What's the acceptance check?" — If there are two unrelated checks, the ticket is two tickets.
- "How long will this take?" — Over ~4 hours of wall time suggests decomposition.

If any answer is vague, decompose before dispatching. This is 10 minutes of coordinator time that saves 30-60 minutes of agent churn.

## Relation to planning docs

Plan documents under `docs/plans/` already enumerate scope by shape. When a plan calls out "Plumbing P1" or "Execution E1", those are session-sized by construction. Tickets filed from plans inherit the sizing; tickets filed ad-hoc do not — which is where this rule matters most.

## See also

- `.claude/rules/dispatched-agent-review.md` § Dispatcher pre-flight
- `.claude/rules/linear-project-ownership.md` — project assignment at filing time
- `docs/plans/` — current planning docs apply this rule implicitly
