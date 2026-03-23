/**
 * Rule: Source-Check Verdicts
 *
 * Advisory (non-blocking) rule that warns when source-check verdicts indicate
 * contradicted or outdated records. These verdicts come from the unified
 * verification system and are cached locally in record-verdicts.json and
 * kb-fact-verification.json after build-data runs with wiki-server access.
 *
 * Two data sources are checked:
 *   1. Record verdicts (record-verdicts.json): Covers PG-primary records
 *      like personnel, grants, investments, funding-rounds, etc.
 *      Keys are "recordType:recordId", verdicts include: confirmed,
 *      contradicted, outdated, partial, unverifiable, unchecked.
 *
 *   2. KB fact verdicts (kb-fact-verification.json): Covers FactBase facts
 *      cross-referenced with citation quotes. Keys are fact IDs,
 *      verdicts include: accurate, minor_issues, inaccurate, unsupported,
 *      not_verifiable, verified.
 *
 * If the data files don't exist (e.g. wiki-server was unavailable during build),
 * the rule skips silently.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createRule, Issue, Severity } from '../validation/validation-engine.ts';
import type { ContentFile, ValidationEngine } from '../validation/validation-engine.ts';
import { PROJECT_ROOT } from '../content-types.ts';

const DATA_DIR = join(PROJECT_ROOT, 'apps/web/src/data');
const RECORD_VERDICTS_FILE = join(DATA_DIR, 'record-verdicts.json');
const KB_FACT_VERIFICATION_FILE = join(DATA_DIR, 'kb-fact-verification.json');

/** Record verdict shape from record-verdicts.json */
interface RecordVerdict {
  verdict: string;
  confidence: number | null;
  sourcesChecked: number;
  needsRecheck: boolean;
  lastComputedAt: string | null;
}

/**
 * Safely load and parse a JSON file. Returns null if the file doesn't exist
 * or can't be parsed — the rule should skip gracefully in either case.
 */
function loadJsonSafe<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`source-check-verdicts: failed to parse ${filePath}: ${msg}`);
    return null;
  }
}

export const sourceCheckVerdictsRule = createRule({
  id: 'source-check-verdicts',
  name: 'Source-Check Verdicts',
  description: 'Warn when records or facts have contradicted or outdated source-check verdicts',
  scope: 'global',

  check(_content: ContentFile[], _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // ── Record verdicts ──────────────────────────────────────────────────
    const recordVerdicts = loadJsonSafe<Record<string, RecordVerdict>>(RECORD_VERDICTS_FILE);

    if (recordVerdicts) {
      // Group problematic verdicts by verdict type for a cleaner summary
      const contradicted: string[] = [];
      const outdated: string[] = [];

      for (const [key, rv] of Object.entries(recordVerdicts)) {
        if (rv.verdict === 'contradicted') {
          contradicted.push(key);
        } else if (rv.verdict === 'outdated') {
          outdated.push(key);
        }
      }

      if (contradicted.length > 0) {
        // Cap the listed keys to avoid overwhelming output
        const listed = contradicted.slice(0, 10).join(', ');
        const suffix = contradicted.length > 10
          ? ` (and ${contradicted.length - 10} more)`
          : '';
        issues.push(new Issue({
          rule: 'source-check-verdicts',
          file: RECORD_VERDICTS_FILE,
          message: `${contradicted.length} record(s) have contradicted source-check verdicts: ${listed}${suffix}`,
          severity: Severity.WARNING,
        }));
      }

      if (outdated.length > 0) {
        const listed = outdated.slice(0, 10).join(', ');
        const suffix = outdated.length > 10
          ? ` (and ${outdated.length - 10} more)`
          : '';
        issues.push(new Issue({
          rule: 'source-check-verdicts',
          file: RECORD_VERDICTS_FILE,
          message: `${outdated.length} record(s) have outdated source-check verdicts: ${listed}${suffix}`,
          severity: Severity.WARNING,
        }));
      }
    }

    // ── KB fact verdicts ─────────────────────────────────────────────────
    const kbVerdicts = loadJsonSafe<Record<string, string>>(KB_FACT_VERIFICATION_FILE);

    if (kbVerdicts) {
      const inaccurate: string[] = [];
      const unsupported: string[] = [];

      for (const [factId, verdict] of Object.entries(kbVerdicts)) {
        if (verdict === 'inaccurate') {
          inaccurate.push(factId);
        } else if (verdict === 'unsupported') {
          unsupported.push(factId);
        }
      }

      if (inaccurate.length > 0) {
        const listed = inaccurate.slice(0, 10).join(', ');
        const suffix = inaccurate.length > 10
          ? ` (and ${inaccurate.length - 10} more)`
          : '';
        issues.push(new Issue({
          rule: 'source-check-verdicts',
          file: KB_FACT_VERIFICATION_FILE,
          message: `${inaccurate.length} FactBase fact(s) have inaccurate citation verdicts: ${listed}${suffix}`,
          severity: Severity.WARNING,
        }));
      }

      if (unsupported.length > 0) {
        const listed = unsupported.slice(0, 10).join(', ');
        const suffix = unsupported.length > 10
          ? ` (and ${unsupported.length - 10} more)`
          : '';
        issues.push(new Issue({
          rule: 'source-check-verdicts',
          file: KB_FACT_VERIFICATION_FILE,
          message: `${unsupported.length} FactBase fact(s) have unsupported citation verdicts: ${listed}${suffix}`,
          severity: Severity.WARNING,
        }));
      }
    }

    return issues;
  },
});

export default sourceCheckVerdictsRule;
