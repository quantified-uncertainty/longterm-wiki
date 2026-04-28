# ADR-0001: Crux package architecture

## Status

`Charter`

## Context

`crux/` is 247K LOC across 1,290 TypeScript files — 2.2× the size of `apps/web`. It currently mixes:

- A user-facing CLI (entry point `crux/crux.mjs`, command files in `crux/commands/`)
- Agent workflow infrastructure (agent-checklist, dispatch, ship/end, PR patrol)
- Ingestion pipelines (auto-update, frameworks, system-cards, third-party-evals, AIID)
- 97 validators (the gate system)
- A typed RPC client to the wiki-server
- One-shot historical migration scripts (some never retired)
- Several apparently-dead subdirectories (`entity-matrix/`, `calibration/`, `pr-review/`, `worker/` per the 2026-04-27 audit)

There is no explicit boundary between these. Every "where does this go?" question lands in `commands/` or `lib/` by default. The longer this grows, the harder a structural reorganization becomes. A prior 7-agent investigation (2026-04-27) confirmed ~5.6K LOC of dead subdirectories and ~3.5K LOC of one-shot scripts, but the deeper question — what *is* `crux/` supposed to be — was deferred to this ADR.

## Question

How should `crux/` be organized? Specifically:

1. Should it be split into multiple workspace packages with explicit contracts (e.g., `@lw/cli`, `@lw/agent-tools`, `@lw/ingest`, `@lw/validate`, `@lw/wiki-client`, `@lw/internal-scripts`)?
2. Or restructured internally with stricter directory conventions but no package boundary?
3. Or left as-is with only dead-code removal?

## What counts as a decision

A package-architecture proposal naming N packages, their public contracts (exports), their dependency graph (which depends on which), and a phased migration plan. Or an explicit "stay as one directory but enforce these internal modules with this mechanism."

A bare deletion list does NOT count — that's downstream tactical work.

## In scope

- Dependency analysis: who imports what within `crux/`
- Boundary proposals: 1, 3, 5, 7-package options with tradeoffs
- Migration sequencing: which package extracts first, what blocks each phase
- Naming conventions for the proposed packages
- Impact on `crux.mjs` startup time, import resolution, agent context size

## Out of scope

- Actually executing the migration (downstream implementation tickets)
- Deletion of dead code (covered by separate cleanup tickets)
- Changes to the wiki-server or apps/web

## Time-box

5 working days from charter to decision.

## Success criteria

ADR ends with `Status: Accepted` (with named package architecture + migration plan) or `Status: Rejected` (with explicit reason — e.g., "monolithic crux/ is correct, here's why"). Either is acceptable.

## Dependencies

- **Blocks (soft):** ADR-0009 (multi-app coordination — type-sharing story depends on whether crux is one or many packages)
- **Blocked by:** none
