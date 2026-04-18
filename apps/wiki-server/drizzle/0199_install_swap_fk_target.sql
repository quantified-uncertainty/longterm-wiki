-- QUA-600: install swap_fk_target() PL/pgSQL helper.
--
-- Extracted from the QUA-549 Phase B migration template (12 PRs that each
-- repeated the same ~60-100 lines of FK-target swap boilerplate). The helper
-- owns the orphan check, NULL guard, constraint-name enumeration, and
-- optional NOT VALID pattern so future FK-target migrations can't reintroduce
-- the defects that shipped in PR #4460 (QUA-567) and were fixed post-merge
-- in #4466.
--
-- Source of truth for the procedure body: drizzle/helpers/swap_fk_target.sql
-- (kept alongside this migration as a standalone reference file). Any change
-- to the procedure must be landed via a new CREATE OR REPLACE migration;
-- Drizzle doesn't rescan the helpers/ folder.
--
-- Caller docs: .claude/rules/database-migrations.md § "Swapping an FK target
-- column".

CREATE OR REPLACE PROCEDURE swap_fk_target(
  child_table         text,
  child_col           text,
  parent_table        text,
  from_col            text,
  to_col              text,
  on_delete           text DEFAULT 'NO ACTION',
  use_not_valid       boolean DEFAULT false,
  new_constraint_name text DEFAULT NULL
)
LANGUAGE plpgsql
AS $proc$
DECLARE
  normalized_on_delete text;
  fk_name              text;
  constraints_dropped  int  := 0;
  rows_updated         bigint;
  orphan_count         bigint;
  final_name           text;
