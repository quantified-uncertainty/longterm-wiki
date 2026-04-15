# Architecture

## Core

```
                                                     ┌───────────────────────────┐
                                                     │ scheduler (groundskeeper) │
                                                     └───────────────────────────┘
                                                       │
                                                       ∨
┌───────────────────────────┐     ┌────────────┐     ┌───────────────────────────┐     ┌──────────┐
│    GitHub Actions cron    │ ──> │ CLI (crux) │ ──> │  REST API (wiki-server)   │ ──> │ Postgres │
└───────────────────────────┘     └────────────┘     └───────────────────────────┘     └──────────┘
  │                                                    ∧
  ∨                                                    │
┌───────────────────────────┐                          │
│ queue worker (job-worker) │ ─────────────────────────┘
└───────────────────────────┘
```


## Scheduled jobs

Two components run things on a schedule.

### GitHub Actions cron

- `job-worker` (every 30 min) — consumes the Postgres job queue: claims via `POST /api/jobs/claim`, executes the handler, reports back via `/complete` or `/fail`. Jobs are enqueued via `POST /api/jobs` by CLI commands (`crux jobs create`, `crux auto-update`, `crux sourcing-orchestrate`) and by the groundskeeper (`auto-update-enqueue` task).
- `sourcing` (Mon 04:00) — runs source-checking on records and writes verdicts.
- `sourcing-recheck` (Mon 08:00) — re-verifies stale verdicts.
- `sync-entities-facts` (Mon 07:00) — syncs YAML entities and facts into Postgres.
- `snapshot-resources` (daily 04:30) — fetches external URL content for sourcing.
- `flagship-curate` (Mon 09:00) — content curation pass.

### Scheduler (`groundskeeper`)

In-process periodic tasks on the long-running service. Current tasks: health checks, session sweeps, data-quality snapshots, job-worker health, `auto-update-enqueue` (enqueues jobs into the queue), job-failure triage, tablebase scan, snapshot retention, GitHub shadowban check, E2E post-deploy watcher.
