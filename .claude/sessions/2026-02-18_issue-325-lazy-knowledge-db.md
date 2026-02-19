## 2026-02-18 | claude/issue-325-lazy-knowledge-db | Lazy-initialize knowledge-db to unblock dependent tests

**What was done:** Converted `crux/lib/knowledge-db.ts` from eager to lazy database initialization. The SQLite database and native bindings are now only loaded on first actual use (via `getDb()`), not at import time. This unblocks `creator.test.ts` which was previously excluded from vitest, and simplifies two files that used dynamic import workarounds.

**PR:** (auto)

**Model:** opus-4-6

**Duration:** ~25min

**Issues encountered:**
- Making `main()` in the hallucination-risk validator synchronous caused `process.exit(0)` to fire during test imports. Fixed by adding a `process.argv[1] === fileURLToPath(import.meta.url)` guard.

**Learnings/notes:**
- The eager `new Database()` call plus `mkdirSync` and `db.exec()` all ran at import time, which required consumers to either use dynamic imports or be excluded from tests.
- With lazy init via `getDb()`, all consumers can safely use static imports — the DB is only created when a method actually queries it.
- The `bulkInsert` method in `relations` needed special handling since it uses both `db.prepare()` and `db.transaction()` on the same instance.

**Recommendations:**
- The internal documentation pages (`content-database.mdx`) reference `knowledge-db.mjs` which doesn't match the actual `.ts` file path — may want to update those docs.
