# ADR-0006: Wiki-server decomposition

## Status

`Charter`

## Context

`apps/wiki-server/` is one Hono service with:

- 122 routes
- 5,009-line `schema.ts` covering ~110 PG tables
- Multiple unrelated domain concerns: TableBase sync, FactBase facts, WikiBase content, sourcing, citations, jobs queue, agent sessions, audit log, monitoring, enrichment

Costs of the monolith have shown up directly:

- **QUA-302** — 12-hour deploy stuck because a migration on one table held ACCESS EXCLUSIVE while a materialized view refresh held SHARE; the lack of internal boundaries meant the whole service stayed wedged
- **QUA-549** — single FK swap required 17 sub-PRs because the change cut across many table-coupled routes
- **Schema drift** — every new ingest pipeline (frameworks, system-cards, AIID, etc.) adds another route group, another set of tables, more cross-coupling

Schema-split is downstream of this — it's the cosmetic answer to a deeper question.

## Question

Should the wiki-server stay as one Hono service, become a domain-modulated monolith (internal bounded contexts), or split into multiple deployable services?

## What counts as a decision

One of:

- **(a) Status quo** — keep as monolith with no structural changes; defend why
- **(b) Modulated monolith** — keep as one deploy, but enforce internal modules with bounded contexts (Drizzle schemas split by domain, route groups own their tables, no cross-module imports)
- **(c) Worker split** — split off the queue/jobs/groundskeeper-style work into a worker service; user-facing API stays monolith
- **(d) Domain split** — full decomposition into multiple services (e.g., `sourcing-service`, `tablebase-service`, `wikibase-service`) with shared types package

With migration plan, deploy implications, and operational cost named. Status quo is acceptable but must defend why monolith costs (QUA-302, QUA-549 patterns) don't justify a split.

## In scope

- Route grouping by data ownership (which routes touch which tables exclusively)
- Cross-group dependency analysis (does the sourcing API call into TableBase? does FactBase need to know about wiki pages?)
- Deploy coupling: what would break if X moved
- Cost of each option (engineering, operational, testing, type-sharing infrastructure)
- Implications for the existing crux RPC client (is it split or unified?)
- Implications for groundskeeper (currently a separate app — does it absorb the worker split or vice versa?)

## Out of scope

- The mechanical `schema.ts` split (downstream — its right shape depends on this decision)
- Actual implementation of any chosen path
- Changes to apps/web's API consumption

## Time-box

5 working days from charter to decision.

## Success criteria

ADR ends with one of (a)–(d) chosen, with explicit acknowledgement of which monolith costs the chosen path accepts as ongoing.

## Dependencies

- **Blocked by:** ADR-0002 (Three Bases conclusion changes the natural service boundaries)
- **Blocks:** ADR-0008 (internal dashboards layer), ADR-0009 (multi-app coordination)
