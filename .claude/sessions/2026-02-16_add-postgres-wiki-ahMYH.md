## 2026-02-16 | add-postgres-wiki-ahMYH | Add Postgres server for IDs and edit logs

**What was done:** Added a new `server/` workspace package with a Hono API server backed by Postgres (via Docker Compose) and Drizzle ORM. Provides atomic E ID generation (eliminates merge conflicts from parallel branches) and append-only edit logs. Includes a seed script to import existing YAML/MDX data into Postgres.

**Pages:** (none — infrastructure only)

**Issues encountered:**
- vitest binary not directly accessible via `pnpm test` in this environment (pre-existing issue), but tests pass when invoked directly
- puppeteer Chrome download fails (pre-existing network issue, unrelated)

**Learnings/notes:**
- The project already has `better-sqlite3` used for a research cache (`crux/lib/knowledge-db.ts`) — the Postgres setup is separate and serves as shared state across branches
- Entity IDs are currently assigned sequentially in `build-data.mjs` (lines 672-703) by scanning all YAML/MDX files — the Postgres sequence replaces this with atomic allocation
- Phase 2 should wire `build-data.mjs` ID assignment to call the server API, and have `crux/lib/edit-log.ts` dual-write to both YAML and Postgres
