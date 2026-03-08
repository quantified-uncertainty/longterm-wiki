/**
 * Statement Audit — detect data integrity issues in active statements.
 *
 * Catches two classes of problem that the batch-level quality gate cannot see
 * because it only inspects statements within a single extraction run:
 *
 *   DUPLICATE_ACTIVE   — two active statements share the same
 *                        (propertyId, value, valueDate). One is redundant and
 *                        should be retracted. --fix auto-retracts the older one.
 *
 *   NEEDS_QUALIFIER    — two active statements share (propertyId, valueDate)
 *                        but have different values and neither has a qualifierKey.
 *                        They may both be correct but refer to different subjects
 *                        (e.g. "equity-stake 2.5% = co-founder" vs "15% = employee pool").
 *                        A qualifierKey should distinguish them; flagged for manual review.
 *
 * Usage:
 *   pnpm crux statements audit <entity-id>
 *   pnpm crux statements audit <entity-id> --fix     # retract older exact duplicates
 *   pnpm crux statements audit <entity-id> --json    # machine-readable output
 */

import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import {
  getStatementsByEntity,
  patchStatement,
  type StatementRow,
} from '../lib/wiki-server/statements.ts';

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export interface DuplicateActiveIssue {
  type: 'DUPLICATE_ACTIVE';
  /** [older-id, newer-id] — older should be retracted on --fix */
  ids: [number, number];
  property: string;
  value: string;
  date: string | null;
  olderText: string | null;
  newerText: string | null;
}

export interface NeedsQualifierIssue {
  type: 'NEEDS_QUALIFIER';
  ids: [number, number];
  property: string;
  values: [string, string];
  date: string | null;
  texts: [string | null, string | null];
}

export type AuditIssue = DuplicateActiveIssue | NeedsQualifierIssue;

export interface AuditReport {
  entity: string;
  totalActive: number;
  issues: AuditIssue[];
  duplicateCount: number;
  needsQualifierCount: number;
}

// ---------------------------------------------------------------------------
// Detection logic (pure — no I/O, fully testable)
// ---------------------------------------------------------------------------

function formatValue(s: StatementRow): string {
  if (s.valueNumeric !== null && s.valueNumeric !== undefined) return String(s.valueNumeric);
  if (s.valueText !== null && s.valueText !== undefined) return s.valueText;
  if (s.valueEntityId !== null && s.valueEntityId !== undefined) return s.valueEntityId;
  return '';
}

function valuesEqual(a: StatementRow, b: StatementRow): boolean {
  // Numeric comparison
  if (a.valueNumeric !== null && a.valueNumeric !== undefined &&
      b.valueNumeric !== null && b.valueNumeric !== undefined) {
    return a.valueNumeric === b.valueNumeric;
  }
  // Text comparison
  if (a.valueText !== null && a.valueText !== undefined &&
      b.valueText !== null && b.valueText !== undefined) {
    return a.valueText === b.valueText;
  }
  // Entity comparison
  if (a.valueEntityId !== null && a.valueEntityId !== undefined &&
      b.valueEntityId !== null && b.valueEntityId !== undefined) {
    return a.valueEntityId === b.valueEntityId;
  }
  // Both have no value
  if (formatValue(a) === '' && formatValue(b) === '') return true;
  return false;
}

/**
 * Detect DUPLICATE_ACTIVE and NEEDS_QUALIFIER issues in a list of statements.
 *
 * Only active, propertied statements are considered. Statements that already
 * have a qualifierKey are not flagged (they are intentionally multi-valued).
 */
