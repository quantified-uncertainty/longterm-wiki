/**
 * Data quality assertions for the statements extraction pipeline.
 *
 * These checks run after extraction and before any DB writes. In dry-run mode,
 * failures are reported but do not abort (so users can see what bad data looks
 * like). In apply mode, failures abort the pipeline before writing to the DB.
 *
 * Design principle: catch the classes of junk data that have reached production
 * in the past:
 *   - Empty statement text (LLM returned blank strings)
 *   - NaN / Infinity in numeric values (causes Postgres errors)
 *   - All-zero numeric values across the batch (suggests extraction failure)
 *   - Zero statements extracted from a page with substantial content
 */

import type { ExtractedStatement } from './extract.ts';
import type { CreateStatementInput, StatementRow } from '../lib/wiki-server/statements.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QualityViolation {
  /** Machine-readable violation code. */
  code: string;
  /** Human-readable description of what went wrong. */
  message: string;
  /** Statement index (0-based) in the batch, if applicable. */
  statementIndex?: number;
  /** Short excerpt of the statement text, for context. */
  excerpt?: string;
}

export interface QualityReport {
  /** True if all assertions passed. */
  passed: boolean;
  /** Total violations found. */
  violationCount: number;
  /** Per-violation details. */
  violations: QualityViolation[];
  /** Summary stats used during validation. */
  stats: {
    total: number;
    emptyText: number;
    nanValues: number;
    allZeroNumeric: boolean;
    zeroStatements: boolean;
  };
}

// ---------------------------------------------------------------------------
// Validation of ExtractedStatement[] (post-LLM, pre-DB-write in extract.ts)
// ---------------------------------------------------------------------------

/**
 * Validate a batch of extracted statements before writing to the database.
 *
 * @param statements  Statements as returned by extractStatementsFromSection()
 * @param sectionCount  Number of sections in the page (used to assess
 *                      whether zero statements is suspicious)
 */
export function validateExtractedStatements(
  statements: ExtractedStatement[],
  sectionCount: number,
): QualityReport {
  const violations: QualityViolation[] = [];

  // --- Check 1: Zero statements from a page with content ---
  const zeroStatements = statements.length === 0 && sectionCount >= 2;
  if (zeroStatements) {
    violations.push({
      code: 'ZERO_STATEMENTS',
      message: `No statements were extracted from a page with ${sectionCount} sections. This likely indicates an LLM failure or an API error.`,
    });
  }

  // Per-statement checks
  let emptyTextCount = 0;
  let nanValueCount = 0;
  const numericValues: number[] = [];

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const excerpt = stmt.statementText?.slice(0, 60) ?? '';

    // --- Check 2: Empty or whitespace-only statement text ---
    if (!stmt.statementText || stmt.statementText.trim().length === 0) {
      emptyTextCount++;
      violations.push({
        code: 'EMPTY_STATEMENT_TEXT',
        message: `Statement at index ${i} has empty or whitespace-only text.`,
        statementIndex: i,
        excerpt,
      });
      continue; // skip further checks on this statement
    }

    // --- Check 3: NaN or Infinity in numeric value ---
    if (stmt.valueNumeric !== null && stmt.valueNumeric !== undefined) {
      if (!Number.isFinite(stmt.valueNumeric)) {
        nanValueCount++;
        violations.push({
          code: 'NON_FINITE_NUMERIC',
          message: `Statement at index ${i} has non-finite valueNumeric: ${stmt.valueNumeric}`,
          statementIndex: i,
          excerpt,
        });
      } else {
        numericValues.push(stmt.valueNumeric);
      }
    }
  }

  // --- Check 4: All numeric values are exactly 0 (suspicious batch failure) ---
  // Only apply when there are ≥3 numeric values, to avoid false positives on
  // legitimate pages where most values happen to be zero (e.g. founding year offsets).
  const allZeroNumeric =
    numericValues.length >= 3 && numericValues.every(v => v === 0);
  if (allZeroNumeric) {
    violations.push({
      code: 'ALL_ZERO_NUMERIC',
      message: `All ${numericValues.length} numeric values in the batch are exactly 0. This strongly suggests an extraction failure where the LLM could not parse numeric data.`,
    });
  }

  const stats = {
    total: statements.length,
    emptyText: emptyTextCount,
    nanValues: nanValueCount,
    allZeroNumeric,
    zeroStatements,
  };

  return {
    passed: violations.length === 0,
    violationCount: violations.length,
    violations,
    stats,
  };
}

// ---------------------------------------------------------------------------
// Validation of CreateStatementInput[] (post-quality-gate in improve.ts)
// ---------------------------------------------------------------------------

/**
 * Validate a batch of CreateStatementInput objects before insertion.
 *
 * Lighter-weight than validateExtractedStatements() — used in improve.ts
 * where statements have already passed the quality gate. Catches last-mile
 * data corruption (e.g. NaN slipping through number coercion).
 */
