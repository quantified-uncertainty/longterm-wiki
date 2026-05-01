# ADR-0002: Three Bases model review

## Status

`Charter`

## Context

The data architecture is conceptually organized into three layers:

- **TableBase** — typed relational records (entities, resources, publications, grants, personnel)
- **FactBase** — structured triples with temporal data and provenance
- **WikiBase** — long-form prose MDX articles

Documented in `content/docs/internal/data-architecture.mdx` (E1334) and `docs/agent-rules/three-bases-architecture.md`.

The model has evolved since it was conceived:

- TableBase has both YAML authoritative + PG read mirror
- FactBase is mid-flight to becoming PG-primary (QUA-408 Data Model Unwind)
- The `things` table cuts across all three as a universal search index
- Soft FKs via `entities.stable_id` everywhere — no enforced base separation
- A `Fact` interface in `tablebase.ts` exists for legacy reasons
- Citations dual-write to sourcing
- Cross-base operations (citation accuracy → sourcing, FactBase entity ID → TableBase entity ID) have accumulated workarounds

The conceptual purity is showing seams. Before the FactBase PG-primary migration finishes, this is the moment to confirm or refine the model. Afterward, course-correcting is significantly harder.

## Question

Is the TableBase / FactBase / WikiBase decomposition still the right conceptual model for the data layer?

If yes — what explicit rules should govern cross-base interactions to keep the model load-bearing?

If no — what's the alternative decomposition, and what's the migration path?

## What counts as a decision

One of:

- **Confirm with rules** — Three Bases stays, and these N explicit rules govern cross-base operations (e.g., "no direct FK across bases; always go through `entities.stable_id`").
- **Refine** — Three Bases stays but with X structural change (e.g., "promote `things` to first-class; bases become views").
- **Replace** — Three Bases is the wrong frame; here's the alternative (e.g., domain-driven services, single unified data model with type discriminators).

## In scope

- Review the 10 most painful cross-base operations from the last 6 months (citations dual-write, FactBase ↔ TableBase ID coordination, things-table denormalization fallout, etc.)
- For each: would a different decomposition have made this easier or harder?
- Alternative decompositions considered with tradeoffs
- Implications for the in-flight FactBase PG-primary migration (QUA-408)
- Implications for new ingest pipelines being added (frameworks, system-cards, third-party-evals)

## Out of scope

- The mechanical schema.ts split (downstream of this ADR)
- The wiki-server decomposition (ADR-0006, depends on this conclusion)
- Changes to the YAML authoring workflow

## Time-box

5 working days from charter to decision.

## Success criteria

ADR ends with one of three outcomes above, with the rationale explicit and the consequences for downstream ADRs (especially ADR-0006) named. **Confirming the model is a valid outcome** — the value is in the deliberate review, not in finding something to change.

## Dependencies

- **Blocks:** ADR-0006 (wiki-server decomposition)
- **Blocked by:** none
