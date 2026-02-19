## 2026-02-19 | claude/issue-324-citation-accuracy-dashboard | Build citation accuracy dashboard

**What was done:** Created `/internal/citation-accuracy` dashboard page with summary stats, verdict distribution, per-page accuracy table, flagged citations table, and domain analysis. Data flows from SQLite via a JSON export command (`pnpm crux citations export-dashboard`) that auto-runs after accuracy checks.

**PR:** (auto)

**Model:** opus-4-6

**Duration:** ~45min

**Issues encountered:**
- Cannot import better-sqlite3 directly in Next.js app (no native dep). Solved with JSON export approach.
- Paranoid review found domain stats lumping "unsupported" into "inaccurate" — fixed to track separately.

**Learnings/notes:**
- All existing internal dashboards read YAML/JSON, not SQLite. The JSON export approach is consistent with this pattern.
- `process.cwd()` in Next.js server components resolves to `apps/web/`, so `../../.cache/` correctly reaches project root.
- The `fileURLToPath(import.meta.url)` guard is needed on any module with top-level `main()` calls to prevent execution during test imports.
