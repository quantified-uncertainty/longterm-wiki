## 2026-02-16 | add-postgres-wiki-ahMYH | Add Postgres server for IDs and edit logs

**What was done:** Phase 1: Added `server/` workspace package (Hono + Drizzle + Postgres via Docker Compose) with atomic E ID generation and append-only edit logs. Phase 2: Wired `build-data.mjs` to use the server API for ID allocation (with graceful fallback to local), added dual-write to `crux/lib/edit-log.ts`, and created a shared client library. Fixed several issues found in code review: TOCTOU race condition in ID allocation (now uses atomic INSERT ON CONFLICT), `_fullPath` deletion ordering bug, seed re-run duplicating edit logs, NaN input validation, missing index on `edit_logs.page_id`, and added circuit-breaker for mid-build server failure.

**Pages:** (none — infrastructure only)

**Issues encountered:**
- vitest binary not directly accessible via `pnpm test` in this environment (pre-existing)
- `build-data.mjs` is a plain `.mjs` file so can't import `.ts` modules directly — inlined the server client as plain fetch calls instead
- `main()` in build-data.mjs was not async — needed to make it async for `await` in ID allocation

**Learnings/notes:**
- `_fullPath` is deleted from page objects at line 906 but needed later at line 992 — must save to a Map before deletion
- The POST /api/ids/next endpoint had a TOCTOU race between SELECT check and INSERT — fixed with atomic INSERT ON CONFLICT + UNION ALL fallback
- `onConflictDoNothing` on tables without unique constraints is silently ineffective
- The crux tsconfig has ~100+ pre-existing type errors (missing modules, etc.) — none from our changes