export function validateCreateStatementBatch(
  items: CreateStatementInput[],
): QualityReport {
  const violations: QualityViolation[] = [];

  let emptyTextCount = 0;
  let nanValueCount = 0;
  const numericValues: number[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const excerpt = (item.statementText ?? '').slice(0, 60);

    // Empty text
    if (!item.statementText || item.statementText.trim().length === 0) {
      emptyTextCount++;
      violations.push({
        code: 'EMPTY_STATEMENT_TEXT',
        message: `Item at index ${i} has empty or whitespace-only statementText.`,
        statementIndex: i,
        excerpt,
      });
      continue;
    }

    // NaN / Infinity numeric
    const num = item.valueNumeric;
    if (num !== null && num !== undefined) {
      if (!Number.isFinite(num)) {
        nanValueCount++;
        violations.push({
          code: 'NON_FINITE_NUMERIC',
          message: `Item at index ${i} has non-finite valueNumeric: ${num}`,
          statementIndex: i,
          excerpt,
        });
      } else {
        numericValues.push(num);
      }
    }
  }

  const allZeroNumeric =
    numericValues.length >= 3 && numericValues.every(v => v === 0);
  if (allZeroNumeric) {
    violations.push({
      code: 'ALL_ZERO_NUMERIC',
      message: `All ${numericValues.length} numeric values in the batch are exactly 0. This strongly suggests an extraction failure.`,
    });
  }

  // Duplicate (subjectEntityId, propertyId, valueDate) tuples — only checked
  // when all three key fields are non-null so null-valued items don't false-positive.
  const tuplesSeen = new Map<string, number>();
  let duplicateCount = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.subjectEntityId && item.propertyId && item.valueDate) {
      const key = `${item.subjectEntityId}|${item.propertyId}|${item.valueDate}`;
      if (tuplesSeen.has(key)) {
        duplicateCount++;
        const firstIndex = tuplesSeen.get(key)!;
        violations.push({
          code: 'DUPLICATE_TUPLE',
          message: `Item at index ${i} is a duplicate of item at index ${firstIndex} (same subjectEntityId/propertyId/valueDate).`,
          statementIndex: i,
          excerpt: (item.statementText ?? '').slice(0, 60),
        });
      } else {
        tuplesSeen.set(key, i);
      }
    }
  }

  const stats = {
    total: items.length,
    emptyText: emptyTextCount,
    nanValues: nanValueCount,
    allZeroNumeric,
    zeroStatements: items.length === 0,
  };

  return {
    passed: violations.length === 0,
    violationCount: violations.length,
    violations,
    stats,
  };
}

// ---------------------------------------------------------------------------
// Shared renderer (for CLI output)
// ---------------------------------------------------------------------------

/**
 * Print a QualityReport to stdout using color helpers.
 *
 * @param report   The report from validateExtractedStatements()
 * @param c        Color helpers from getColors()
 * @param dryRun   If true, violations are warnings; if false, violations abort
 */
export function printQualityReport(
  report: QualityReport,
  c: { red: string; yellow: string; green: string; bold: string; dim: string; reset: string },
  dryRun: boolean,
): void {
  if (report.passed) {
    console.log(`  ${c.green}Data quality: all assertions passed.${c.reset}`);
    return;
  }

  const severity = dryRun ? c.yellow : c.red;
  const label = dryRun ? 'WARNING' : 'ERROR';

  console.log(`\n${severity}${c.bold}Data quality ${label}: ${report.violationCount} violation(s)${c.reset}`);
  for (const v of report.violations) {
    const excerptPart = v.excerpt ? ` — "${v.excerpt}"` : '';
    console.log(`  ${severity}[${v.code}]${c.reset} ${v.message}${excerptPart}`);
  }

  if (dryRun) {
    console.log(`  ${c.dim}(dry-run: violations logged but not blocking)${c.reset}`);
  } else {
    console.log(`  ${c.red}Pipeline aborted. Fix the extraction issue or use --dry-run to inspect.${c.reset}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Cross-session duplicate check (new batch vs existing active statements)
// ---------------------------------------------------------------------------

/**
 * Check a batch of about-to-be-inserted statements against existing active
 * statements in the DB for the same entity.
 *
 * Returns violations for any new statement that exactly duplicates an already-
 * active statement (same propertyId + value + valueDate). These are statements
 * that the batch-level DUPLICATE_TUPLE check cannot catch because the existing
 * statement lives in a prior session.
 *
 * Call this immediately before createStatementBatch() and treat violations as
 * warnings (not hard failures) — the caller may still want to insert non-duplicate
 * statements from the same batch.
 */
export function checkAgainstExisting(
  incoming: CreateStatementInput[],
  existingActive: StatementRow[],
): QualityViolation[] {
  const violations: QualityViolation[] = [];

  // Build a lookup key for each existing active statement that has enough
  // fields to make the comparison meaningful.
  const existingKeys = new Set<string>();
  for (const s of existingActive) {
    if (!s.propertyId) continue;
    const valueKey = s.valueNumeric !== null && s.valueNumeric !== undefined
      ? `num:${s.valueNumeric}`
      : s.valueText !== null && s.valueText !== undefined
        ? `txt:${s.valueText}`
        : s.valueEntityId !== null && s.valueEntityId !== undefined
          ? `eid:${s.valueEntityId}`
          : null;
    if (!valueKey) continue;
    existingKeys.add(`${s.subjectEntityId}|${s.propertyId}|${valueKey}|${s.valueDate ?? ''}`);
  }

  for (let i = 0; i < incoming.length; i++) {
    const item = incoming[i]!;
    if (!item.propertyId || !item.subjectEntityId) continue;

    const valueKey = item.valueNumeric !== null && item.valueNumeric !== undefined
      ? `num:${item.valueNumeric}`
      : item.valueText !== null && item.valueText !== undefined
        ? `txt:${item.valueText}`
        : item.valueEntityId !== null && item.valueEntityId !== undefined
          ? `eid:${item.valueEntityId}`
          : null;
    if (!valueKey) continue;

    const key = `${item.subjectEntityId}|${item.propertyId}|${valueKey}|${item.valueDate ?? ''}`;
    if (existingKeys.has(key)) {
      violations.push({
        code: 'CROSS_SESSION_DUPLICATE',
        message: `Statement at index ${i} duplicates an existing active statement `
          + `(${item.subjectEntityId} / ${item.propertyId} = ${valueKey} @ ${item.valueDate ?? 'no date'}).`,
        statementIndex: i,
        excerpt: (item.statementText ?? '').slice(0, 60),
      });
    }
  }

  return violations;
}
