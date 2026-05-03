# Architecture Decision Records

This directory contains ADRs (Architecture Decision Records) for the longterm-wiki codebase. Each ADR documents one significant architecture or design decision, with the investigation that led to it.

## Why ADRs

Decisions about the codebase's shape — how services are split, what patterns are canonical, what gets deleted — recur over time. Without a written record, the same conversation happens every 6 months and reaches a different conclusion. ADRs make decisions:

- **Versioned** — superseded ADRs stay readable; you can trace a decision's genealogy
- **Searchable from agent context** — future Claude Code sessions can grep `docs/adrs/` for "have we already decided this?"
- **Stable** — survives Linear/GitHub schema changes
- **Explicit** — every accepted decision has named consequences and follow-up tickets

## Format

ADRs follow a [MADR](https://adr.github.io/madr/)-inspired template. See `0000-template.md`.

## Lifecycle

```text
Charter → Proposed → Accepted | Rejected
                  ↘ Superseded by ADR-NNNN
```

- **Charter** — question and scope defined; investigation not yet started
- **Proposed** — investigation complete, decision drafted, awaiting review
- **Accepted** — decision committed; follow-up tickets filed
- **Rejected** — investigated; decided not to proceed
- **Superseded** — replaced by a later ADR

## Index

| ADR | Title | Status | Wave | Linear |
|-----|-------|--------|------|--------|
| [0001](0001-crux-package-architecture.md) | Crux package architecture | Charter | 1 | TBD |
| [0002](0002-three-bases-model-review.md) | Three Bases model review | Charter | 1 | TBD |
| [0003](0003-validator-economics.md) | Validator economics | Proposed | 1 | [QUA-1085](https://linear.app/quantifieduncertainty/issue/QUA-1085) |
| [0004](0004-agent-workflow-roi.md) | Agent workflow infrastructure ROI | Charter | 1 | TBD |
| [0005](0005-content-quality-trends.md) | Content quality and staleness governance | Charter | 1 | TBD |
| [0006](0006-wiki-server-decomposition.md) | Wiki-server decomposition | Charter | 2 | TBD |
| [0007](0007-observability-strategy.md) | Observability strategy | Charter | 2 | TBD |
| [0008](0008-internal-dashboards-layer.md) | Internal dashboards layer | Charter | 2 | TBD |
| [0009](0009-multi-app-coordination.md) | Multi-app coordination | Charter | 2 | TBD |

## Pipeline

Each investigation runs through 4 stages:

1. **Charter** — write the kickoff (question, scope, success criteria, time-box)
2. **Dispatch** — agent does the deep dive, drafts findings into the ADR
3. **Red-team** — separate agent (or human) challenges the draft, looks for missed options and undisclosed risks
4. **Decide** — convert to Accepted/Rejected; file implementation tickets in the appropriate execution Linear projects

**Time-box: 5 working days per ADR.** If undecided at the deadline, default to status quo and revisit in 6 months. Open-ended investigation is procrastination dressed up as rigor.

## Adding a new ADR

```bash
cp docs/adrs/0000-template.md docs/adrs/NNNN-<slug>.md
# Fill in Status (Charter), Context, and the Question
# Update this README's index
# File a Linear sub-issue under the umbrella with the charter content
```

## Principles

- **One question per ADR.** Bundling unrelated decisions makes them unreversible. Cross-references are fine; merged decisions are not.
- **Decisions are the deliverable, not analysis.** An ADR that doesn't end in either "we will X" or "we explicitly chose to defer because Y" failed.
- **Every load-bearing claim needs a citation.** `file:line`, git query, or external link. Red-team verifies samples.
- **No "Proposed forever."** Force a decision at the time-box, even if it's "stay with status quo and revisit in 6 months." Indecision is itself a decision and should be acknowledged as such.

## See also

- The umbrella Linear ticket for the current investigation wave (link TBD when filed)
- `docs/agent-rules/linear-project-ownership.md` — for filing follow-up implementation tickets in the right execution project
