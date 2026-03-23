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

    /** Format a truncated list: "a, b, c (and 7 more)" */
    function truncatedList(items: string[], max = 10): string {
      const listed = items.slice(0, max).join(', ');
      return items.length > max ? `${listed} (and ${items.length - max} more)` : listed;
    }

    /** Collect keys matching target verdicts from a record map and emit warnings. */
    function collectVerdictWarnings<V>(
      data: Record<string, V>,
      targets: { verdict: string; getVerdict: (v: V) => string; label: string }[],
      file: string,
    ): void {
      const buckets = new Map<string, string[]>();
      for (const t of targets) buckets.set(t.verdict, []);

      for (const [key, val] of Object.entries(data)) {
        for (const t of targets) {
          if (t.getVerdict(val) === t.verdict) {
            buckets.get(t.verdict)!.push(key);
          }
        }
      }

      for (const t of targets) {
        const keys = buckets.get(t.verdict)!;
        if (keys.length > 0) {
          issues.push(new Issue({
            rule: 'source-check-verdicts',
            file,
            message: `${keys.length} ${t.label}: ${truncatedList(keys)}`,
            severity: Severity.WARNING,
          }));
        }
      }
    }

    // ── Record verdicts ──────────────────────────────────────────────────
    const recordVerdicts = loadJsonSafe<Record<string, RecordVerdict>>(RECORD_VERDICTS_FILE);
    if (recordVerdicts) {
      collectVerdictWarnings(recordVerdicts, [
        { verdict: 'contradicted', getVerdict: (rv) => rv.verdict, label: 'record(s) have contradicted source-check verdicts' },
        { verdict: 'outdated', getVerdict: (rv) => rv.verdict, label: 'record(s) have outdated source-check verdicts' },
      ], RECORD_VERDICTS_FILE);
    }

    // ── KB fact verdicts ─────────────────────────────────────────────────
    const kbVerdicts = loadJsonSafe<Record<string, string>>(KB_FACT_VERIFICATION_FILE);
    if (kbVerdicts) {
      collectVerdictWarnings(kbVerdicts, [
        { verdict: 'inaccurate', getVerdict: (v) => v, label: 'FactBase fact(s) have inaccurate citation verdicts' },
        { verdict: 'unsupported', getVerdict: (v) => v, label: 'FactBase fact(s) have unsupported citation verdicts' },
      ], KB_FACT_VERIFICATION_FILE);
    }

    return issues;
  },
});

export default sourceCheckVerdictsRule;