export function detectActiveConflicts(statements: StatementRow[]): AuditIssue[] {
  const active = statements.filter(
    (s) => s.status === 'active' && s.propertyId,
  );

  // Group by (propertyId, valueDate) — same property at the same point in time
  const groups = new Map<string, StatementRow[]>();
  for (const s of active) {
    const key = `${s.propertyId}|||${s.valueDate ?? ''}`;
    const group = groups.get(key) ?? [];
    group.push(s);
    groups.set(key, group);
  }

  const issues: AuditIssue[] = [];

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    // Compare every pair within the group
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;

        // Skip if either already has a qualifier — it's intentionally distinct
        if (a.qualifierKey || b.qualifierKey) continue;

        const [older, newer] = a.id < b.id ? [a, b] : [b, a];

        if (valuesEqual(a, b)) {
          issues.push({
            type: 'DUPLICATE_ACTIVE',
            ids: [older.id, newer.id],
            property: a.propertyId!,
            value: formatValue(a),
            date: a.valueDate ?? null,
            olderText: older.statementText?.slice(0, 100) ?? null,
            newerText: newer.statementText?.slice(0, 100) ?? null,
          });
        } else {
          issues.push({
            type: 'NEEDS_QUALIFIER',
            ids: [older.id, newer.id],
            property: a.propertyId!,
            values: [formatValue(older), formatValue(newer)],
            date: a.valueDate ?? null,
            texts: [
              older.statementText?.slice(0, 100) ?? null,
              newer.statementText?.slice(0, 100) ?? null,
            ],
          });
        }
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const c = getColors(false);
  const positional = (args._positional as string[]) ?? [];
  const entityId = positional[0];
  const fix = args.fix === true;
  const jsonOutput = args.json === true;

  if (!entityId) {
    console.error(`${c.red}Usage: crux statements audit <entity-id> [--fix] [--json]${c.reset}`);
    process.exit(1);
  }

  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.error(`${c.red}Wiki server not available.${c.reset}`);
    process.exit(1);
  }

  // Fetch all statements (all statuses so we have full context)
  const result = await getStatementsByEntity(entityId);
  if (!result.ok) {
    console.error(`${c.red}Failed to fetch statements: ${result.message}${c.reset}`);
    process.exit(1);
  }

  const statements = [
    ...(result.data.structured as StatementRow[]),
    ...(result.data.attributed as StatementRow[]),
  ];
  const active = statements.filter((s) => s.status === 'active');
  const issues = detectActiveConflicts(statements);

  const report: AuditReport = {
    entity: entityId,
    totalActive: active.length,
    issues,
    duplicateCount: issues.filter((i) => i.type === 'DUPLICATE_ACTIVE').length,
    needsQualifierCount: issues.filter((i) => i.type === 'NEEDS_QUALIFIER').length,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Human-readable output
  console.log(`\n${c.bold}${c.blue}Statement Audit: ${entityId}${c.reset}`);
  console.log(`${c.dim}Active statements: ${active.length}${c.reset}\n`);

  if (issues.length === 0) {
    console.log(`${c.green}✓ No issues found.${c.reset}\n`);
    return;
  }

  // Print duplicates
  const duplicates = issues.filter((i): i is DuplicateActiveIssue => i.type === 'DUPLICATE_ACTIVE');
  if (duplicates.length > 0) {
    console.log(`${c.red}${c.bold}Exact duplicates (${duplicates.length}) — safe to retract older:${c.reset}`);
    for (const issue of duplicates) {
      const dateStr = issue.date ? ` [${issue.date}]` : '';
      console.log(`  ${c.red}[DUPLICATE]${c.reset} ${c.bold}${issue.property}${c.reset} = ${issue.value}${dateStr}`);
      console.log(`    ${c.dim}older #${issue.ids[0]}:${c.reset} ${issue.olderText ?? '(no text)'}`);
      console.log(`    ${c.dim}newer #${issue.ids[1]}:${c.reset} ${issue.newerText ?? '(no text)'}`);
    }
    console.log('');
  }

  // Print needs-qualifier
  const qualifierIssues = issues.filter((i): i is NeedsQualifierIssue => i.type === 'NEEDS_QUALIFIER');
  if (qualifierIssues.length > 0) {
    console.log(`${c.yellow}${c.bold}Different values, no qualifier (${qualifierIssues.length}) — add qualifierKey to distinguish:${c.reset}`);
    for (const issue of qualifierIssues) {
      const dateStr = issue.date ? ` [${issue.date}]` : '';
      console.log(`  ${c.yellow}[QUALIFIER]${c.reset} ${c.bold}${issue.property}${c.reset}${dateStr}`);
      console.log(`    #${issue.ids[0]} = ${issue.values[0]}: ${issue.texts[0] ?? '(no text)'}`);
      console.log(`    #${issue.ids[1]} = ${issue.values[1]}: ${issue.texts[1] ?? '(no text)'}`);
    }
    console.log('');
  }

  // Auto-fix
  if (fix && duplicates.length > 0) {
    console.log(`${c.bold}Auto-fixing ${duplicates.length} exact duplicate(s)...${c.reset}`);
    let fixed = 0;
    for (const issue of duplicates) {
      const olderIdToRetract = issue.ids[0];
      const result = await patchStatement(olderIdToRetract, {
        status: 'retracted',
        archiveReason: `duplicate of #${issue.ids[1]} (auto-retracted by crux statements audit --fix)`,
      });
      if (result.ok) {
        console.log(`  ${c.green}✓ Retracted #${olderIdToRetract}${c.reset} (${issue.property} = ${issue.value})`);
        fixed++;
      } else {
        console.log(`  ${c.red}✗ Failed to retract #${olderIdToRetract}: ${result.message}${c.reset}`);
      }
    }
    console.log(`\n${c.green}Fixed ${fixed}/${duplicates.length} duplicates.${c.reset}`);
    if (qualifierIssues.length > 0) {
      console.log(`${c.yellow}${qualifierIssues.length} qualifier issue(s) require manual review.${c.reset}`);
    }
  } else if (duplicates.length > 0) {
    console.log(`${c.dim}Run with --fix to auto-retract the ${duplicates.length} older duplicate(s).${c.reset}`);
  }

  console.log('');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
