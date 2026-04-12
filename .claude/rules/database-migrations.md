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

## Migration failure behavior

If a migration fails at startup, the server starts in **degraded mode** instead of crash-looping. The health endpoint reports `"status": "degraded"` with a `migrationError` field containing the error message. This gives operators visibility without requiring kubectl access to diagnose the issue.

The post-deploy smoke test checks for `status === "healthy"`, so a degraded server will correctly fail the smoke test and prevent the bad image from receiving traffic.

## Adding unique constraints — MANDATORY pattern

**Never hardcode specific duplicate IDs in migrations.** Use dynamic dedup with `ROW_NUMBER()` window functions to find and remove ALL duplicates, including ones created after the migration was written.

Incident context: Hardcoding one duplicate ID in migration 0143 missed 2 others, causing a 3-hour outage on 2026-03-28.

```sql
-- GOOD: dynamic dedup (handles ALL duplicates)
DELETE FROM my_table
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY natural_key_col1, natural_key_col2
      ORDER BY created_at, id  -- keep earliest; id as tiebreaker
    ) AS rn
    FROM my_table
  ) ranked WHERE rn > 1
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_my_table_natural_key
  ON my_table (natural_key_col1, natural_key_col2);

-- BAD: hardcoded IDs (misses future duplicates)
DELETE FROM my_table WHERE id = 'abc123';
CREATE UNIQUE INDEX ...
```

Reference implementations: `0108_natural_key_uniqueness.sql`, `0143_dedup_funding_program_unique.sql`.

The gate check (`validate-drizzle-journal.ts`) warns if it detects CREATE UNIQUE INDEX with hardcoded DELETEs.

## Adding CHECK constraints on enum columns — MANDATORY pattern

**Never write a CHECK constraint's allowed-value list from code or memory.** Enumerate against prod data first, or the migration will fail when it encounters values the author didn't know existed.

Incident context: two enum-gap incidents in the same week. Migration 0173's `groundskeeper_runs.event` constraint omitted three valid values already in prod (`circuit_breaker_reset`, `half_open_attempt`, `half_open_success`), blocking the #4167 release at ArgoCD PreSync until #4178 landed. `service_health_incidents.severity` shipped with a similarly incomplete allowlist and needed #4202. Both root-caused to the same mistake: author inspected the TypeScript enum / Zod schema instead of querying the column's live distinct values.

(Note: migration 0173's `chk_hrs_level` *also* caused a separate ~12h outage (QUA-302), but that was lock contention, not an enum gap — see the `NOT VALID` pattern below.)

**Required procedure before writing any `CHECK (col IN (...))` constraint:**

1. Query prod for the full distinct-value set:
   ```sql
   SELECT col, count(*) FROM my_table GROUP BY col ORDER BY count DESC;
   ```
2. Paste the output into the PR description under a `### Enum enumeration` heading.
3. Build the `IN (...)` list from that output, not from an enum type, TypeScript union, or your recollection of "the valid values."
4. If the live set contains values you think should be invalid, **add them to the constraint anyway** and file a separate cleanup ticket. A migration is not the place to retroactively narrow an enum.
5. For large tables, combine with the `NOT VALID` + `VALIDATE CONSTRAINT` pattern below.

This applies equally to new constraints and to ALTERing existing ones to a tighter set.

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

### Pattern: `ADD CONSTRAINT ... NOT VALID` + separate `VALIDATE CONSTRAINT`

For CHECK constraints on large tables (>100 MB or >1M rows), plain `ALTER TABLE ... ADD CONSTRAINT CHECK (...)` scans every row while holding ACCESS EXCLUSIVE — any concurrent reader (especially materialized-view refreshes) can keep the migration client waiting past the 60s `lock_timeout`. Split the DDL in two:

```sql
-- Phase 1: register the constraint as unchecked metadata.
-- Acquires ACCESS EXCLUSIVE for milliseconds; no row scan.
ALTER TABLE my_big_table
  ADD CONSTRAINT my_constraint CHECK (col IN ('a','b','c')) NOT VALID;

-- Phase 2: validate against existing rows.
-- Only needs SHARE UPDATE EXCLUSIVE — concurrent SELECT/INSERT/UPDATE are allowed.
ALTER TABLE my_big_table VALIDATE CONSTRAINT my_constraint;
```

Both phases enforce the constraint on new writes once Phase 1 lands. Phase 2 can follow in the same migration, a follow-up migration, or a manual script.

**Post-mortem — 2026-04-12 incident (QUA-302, QUA-156):** Migration 0173 added `chk_hrs_level CHECK (...)` directly on `hallucination_risk_snapshots` (905 MB, 3.3M rows). The concurrent `REFRESH MATERIALIZED VIEW hallucination_risk_latest` held AccessShareLock continuously, so every deploy retry exhausted the 60s `lock_timeout` and rolled back the whole PreSync job. The failure cascaded into ~7 symptom-management PRs before root cause was identified — prod was stuck on a ~12-hour-old image the whole time. Unstick path: manually applied the constraint with `NOT VALID` (milliseconds), then `VALIDATE CONSTRAINT` (5.8s, non-blocking), then re-ran the deploy. Follow-up: QUA-294 proposes a gate validator that flags `ADD CONSTRAINT` on a hot list of large tables unless `NOT VALID` is used.

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
