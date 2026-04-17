# Auto-Update System

News-driven automatic wiki updates. Full CLI reference: `pnpm crux w auto-update --help`.

- Implementation: `crux/auto-update/`
- Source config: `data/auto-update/sources.yaml`
- Scheduled runner: `.github/workflows/auto-update.yml` (daily 06:00 UTC, `workflow_dispatch` supported)
- Dashboards: `/internal/auto-update-runs/` and `/internal/auto-update-news/`
