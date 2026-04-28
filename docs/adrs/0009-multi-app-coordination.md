# ADR-0009: Multi-app coordination

## Status

`Charter`

## Context

The repo has 4 deployable apps under `apps/`:

- `apps/web` — Next.js frontend (~111K LOC, the main wiki UI)
- `apps/wiki-server` — Hono API + PG (~48K LOC, all the data)
- `apps/groundskeeper` — scheduled task daemon (the "always-on" maintenance worker)
- `apps/discord-bot` — Discord notifications/commands

Plus `crux/` (the CLI/tooling) and `packages/` (factbase, id-utils, url-utils — shared libs).

Coordination today is implicit:

- Type sharing through workspace packages and `apps/wiki-server/src/api-types.ts`
- The `jobs` table + handler registry in `crux/lib/job-handlers/` is the queue, but groundskeeper has its own scheduler with `node-cron`, and the worker app (`crux/worker/run.ts`) runs handlers
- New ingest pipelines land sometimes in groundskeeper (auto-update enqueue), sometimes in crux (system-cards extract), sometimes in wiki-server worker handlers (claim-sourcing)
- No clear principle for "what goes in which app"

## Question

What are the right boundaries between the 4 apps? Where is duplication causing pain, and where is coupling preventing useful changes?

Specifically:

1. Should `apps/groundskeeper` be collapsed into the wiki-server worker, or promoted to own all scheduled work?
2. Where do new ingest pipelines belong — and what's the principle?
3. What's the type-sharing story (the existing `api-types.ts` re-export, or something stronger like tRPC / Hono RPC?)
4. Are there code paths that genuinely need to live in multiple apps, or is duplication accidental?

## What counts as a decision

A clear principle for "what goes in which app" plus specific moves:

- **App roles** — one-line definition of each app's responsibility
- **Specific moves** — e.g., "collapse groundskeeper into wiki-server's worker process" or "promote groundskeeper to own all scheduled work; wiki-server stops accepting cron-style handlers"
- **Type-sharing approach** — keep current pattern, or adopt X
- **Future-pipeline rule** — when a new ingest needs to be added, where does it go?

## In scope

- Dependency graph between apps and crux
- Type sharing audit (where do types flow, where are they duplicated)
- Duplicated logic enumeration (run-tracking, scheduling, error handling, etc.)
- Deploy coordination complexity (currently 4 separate deploy pipelines)
- Implications of ADR-0006's wiki-server decomposition decision

## Out of scope

- Actually moving code between apps (downstream implementation)
- Discord bot scope changes (orthogonal product question)

## Time-box

5 working days from charter to decision.

## Success criteria

ADR ends with named app roles + specific moves + a future-pipeline rule. "Status quo" is acceptable but must defend why the current ambiguity about ingest-pipeline placement is OK.

## Dependencies

- **Blocked by:** ADR-0006 (wiki-server decomposition affects what groundskeeper should own)
- **Blocked by (soft):** ADR-0001 (crux package architecture affects type-sharing story)
