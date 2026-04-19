# Auto-Update System

News-driven automatic wiki updates. Full CLI reference: `pnpm crux w auto-update --help`.

- Implementation: `crux/auto-update/`
- Source config: `data/auto-update/sources.yaml`
- Runner: `.github/workflows/auto-update.yml` — **scheduled cron is disabled** (PR #2592, 2026-03-17). The workflow is invoked only via `workflow_dispatch` (manually from the Actions tab) or by running `pnpm crux auto-update run` locally. The wellness check excludes this workflow from staleness alerts. See QUA-31 for the open product question of whether to re-enable scheduled runs.
- Dashboards: `/internal/auto-update-runs/` and `/internal/auto-update-news/`
