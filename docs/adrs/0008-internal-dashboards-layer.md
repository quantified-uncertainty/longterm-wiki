# ADR-0008: Internal dashboards layer

## Status

`Charter`

## Context

`apps/web/src/app/internal/` contains 32 dashboard pages — entity profiles, source-check coverage, system health, agent activity, jobs queue, page changes, improve runs, auto-update runs, groundskeeper runs, etc. They're built as full Next.js App Router pages with the wiki's MDX rendering pipeline (Pattern A per `.claude/rules/internal-dashboards.md`).

Properties:

- ~10K LOC across the 32 directories
- All deploy with the main wiki Next.js app (build coupling)
- Use the same component library as user-facing pages
- Navigated via `apps/web/src/lib/wiki-nav.ts` internal sidebar
- Mostly used by Ozzie + AI agents; rarely seen by external readers

The 2026-04-27 prior investigation flagged 3 dashboard collapse opportunities (runs-history shells, entity-aggregation shells, citation-quality shells) saving ~1,300 LOC. But the structural question — should this whole layer even live in `apps/web` — was deferred to this ADR.

## Question

Should the 32 `/internal/*` dashboards stay embedded in the main wiki app, or be extracted to a separate admin surface?

## What counts as a decision

One of:

- **(a) Stay embedded as-is** — defend why coupling to the wiki app deploy is acceptable; document the boundaries
- **(b) Stay embedded with shared shells** — extract a `<InternalDashboardShell>` and 3 generic dashboard layouts (per the prior investigation), but stay in `apps/web`
- **(c) Spin off to separate Next.js app** — `apps/admin` on a subdomain, separate deploy
- **(d) Spin off to a different framework** — Tremor, Retool, Grafana, or purpose-built admin tool

With cost estimate, migration plan, and impact on agent workflows (do agents still need to navigate `/internal/*` URLs).

## In scope

- Usage analysis: who uses each dashboard, how often (server logs if available, otherwise estimate)
- Build cost contribution: which dashboards are heaviest in the wiki build
- Dependency graph: which `/internal/*` dashboards share components with user-facing pages
- Cost of each option (engineering, operational, learning curve for alternative tools)
- Impact on the agent workflow — many `.claude/` rules reference `/internal/*` URLs; what changes?

## Out of scope

- Building the generic shells (downstream implementation if option (b) wins)
- Specific dashboard rewrites
- Changes to user-facing wiki pages

## Time-box

5 working days from charter to decision.

## Success criteria

ADR ends with one of (a)–(d) chosen with named consequences. "Stay embedded" is the easy default but must defend why the build-coupling and 10K-LOC drag in the wiki app is acceptable.

## Dependencies

- **Blocked by:** ADR-0006 (wiki-server decomposition shapes the deploy story)
- **Blocked by (soft):** ADR-0007 (observability strategy may absorb some dashboards)
