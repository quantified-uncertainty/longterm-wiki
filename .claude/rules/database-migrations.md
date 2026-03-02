# Database Migrations

Wiki-server uses Drizzle ORM for schema management. Migrations run automatically on server startup unless `SKIP_MIGRATIONS=true`.

## Architecture

```
DATABASE_URL              → Application pool (statement_timeout: 30s, max: 10)
DATABASE_MIGRATION_URL    → Migration client (statement_timeout: 0, max: 1)
  (falls back to DATABASE_URL)
```

The migration client (`initDb()` in `apps/wiki-server/src/db.ts`) uses a dedicated single-connection with relaxed timeouts:
- `statement_timeout: '0'` — unlimited (DDL must complete once lock is acquired)
- `lock_timeout: '60000'` — 60s (fail fast if lock can't be acquired)
- `idle_in_transaction_session_timeout: '600000'` — 10min total bound

## When Drizzle migrations work fine

Most migrations: adding columns, creating tables, adding indexes on small tables, inserting rows. These complete in seconds and work through the normal Drizzle migration runner.

## When you need a manual migration

**Any operation that takes >30s on production data or requires ACCESS EXCLUSIVE locks on large tables must be a manual migration.** This includes:

- `CREATE INDEX` on tables with >1M rows
- `CREATE MATERIALIZED VIEW` with expensive queries
- `UPDATE` backfilling >100K rows
- `ALTER TABLE` adding constraints that require full table scans

### Pattern: no-op Drizzle migration + manual SQL script

1. Create the Drizzle migration as a no-op: `SELECT 1;`
2. Add a comment explaining why and pointing to the manual script
3. Create the actual SQL in `apps/wiki-server/scripts/<name>.sql`
4. Make the script idempotent (`IF NOT EXISTS`, `WHERE ... IS NULL`, `EXCEPTION` handlers)
5. Apply via `psql "$DATABASE_MIGRATION_URL" -f apps/wiki-server/scripts/<name>.sql`

See `apps/wiki-server/drizzle/0048_add_slug_and_integer_id.sql` (no-op) and `apps/wiki-server/scripts/phase4a-manual-migration.sql` (actual DDL) for a reference implementation.

### Pattern: batched UPDATE for large backfills

For UPDATE operations on large tables, process in batches to avoid statement_timeout and reduce lock contention:

```sql
-- Backfill in batches of 10,000 rows
-- NOTE: This DO block runs as a single transaction.
-- For inter-batch commits on very large datasets, see the note below about shell loops.
DO $$
DECLARE
  rows_updated INT;
BEGIN
  LOOP
    -- PostgreSQL does not support UPDATE ... LIMIT directly.
    -- Select the batch via ctid, then update only those rows.
    UPDATE my_table t
    SET new_col = source.value
    FROM source_table source
    WHERE source.id = t.source_id
      AND t.ctid IN (
        SELECT ctid FROM my_table WHERE new_col IS NULL LIMIT 10000
      );

    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    RAISE NOTICE 'Updated % rows', rows_updated;
    EXIT WHEN rows_updated = 0;
  END LOOP;
END $$;
```

> **Note on batching**: `COMMIT` is not allowed inside a `DO` block. Each `DO` execution runs as a single transaction. For true inter-batch commits, run the batch SQL in a shell loop (e.g. `while psql ... -c "UPDATE ... LIMIT 10000 ..." | grep -q "10000 rows"`) or use a stored procedure with `CALL` in PostgreSQL 14+.

## Deploy flow for DDL migrations

1. Merge PR with the no-op migration — deploy succeeds without DDL contention
2. Apply the manual script: `psql "$DATABASE_MIGRATION_URL" -f apps/wiki-server/scripts/<name>.sql`
3. Verify: run a SELECT to confirm the changes applied
4. (Optional) If the DDL blocks the smoke test, use `workflow_dispatch` with `skip_smoke_test: true`

## postgres.js gotchas

- `statement_timeout: 0` (number) is silently dropped by postgres.js's falsy-value filter. Use string `'0'`.
- Server-side role settings (`ALTER ROLE ... SET statement_timeout`) override client config. The migration client sends params in the StartupMessage to override these, but verify with the diagnostic log output.
- Set `DATABASE_MIGRATION_URL` to use a separate PG role without server-side timeout limits.

## Key files

| File | Purpose |
|------|---------|
| `apps/wiki-server/src/db.ts` | Connection pools + migration runner |
| `apps/wiki-server/drizzle/` | Drizzle migration SQL files |
| `apps/wiki-server/scripts/` | Manual migration scripts (applied via psql) |
| `apps/wiki-server/drizzle.config.ts` | Drizzle Kit config |
| `.github/workflows/wiki-server-docker.yml` | Deploy pipeline with smoke test |
