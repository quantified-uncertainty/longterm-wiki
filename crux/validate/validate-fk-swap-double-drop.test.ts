/**
 * Tests for the FK-swap double-drop validator.
 *
 * Strategy:
 *   1. Regression test — the actual repo passes (this is the proof that
 *      QUA-609's "fix any unexpected violations in-PR" step was satisfied).
 *   2. Unit tests — write temp .sql fixtures and assert classification:
 *      - Compliant two-name pattern passes.
 *      - Compliant dynamic-drop pattern (0187 style) passes.
 *      - Single-drop fabrication (0186 pre-fix style) fails.
 *      - Non-FK-swap migration is skipped.
 *      - Multi-table migration with one bad block fails on that block only.
 *      - Comments containing "DROP CONSTRAINT" do not satisfy the requirement.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import os from 'os';

import {
  runCheck,
  findSwapTargets,
  findDroppedConstraints,
  hasDynamicDrop,
} from './validate-fk-swap-double-drop.ts';

function makeDrizzleDir(files: Record<string, string>): string {
  const root = join(
    os.tmpdir(),
    `fk-swap-double-drop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  mkdirSync(root, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  return root;
}

// Compliant: two-name DROP, UPDATE rewrite, ADD CONSTRAINT — based on 0188's
// resource_tabular_sources block, simplified.
const COMPLIANT_TWO_NAME = `
ALTER TABLE "resource_tabular_sources" DROP CONSTRAINT IF EXISTS "resource_tabular_sources_resource_id_resources_id_fk";
ALTER TABLE "resource_tabular_sources" DROP CONSTRAINT IF EXISTS "resource_tabular_sources_resource_id_fkey";

UPDATE "resource_tabular_sources" rts
SET resource_id = r.stable_id
FROM "resources" r
WHERE rts.resource_id = r.id
  AND rts.resource_id NOT LIKE 'sid_%';

ALTER TABLE "resource_tabular_sources"
  ADD CONSTRAINT "resource_tabular_sources_resource_id_resources_stable_id_fk"
  FOREIGN KEY ("resource_id") REFERENCES "resources"("stable_id") ON DELETE CASCADE;
`;

// Compliant: dynamic information_schema lookup + EXECUTE format — based on
// 0187's publications block, simplified.
const COMPLIANT_DYNAMIC = `
DO $$
DECLARE
  fk_name text;
BEGIN
  SELECT tc.constraint_name INTO fk_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
  JOIN information_schema.constraint_column_usage ccu
    ON tc.constraint_name = ccu.constraint_name
  WHERE tc.table_name = 'publications'
    AND kcu.column_name = 'resource_id'
    AND ccu.table_name = 'resources'
    AND ccu.column_name = 'id'
  LIMIT 1;
  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "publications" DROP CONSTRAINT %I', fk_name);
  END IF;
END $$;

UPDATE "publications" p
SET resource_id = r.stable_id
FROM "resources" r
WHERE p.resource_id = r.id
  AND p.resource_id IS NOT NULL;

ALTER TABLE "publications"
  ADD CONSTRAINT "publications_resource_id_resources_stable_id_fk"
  FOREIGN KEY ("resource_id") REFERENCES "resources"("stable_id") ON DELETE SET NULL;
`;

// Bad: only the Drizzle name is dropped (this is the 0186 pre-fix mistake).
const BAD_SINGLE_DROP = `
ALTER TABLE resource_content_versions
  DROP CONSTRAINT IF EXISTS resource_content_versions_resource_id_resources_id_fk;

UPDATE resource_content_versions rcv
SET resource_id = r.stable_id
FROM resources r
WHERE rcv.resource_id = r.id;

ALTER TABLE resource_content_versions
  ADD CONSTRAINT resource_content_versions_resource_id_resources_stable_id_fk
  FOREIGN KEY (resource_id) REFERENCES resources(stable_id);
`;

// Non-FK-swap: a normal CREATE TABLE migration. Should be skipped entirely.
const NON_FK_SWAP = `
CREATE TABLE IF NOT EXISTS "things" (
  id text PRIMARY KEY,
  title text NOT NULL,
  description text
);

CREATE INDEX IF NOT EXISTS "things_title_idx" ON "things" (title);
`;

describe('validate-fk-swap-double-drop', () => {
  let scratch: string | null = null;

  afterEach(() => {
    if (scratch) {
      rmSync(scratch, { recursive: true, force: true });
      scratch = null;
    }
  });

  it('current repo has zero violations', () => {
    // Regression test: the live drizzle/ tree must pass. Proves 0186 fix
    // (PR #4489) is in main and no later migration regressed.
    const result = runCheck();
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
    // We expect the validator to find some FK-swap files (Phase B is in main).
    expect(result.filesWithSwaps).toBeGreaterThan(0);
  });

  it('passes when both _fk and _fkey are dropped (two-name pattern)', () => {
    scratch = makeDrizzleDir({
      '0188_compliant.sql': COMPLIANT_TWO_NAME,
    });
    const result = runCheck({ drizzleDir: scratch });
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
    expect(result.filesWithSwaps).toBe(1);
  });

  it('passes when the dynamic information_schema + EXECUTE format pattern is used', () => {
    scratch = makeDrizzleDir({
      '0187_compliant_dynamic.sql': COMPLIANT_DYNAMIC,
    });
    const result = runCheck({ drizzleDir: scratch });
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
    expect(result.filesWithSwaps).toBe(1);
  });

  it('fails when only the Drizzle _fk name is dropped (0186 pre-fix shape)', () => {
    scratch = makeDrizzleDir({
      '0186_bad.sql': BAD_SINGLE_DROP,
    });
    const result = runCheck({ drizzleDir: scratch });
    expect(result.passed).toBe(false);
    expect(result.errors).toBe(1);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      file: '0186_bad.sql',
      table: 'resource_content_versions',
      column: 'resource_id',
      missingDrops: ['resource_content_versions_resource_id_fkey'],
    });
    // Both UPDATE rewrite and ADD CONSTRAINT signals should fire.
    expect(result.violations[0].signals.sort()).toEqual([
      'add-constraint',
      'update',
    ]);
  });

  it('fails with both names listed when neither drop is present', () => {
    scratch = makeDrizzleDir({
      '0200_no_drops.sql': `
        UPDATE "publications" p
        SET resource_id = r.stable_id
        FROM "resources" r
        WHERE p.resource_id = r.id;
      `,
    });
    const result = runCheck({ drizzleDir: scratch });
    expect(result.passed).toBe(false);
    expect(result.violations[0].missingDrops.sort()).toEqual([
      'publications_resource_id_fkey',
      'publications_resource_id_resources_id_fk',
    ]);
  });

  it('skips migrations with no FK-swap signals', () => {
    scratch = makeDrizzleDir({
      '0050_create_things.sql': NON_FK_SWAP,
    });
    const result = runCheck({ drizzleDir: scratch });
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
    expect(result.filesWithSwaps).toBe(0);
    expect(result.scanned).toBe(1);
  });

  it('flags a multi-block migration where one block is bad', () => {
    scratch = makeDrizzleDir({
      '0210_mixed.sql': `
        ${COMPLIANT_TWO_NAME}

        ${BAD_SINGLE_DROP}
      `,
    });
    const result = runCheck({ drizzleDir: scratch });
    expect(result.passed).toBe(false);
    expect(result.errors).toBe(1);
    expect(result.violations[0]).toMatchObject({
      table: 'resource_content_versions',
      column: 'resource_id',
    });
  });

  it('does NOT count "DROP CONSTRAINT" mentioned only in comments', () => {
    scratch = makeDrizzleDir({
      '0211_commented_drops.sql': `
        -- ALTER TABLE "publications" DROP CONSTRAINT IF EXISTS "publications_resource_id_resources_id_fk";
        /* DROP CONSTRAINT IF EXISTS "publications_resource_id_fkey"; */

        UPDATE "publications" p
        SET resource_id = r.stable_id
        FROM "resources" r
        WHERE p.resource_id = r.id;
      `,
    });
    const result = runCheck({ drizzleDir: scratch });
    expect(result.passed).toBe(false);
    expect(result.violations[0].missingDrops.sort()).toEqual([
      'publications_resource_id_fkey',
      'publications_resource_id_resources_id_fk',
    ]);
  });

  it('does NOT trigger on UPDATE statements that lack the resources JOIN', () => {
    // A SET = r.stable_id without `FROM resources r` and `WHERE col = r.id`
    // is not the canonical FK-swap rewrite — could be referencing a different
    // alias `r`. We require all parts of the canonical structure.
    scratch = makeDrizzleDir({
      '0212_unrelated_update.sql': `
        UPDATE "audit_log" a
        SET resource_id = r.stable_id
        FROM "things" r
        WHERE a.thing_id = r.id;
      `,
    });
    const result = runCheck({ drizzleDir: scratch });
    expect(result.passed).toBe(true);
    expect(result.filesWithSwaps).toBe(0);
  });

  it('returns passed=true when the drizzle directory does not exist', () => {
    const result = runCheck({
      drizzleDir: join(os.tmpdir(), `nonexistent-${Date.now()}`),
    });
    expect(result.passed).toBe(true);
    expect(result.scanned).toBe(0);
  });

  it('handles an empty directory cleanly', () => {
    scratch = makeDrizzleDir({});
    const result = runCheck({ drizzleDir: scratch });
    expect(result.passed).toBe(true);
    expect(result.scanned).toBe(0);
    expect(result.filesWithSwaps).toBe(0);
  });

  it('detects a swap target when only the ADD CONSTRAINT signal fires (no backfill)', () => {
    // A fresh-table FK that points at resources(stable_id) without a backfill
    // UPDATE still needs both drops in case the table existed previously with
    // a different FK shape.
    scratch = makeDrizzleDir({
      '0220_add_only.sql': `
        ALTER TABLE "new_resource_link"
          ADD CONSTRAINT "new_resource_link_resource_id_resources_stable_id_fk"
          FOREIGN KEY ("resource_id") REFERENCES "resources"("stable_id");
      `,
    });
    const result = runCheck({ drizzleDir: scratch });
    expect(result.passed).toBe(false);
    expect(result.violations[0].signals).toEqual(['add-constraint']);
  });
});

describe('findSwapTargets', () => {
  it('captures table and column from a canonical UPDATE rewrite', () => {
    const targets = findSwapTargets(`
      UPDATE "publications" p
      SET resource_id = r.stable_id
      FROM "resources" r
      WHERE p.resource_id = r.id;
    `);
    expect(targets).toEqual([
      expect.objectContaining({
        table: 'publications',
        column: 'resource_id',
        signals: new Set(['update']),
      }),
    ]);
  });

  it('captures table and column from an ADD CONSTRAINT clause', () => {
    const targets = findSwapTargets(`
      ALTER TABLE "page_citations"
        ADD CONSTRAINT "page_citations_resource_id_resources_stable_id_fk"
        FOREIGN KEY ("resource_id") REFERENCES "resources"("stable_id");
    `);
    expect(targets).toEqual([
      expect.objectContaining({
        table: 'page_citations',
        column: 'resource_id',
        signals: new Set(['add-constraint']),
      }),
    ]);
  });

  it('merges signals when both UPDATE and ADD CONSTRAINT touch the same target', () => {
    const targets = findSwapTargets(`
      UPDATE "x" t
      SET resource_id = r.stable_id
      FROM "resources" r
      WHERE t.resource_id = r.id;

      ALTER TABLE "x"
        ADD CONSTRAINT "x_resource_id_resources_stable_id_fk"
        FOREIGN KEY ("resource_id") REFERENCES "resources"("stable_id");
    `);
    expect(targets).toHaveLength(1);
    expect(targets[0].signals).toEqual(new Set(['update', 'add-constraint']));
  });

  it('captures multiple distinct (table, column) pairs in one file', () => {
    const targets = findSwapTargets(`
      UPDATE "a" x SET resource_id = r.stable_id FROM "resources" r WHERE x.resource_id = r.id;
      UPDATE "b" y SET resource_id = r.stable_id FROM "resources" r WHERE y.resource_id = r.id;
    `);
    const tables = targets.map((t) => t.table).sort();
    expect(tables).toEqual(['a', 'b']);
  });

  it('ignores SQL comments containing UPDATE syntax', () => {
    const targets = findSwapTargets(`
      -- UPDATE "fake" f SET resource_id = r.stable_id FROM "resources" r WHERE f.resource_id = r.id;
      /* UPDATE "also_fake" g SET resource_id = r.stable_id FROM "resources" r WHERE g.resource_id = r.id; */
      SELECT 1;
    `);
    expect(targets).toEqual([]);
  });

  it('does not match when the FROM clause references a non-resources table', () => {
    const targets = findSwapTargets(`
      UPDATE "x" t
      SET resource_id = r.stable_id
      FROM "other_table" r
      WHERE t.resource_id = r.id;
    `);
    expect(targets).toEqual([]);
  });
});

describe('findDroppedConstraints', () => {
  it('captures all DROP CONSTRAINT IF EXISTS names', () => {
    const drops = findDroppedConstraints(`
      ALTER TABLE "x" DROP CONSTRAINT IF EXISTS "a_b_fkey";
      ALTER TABLE "x" DROP CONSTRAINT IF EXISTS c_d_fk;
    `);
    expect(drops).toEqual(new Set(['a_b_fkey', 'c_d_fk']));
  });

  it('does NOT capture DROP CONSTRAINT without IF EXISTS', () => {
    // Plain DROP CONSTRAINT without IF EXISTS is not idempotent — we don't
    // count it. (None of the Phase B migrations use it; if this becomes a
    // concern we can broaden later.)
    const drops = findDroppedConstraints(`
      ALTER TABLE "x" DROP CONSTRAINT "y_fkey";
    `);
    expect(drops.size).toBe(0);
  });

  it('ignores DROP CONSTRAINT mentions inside comments', () => {
    const drops = findDroppedConstraints(`
      -- DROP CONSTRAINT IF EXISTS "fake_fkey";
      SELECT 1;
    `);
    expect(drops.size).toBe(0);
  });
});

describe('hasDynamicDrop', () => {
  it('detects the 0187-style dynamic information_schema lookup + EXECUTE format', () => {
    expect(
      hasDynamicDrop(COMPLIANT_DYNAMIC, 'publications', 'resource_id')
    ).toBe(true);
  });

  it('returns false when the EXECUTE format names a different table', () => {
    const sql = COMPLIANT_DYNAMIC.replace(
      /ALTER TABLE "publications"/g,
      'ALTER TABLE "wrong_table"'
    );
    expect(hasDynamicDrop(sql, 'publications', 'resource_id')).toBe(false);
  });

  it('returns false when the column lookup does not match', () => {
    expect(
      hasDynamicDrop(COMPLIANT_DYNAMIC, 'publications', 'other_column')
    ).toBe(false);
  });

  it('returns false on an empty file', () => {
    expect(hasDynamicDrop('', 'x', 'y')).toBe(false);
  });
});