BEGIN
  -- Validate on_delete against the PostgreSQL FK action allowlist.
  -- The value is interpolated into dynamic SQL below; validating against a
  -- fixed allowlist is what keeps this safe from injection.
  normalized_on_delete := upper(trim(on_delete));
  IF normalized_on_delete NOT IN
     ('NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT') THEN
    RAISE EXCEPTION
      'swap_fk_target: on_delete must be one of NO ACTION, RESTRICT, CASCADE, SET NULL, SET DEFAULT (got: %)',
      on_delete;
  END IF;

  -- Compute the final constraint name. Default follows Drizzle's convention:
  -- <child_table>_<child_col>_<parent_table>_<to_col>_fk.
  final_name := COALESCE(
    new_constraint_name,
    format('%s_%s_%s_%s_fk', child_table, child_col, parent_table, to_col)
  );

  RAISE NOTICE 'swap_fk_target: %.% → %.% (ON DELETE %, NOT VALID: %, constraint: %)',
    child_table, child_col, parent_table, to_col,
    normalized_on_delete, use_not_valid, final_name;

  -- Step 1: Drop every FK on child_table.child_col that points at
  -- parent_table.from_col. Enumerating via information_schema means we don't
  -- need to know the constraint's name (Drizzle's generated name and
  -- PostgreSQL's default differ, and either can appear depending on env).
  --
  -- Scoped to current_schema() so the helper is safe to use in tests or any
  -- non-public schema; for production migrations running in public, it
  -- behaves exactly like the hand-rolled template did.
  FOR fk_name IN
    SELECT tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema    = kcu.table_schema
    JOIN information_schema.referential_constraints rc
      ON tc.constraint_name = rc.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON rc.unique_constraint_name   = ccu.constraint_name
     AND rc.unique_constraint_schema = ccu.constraint_schema
    WHERE tc.table_schema     = current_schema()
      AND tc.table_name       = child_table
      AND tc.constraint_type  = 'FOREIGN KEY'
      AND kcu.column_name     = child_col
      AND ccu.table_name      = parent_table
      AND ccu.column_name     = from_col
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', child_table, fk_name);
    constraints_dropped := constraints_dropped + 1;
    RAISE NOTICE 'swap_fk_target: dropped old FK %', fk_name;
  END LOOP;
  RAISE NOTICE 'swap_fk_target: % old FK constraint(s) dropped', constraints_dropped;

  -- Step 2: Backfill child_col values from from_col → to_col via JOIN on the
  -- parent table. The three guards are load-bearing:
  --   * child_col IS NOT NULL   — leave nullable FKs' NULLs alone.
  --   * parent.to_col IS NOT NULL — never silently overwrite a real value
  --     with NULL if the parent happens to lack a to_col value.
  --   * child_col != parent.to_col — skip already-migrated rows; makes this
  --     re-runnable without counting already-correct rows as "updated".
  EXECUTE format(
    $fmt$
      UPDATE %1$I c
      SET %2$I = p.%3$I
      FROM %4$I p
      WHERE c.%2$I      = p.%5$I
        AND c.%2$I IS NOT NULL
        AND c.%2$I     <> p.%3$I
        AND p.%3$I IS NOT NULL
    $fmt$,
    child_table,   -- %1$I
    child_col,     -- %2$I
    to_col,        -- %3$I
    parent_table,  -- %4$I
    from_col       -- %5$I
  );
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RAISE NOTICE 'swap_fk_target: backfilled % row(s)', rows_updated;

  -- Step 3: Orphan check. Every non-null child_col value must now map to a
  -- parent_table.to_col value, or the ADD CONSTRAINT below will fail with an
  -- opaque FK violation. Raise here with an actionable message instead.
  --
  -- Critically, this uses NOT EXISTS against the parent table — not a format
  -- heuristic like NOT LIKE 'sid_%'. That's the defect PR #4460 shipped with
  -- (and #4466 fixed post-merge). The template owns the correct check.
  EXECUTE format(
    'SELECT COUNT(*) FROM %1$I c
      WHERE c.%2$I IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM %3$I p WHERE p.%4$I = c.%2$I)',
    child_table, child_col, parent_table, to_col
  ) INTO orphan_count;

  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'swap_fk_target: % orphan row(s) remain in %.% after backfill — no matching %.% value. Fix data (insert missing rows or delete orphans) before re-running.',
      orphan_count, child_table, child_col, parent_table, to_col;
  END IF;

  -- Step 4: Add the new FK pointing at parent_table.to_col. Wrapped in an
  -- IF NOT EXISTS check so a manual re-apply is a no-op rather than an error.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema    = current_schema()
      AND constraint_name = final_name
      AND table_name      = child_table
  ) THEN
    IF use_not_valid THEN
      -- ADD CONSTRAINT NOT VALID registers the constraint as unchecked
      -- metadata (ACCESS EXCLUSIVE for milliseconds, no row scan). Followed
      -- by VALIDATE CONSTRAINT which only needs SHARE UPDATE EXCLUSIVE.
      -- See .claude/rules/database-migrations.md § "ADD CONSTRAINT ... NOT
      -- VALID + separate VALIDATE CONSTRAINT" for the when-to-use guidance
      -- and the QUA-302/QUA-156 incident note.
      EXECUTE format(
        'ALTER TABLE %1$I ADD CONSTRAINT %2$I FOREIGN KEY (%3$I) REFERENCES %4$I(%5$I) ON DELETE %6$s NOT VALID',
        child_table, final_name, child_col, parent_table, to_col, normalized_on_delete
      );
      RAISE NOTICE 'swap_fk_target: added constraint % (NOT VALID)', final_name;
    ELSE
      EXECUTE format(
        'ALTER TABLE %1$I ADD CONSTRAINT %2$I FOREIGN KEY (%3$I) REFERENCES %4$I(%5$I) ON DELETE %6$s',
        child_table, final_name, child_col, parent_table, to_col, normalized_on_delete
      );
      RAISE NOTICE 'swap_fk_target: added constraint %', final_name;
    END IF;
  ELSE
    RAISE NOTICE 'swap_fk_target: constraint % already exists; skipping ADD', final_name;
  END IF;

  -- Step 5: If the constraint was added NOT VALID, validate it separately.
  -- ALTER TABLE … VALIDATE CONSTRAINT is a no-op if the constraint is
  -- already VALID, so this is idempotent across reruns.
  --
  -- Note: when this procedure runs inside a Drizzle migration (single tx),
  -- the ACCESS EXCLUSIVE lock from step 4's ADD CONSTRAINT is still held
  -- through the VALIDATE. For very large tables (>1M rows) where VALIDATE
  -- is slow, the caller should split this into two migrations instead of
  -- using use_not_valid=true — see the rule doc for the manual pattern.
  IF use_not_valid THEN
    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', child_table, final_name);
    RAISE NOTICE 'swap_fk_target: validated constraint %', final_name;
  END IF;
END;
$proc$;
