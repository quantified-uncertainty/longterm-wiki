# ADR-0007: Observability strategy

## Status

`Charter`

## Context

Telemetry exists everywhere; a unified view exists nowhere.

Current state:

- ~5,400 `console.log/error/warn` calls across `apps/wiki-server/`, `apps/web/`, `crux/`
- 5 different `*_runs` tables (`groundskeeper_runs`, `auto_update_runs`, `page_improve_runs`, `enrichment_runs`, plus the `jobs` table)
- `agent_sessions.heartbeat_at` for agent liveness
- `service_health_incidents` for production incident tracking
- GitHub Actions workflow runs (each workflow's history)
- `~/.cache/pr-patrol/runs.jsonl` (filesystem!) for PR patrol state
- Per-pod K8s logs (where `console.*` lands)

The QUA-302 12-hour deploy-stuck incident took 12 hours partly because no one had a "deploys + their lock waits over time" view. The QUA-302 retrospective surfaced this gap; nothing was built to close it.

A prior 7-agent investigation (2026-04-27) discovered the existing automation-landscape catalog (E2214) and recommended making it live, but the deeper observability strategy question — what tooling, what cost, what coverage — was deferred to this ADR.

## Question

What is the right observability architecture for this codebase? Specifically:

1. **Logging** — adopt structured logging (pino or similar) consistently? Where do logs go?
2. **Tracing** — adopt OpenTelemetry traces? Would it have caught QUA-302?
3. **Metrics & dashboards** — current `*_runs` tables vs. unified, plus which dashboards must exist
4. **Tooling** — local-first (Grafana/Loki self-hosted) vs. SaaS (Datadog, Honeycomb, Axiom) vs. minimal (just the existing PG tables + dashboards)
5. **Incident response loop** — when prod gets stuck again, what do we look at first?

## What counts as a decision

A chosen observability stack with:

- Specific tooling decisions (logging library, sink, tracing yes/no, dashboard tool)
- Cost estimate (engineering time, recurring SaaS bill, infra)
- Rollout plan (which app instruments first, what metrics matter most)
- Migration story for the 5,400 `console.*` calls (replace, leave, or wrap)

## In scope

- Inventory of current telemetry (where does it go, who reads it)
- Gap analysis vs. the QUA-302 retrospective + similar incidents
- Tooling option survey with realistic cost estimates
- Rollout phases — what's the minimum viable observability that catches the next QUA-302?
- Implications for the existing run-tracking schemas (do they unify or stay parallel)

## Out of scope

- Console.log cleanup as a one-off (covered by the strategy, not as separate work)
- Building the unified dashboards (downstream implementation tickets)
- Adding instrumentation to specific code paths (downstream)

## Time-box

5 working days from charter to decision.

## Success criteria

ADR ends with a chosen tooling stack and a rollout phase 1 plan. "Status quo + make `automation-landscape` live" is acceptable if defended — but the QUA-302 question must be answered: what do we look at next time?

## Dependencies

- **Blocks (soft):** ADR-0008 (internal dashboards layer — observability tooling choice may absorb some dashboards)
- **Blocked by:** none
