## 2026-02-13 | claude/github-actions-crux-integration-mZTsf | GitHub Actions + Crux CLI integration

**What was done:** Designed and implemented 5 new GitHub Actions workflows that integrate with the crux CLI: weekly health report (analyze/updates/gaps/insights stats → GitHub issue), scheduled auto-fix PR (runs all crux fixers weekly, creates PR if changes found), daily stale content alert (tracks overdue pages via GitHub issue), PR advisory checks (non-blocking validation comments on content PRs), and weekly link rot/resource checker (integrates `crux check-links` from PR #116 plus refs/orphans/internal link validation, with cache persistence across runs).

**Pages:** (none — infrastructure only)

**Issues encountered:**
- None — all crux commands already supported `--ci`/`--json` output modes, making workflow integration straightforward.

**Learnings/notes:**
- The crux CLI is very well-suited for CI integration. Nearly all validate/analyze/stats commands support `--ci` or `--json` flags.
- Tier 2 workflows (scheduled triage, financial staleness) would need `ANTHROPIC_API_KEY` secret and cost money per run.
- Tier 3 (autonomous content updates via `crux updates run`) is feasible but expensive (~$5-20/run) and should probably be manual-trigger only.
- The auto-fix workflow validates after fixing to ensure fixes don't break blocking CI checks.
