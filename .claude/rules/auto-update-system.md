# Auto-Update System

News-driven automatic wiki updates. Fetches from RSS feeds and web searches, routes relevant news to wiki pages, and runs the improve pipeline.

## Key commands

```bash
pnpm crux auto-update plan                    # Preview what would be updated
pnpm crux auto-update run --budget=30         # Run with $30 budget cap
pnpm crux auto-update digest                  # Just fetch and show news digest
pnpm crux auto-update sources                 # List configured sources
pnpm crux auto-update history                 # Show past runs
```

## Architecture

- Implementation: `crux/auto-update/` (orchestrator, feed fetcher, page router)
- Source config: `data/auto-update/sources.yaml`
- GitHub Actions: `.github/workflows/auto-update.yml` — runs daily at 06:00 UTC
- Configurable via `workflow_dispatch` with budget, page count, and source filters
- Dashboard: `/internal/auto-update-runs/` and `/internal/auto-update-news/`
