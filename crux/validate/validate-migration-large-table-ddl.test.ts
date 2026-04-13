/**
 * Tests for the large-table-ddl migration validator.
 *
 * The validator takes `drizzleDir` as a parameter, so tests write fixture
 * SQL files to a tmp directory and call runCheck() directly. No monkey-
 * patching required.
 *
 * Cases covered:
 * - NOT VALID on a listed table → pass
 * - Bare ADD CONSTRAINT on a listed table → fail
 * - ADD CONSTRAINT on a NON-listed table → pass
 * - `SELECT 1;` no-op file → pass
 * - Multi-line ADD CONSTRAINT statement without NOT VALID → fail
 * - File with a follow-up VALIDATE CONSTRAINT in same file → pass
 * - ADD COLUMN with inline CHECK (different code path) → pass
 * - Commented-out ADD CONSTRAINT → pass
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { runCheck } from './validate-migration-large-table-ddl.ts';

function mkTmp(): string {
  const dir = join(os.tmpdir(), `validate-large-table-ddl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSql(dir: string, name: string, sql: string) {
  writeFileSync(join(dir, name), sql);
}

describe('validate-migration-large-table-ddl', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkTmp();
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('passes when ADD CONSTRAINT on a listed table uses NOT VALID', () => {
    writeSql(
      tmp,
      '0900_good.sql',
      `ALTER TABLE "hallucination_risk_snapshots"
         ADD CONSTRAINT chk_hrs_level
         CHECK (level IN ('low','medium','high')) NOT VALID;`,
    );
    const r = runCheck(tmp);
    expect(r.passed).toBe(true);
    expect(r.errors).toBe(0);
    expect(r.violations).toEqual([]);
  });

  it('fails on bare ADD CONSTRAINT on a listed table', () => {
    writeSql(
      tmp,
      '0901_bad.sql',
      `ALTER TABLE "hallucination_risk_snapshots"
         ADD CONSTRAINT chk_hrs_level
         CHECK (level IN ('low','medium','high'));`,
    );
    const r = runCheck(tmp);
    expect(r.passed).toBe(false);
    expect(r.errors).toBe(1);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].file).toBe('0901_bad.sql');
    expect(r.violations[0].table).toBe('hallucination_risk_snapshots');
    expect(r.violations[0].line).toBeGreaterThanOrEqual(1);
  });

  it('passes when ADD CONSTRAINT targets a NON-listed table', () => {
    writeSql(
      tmp,
      '0902_other.sql',
      `ALTER TABLE "divisions"
         ADD CONSTRAINT chk_div_type
         CHECK (division_type IN ('a','b'));`,
    );
    const r = runCheck(tmp);
    expect(r.passed).toBe(true);
    expect(r.errors).toBe(0);
  });

  it('passes SELECT 1; no-op migration files', () => {
    writeSql(tmp, '0903_noop.sql', '-- defers DDL to a manual script\nSELECT 1;');
    const r = runCheck(tmp);
    expect(r.passed).toBe(true);
    expect(r.filesScanned).toBe(1);
  });

  it('fails multi-line ADD CONSTRAINT without NOT VALID', () => {
    writeSql(
      tmp,
      '0904_multiline.sql',
      `DO $$ BEGIN
         ALTER TABLE "hallucination_risk_snapshots"
           ADD CONSTRAINT chk_hrs_level
           CHECK (level IN ('low', 'medium', 'high'));
       EXCEPTION WHEN duplicate_object THEN NULL;
       END $$;`,
    );
    const r = runCheck(tmp);
    expect(r.passed).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].table).toBe('hallucination_risk_snapshots');
  });

  it('passes when NOT VALID is on the ADD CONSTRAINT and a follow-up VALIDATE CONSTRAINT runs in the same file', () => {
    writeSql(
      tmp,
      '0905_split.sql',
      `ALTER TABLE "hallucination_risk_snapshots"
         ADD CONSTRAINT chk_hrs_level
         CHECK (level IN ('low','medium','high')) NOT VALID;

       ALTER TABLE "hallucination_risk_snapshots"
         VALIDATE CONSTRAINT chk_hrs_level;`,
    );
    const r = runCheck(tmp);
    expect(r.passed).toBe(true);
    expect(r.errors).toBe(0);
  });

  it('ignores ADD COLUMN ... CHECK (...) inline (different code path)', () => {
    writeSql(
      tmp,
      '0906_add_column.sql',
      `ALTER TABLE "hallucination_risk_snapshots"
         ADD COLUMN new_col text CHECK (new_col IN ('x','y'));`,
    );
    const r = runCheck(tmp);
    expect(r.passed).toBe(true);
  });

  it('ignores commented-out ADD CONSTRAINT', () => {
    writeSql(
      tmp,
      '0907_commented.sql',
      `-- ALTER TABLE "hallucination_risk_snapshots" ADD CONSTRAINT chk_x CHECK (level IS NOT NULL);
       SELECT 1;`,
    );
    const r = runCheck(tmp);
    expect(r.passed).toBe(true);
  });

  it('ignores block-commented ADD CONSTRAINT', () => {
    writeSql(
      tmp,
      '0908_block_commented.sql',
      `/* example:
          ALTER TABLE "hallucination_risk_snapshots"
            ADD CONSTRAINT chk_x CHECK (level IS NOT NULL);
        */
       SELECT 1;`,
    );
    const r = runCheck(tmp);
    expect(r.passed).toBe(true);
  });

  it('handles missing drizzle directory gracefully', () => {
    const r = runCheck(join(tmp, 'does-not-exist'));
    expect(r.passed).toBe(true);
    expect(r.filesScanned).toBe(0);
  });

  it('reports one violation per statement, not per file', () => {
    writeSql(
      tmp,
      '0909_multi.sql',
      `ALTER TABLE "hallucination_risk_snapshots"
         ADD CONSTRAINT chk_a CHECK (level IN ('low'));
       ALTER TABLE "hallucination_risk_snapshots"
         ADD CONSTRAINT chk_b CHECK (level IN ('high'));`,
    );
    const r = runCheck(tmp);
    expect(r.passed).toBe(false);
    expect(r.violations).toHaveLength(2);
  });
});
