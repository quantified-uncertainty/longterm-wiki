/**
 * Statement Ontology Draft — generate a markdown file for human review of
 * an entity's statement structure.
 *
 * Shows current coverage, gaps, proposed changes, and unstructured statements.
 * The user reviews the markdown, annotates it, and the agent revises.
 * When approved, `apply-draft` executes the changes.
 *
 * Usage:
 *   pnpm crux statements draft <entity-id>
 *   pnpm crux statements draft <entity-id> --org-type=frontier-lab
 *   pnpm crux statements draft <entity-id> --output=./my-draft.md
 */

import { fileURLToPath } from 'url';
import * as fs from 'fs';
import * as path from 'path';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import {
  getStatementsByEntity,
  getProperties,
  type StatementRow,
} from '../lib/wiki-server/statements.ts';
import { getEntity } from '../lib/wiki-server/entities.ts';
import { analyzeGaps } from './gaps.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PropertyInfo {
  id: string;
  label: string;
  category: string;
  statementCount?: number;
  entityTypes?: string[];
}

interface PropertyGroup {
  propertyId: string;
  label: string;
  statements: StatementRow[];
  isNew: boolean;
}

interface CategoryGroup {
  category: string;
  properties: PropertyGroup[];
  totalStatements: number;
}

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------

function groupByCategory(
  statements: StatementRow[],
  propertyMap: Map<string, PropertyInfo>,
): CategoryGroup[] {
  // Group statements by property
  const byProperty = new Map<string, StatementRow[]>();
  const nullProperty: StatementRow[] = [];

  for (const stmt of statements) {
    if (stmt.propertyId) {
      if (!byProperty.has(stmt.propertyId)) byProperty.set(stmt.propertyId, []);
      byProperty.get(stmt.propertyId)!.push(stmt);
    } else {
      nullProperty.push(stmt);
    }
  }

  // Group properties by category
  const byCategory = new Map<string, PropertyGroup[]>();

  for (const [propId, stmts] of byProperty) {
    const propInfo = propertyMap.get(propId);
    const category = propInfo?.category ?? 'uncategorized';
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category)!.push({
      propertyId: propId,
      label: propInfo?.label ?? propId,
      statements: stmts,
      isNew: false,
    });
  }

  // Build category groups
  const groups: CategoryGroup[] = [];
  for (const [cat, props] of [...byCategory.entries()].sort()) {
    const total = props.reduce((sum, p) => sum + p.statements.length, 0);
    // Sort properties by statement count descending
    props.sort((a, b) => b.statements.length - a.statements.length);
    groups.push({ category: cat, properties: props, totalStatements: total });
  }

  // Add null-property group if any
  if (nullProperty.length > 0) {
    groups.push({
      category: '⚠ Unclassified (null propertyId)',
      properties: [{
        propertyId: '(none)',
        label: 'No property assigned',
        statements: nullProperty,
        isNew: false,
      }],
      totalStatements: nullProperty.length,
    });
  }

  return groups;
}

function statusEmoji(count: number, target?: number): string {
  if (!target) {
    if (count >= 5) return '✓';
    if (count >= 2) return '△';
    return '✗';
  }
  if (count >= target) return '✓';
  if (count >= target * 0.5) return '△';
  return '✗';
}

function formatDateRange(stmts: StatementRow[]): string {
  const dates = stmts
    .map((s) => s.validStart)
    .filter((d): d is string => !!d)
    .sort();
  if (dates.length === 0) return '';
  if (dates.length === 1) return dates[0].slice(0, 7);
  return `${dates[0].slice(0, 7)}–${dates[dates.length - 1].slice(0, 7)}`;
}

function findDuplicates(statements: StatementRow[]): Array<[StatementRow, StatementRow]> {
  const pairs: Array<[StatementRow, StatementRow]> = [];
  for (let i = 0; i < statements.length; i++) {
    for (let j = i + 1; j < statements.length; j++) {
      const a = statements[i];
      const b = statements[j];
      // Same property + similar date + same value = likely duplicate
      if (
        a.propertyId && b.propertyId &&
        a.propertyId === b.propertyId &&
        a.valueNumeric != null && b.valueNumeric != null &&
        a.valueNumeric === b.valueNumeric &&
        a.validStart === b.validStart
      ) {
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Markdown generation
// ---------------------------------------------------------------------------

function generateDraft(
  entityId: string,
  entityType: string | null,
  statements: StatementRow[],
  propertyMap: Map<string, PropertyInfo>,
  gapCategories: Map<string, { target: number; current: number }>,
): string {
  const activeStatements = statements.filter((s) => s.status === 'active');
  const structured = activeStatements.filter((s) => s.variety === 'structured');
  const attributed = activeStatements.filter((s) => s.variety === 'attributed');
  const withProperty = activeStatements.filter((s) => s.propertyId);
  const withCitations = activeStatements.filter((s) => {
    const citations = (s as { citations?: unknown[] }).citations ?? [];
    return citations.length > 0;
  });

  const groups = groupByCategory(activeStatements, propertyMap);
  const duplicates = findDuplicates(activeStatements);
  const nullPropertyStmts = activeStatements.filter((s) => !s.propertyId);

  const lines: string[] = [];

  // Header
  lines.push(`# ${entityId} — Statement Ontology Draft`);
  lines.push('');
  lines.push(`> Generated: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`> Review this file, add comments/annotations, then run \`crux statements apply-draft ${entityId}\``);
  lines.push('');

  // Entity info
  lines.push('## Entity Info');
  lines.push(`- **Entity ID**: ${entityId}`);
  lines.push(`- **Type**: ${entityType ?? 'unknown'}`);
  lines.push(`- **Active statements**: ${activeStatements.length} (${structured.length} structured, ${attributed.length} attributed)`);
  lines.push(`- **With property**: ${withProperty.length}/${activeStatements.length} (${activeStatements.length > 0 ? Math.round(withProperty.length / activeStatements.length * 100) : 0}%)`);
  lines.push(`- **With citations**: ${withCitations.length}/${activeStatements.length} (${activeStatements.length > 0 ? Math.round(withCitations.length / activeStatements.length * 100) : 0}%)`);
  lines.push('');

  // Coverage by category
  lines.push('## Current Structure');
  lines.push('');

  for (const group of groups) {
    if (group.category.startsWith('⚠')) continue; // Handle null-property separately
    const gap = gapCategories.get(group.category);
    lines.push(`### ${group.category} (${group.totalStatements} statements)`);
    lines.push('');
    lines.push('| Property | Count | Status | Date Range | Notes |');
    lines.push('|----------|:-----:|--------|------------|-------|');

    for (const prop of group.properties) {
      const count = prop.statements.length;
      const status = statusEmoji(count, gap?.target ? Math.ceil(gap.target / group.properties.length) : undefined);
      const dateRange = formatDateRange(prop.statements);
      lines.push(`| ${prop.propertyId} | ${count} | ${status} | ${dateRange} | |`);
    }
    lines.push('');
  }

  // Gap analysis
  if (gapCategories.size > 0) {
    lines.push('## Coverage Gaps');
    lines.push('');
    lines.push('| Category | Current | Target | Gap |');
    lines.push('|----------|:-------:|:------:|:---:|');
    for (const [cat, info] of [...gapCategories.entries()].sort()) {
      const gap = Math.max(0, info.target - info.current);
      if (gap > 0) {
        lines.push(`| ${cat} | ${info.current} | ${info.target} | ${gap} |`);
      }
    }
    lines.push('');
  }

  // Null-property statements
  if (nullPropertyStmts.length > 0) {
    lines.push(`## Unclassified Statements (${nullPropertyStmts.length} with null propertyId)`);
    lines.push('');
    lines.push('These need a property assignment or retraction:');
    lines.push('');

    for (const stmt of nullPropertyStmts.slice(0, 30)) {
      const text = (stmt.statementText ?? '').slice(0, 100);
      const value = stmt.valueNumeric != null ? ` [value: ${stmt.valueNumeric}]` : '';
      const date = stmt.validStart ? ` (${stmt.validStart})` : '';
      lines.push(`- **#${stmt.id}**: ${text}${value}${date}`);
      lines.push(`  → suggest: <!-- PROPERTY_NAME -->`);
    }
    if (nullPropertyStmts.length > 30) {
      lines.push(`- ... and ${nullPropertyStmts.length - 30} more`);
    }
    lines.push('');
  }

  // Duplicates
  if (duplicates.length > 0) {
    lines.push(`## Potential Duplicates (${duplicates.length})`);
    lines.push('');
    for (const [a, b] of duplicates.slice(0, 15)) {
      lines.push(`- #${a.id} ↔ #${b.id}: ${a.propertyId} = ${a.valueNumeric} (${a.validStart ?? 'no date'})`);
      lines.push(`  → <!-- RETRACT #${b.id} or KEEP -->`);
    }
    if (duplicates.length > 15) {
      lines.push(`- ... and ${duplicates.length - 15} more pairs`);
    }
    lines.push('');
  }

  // Actions section (machine-parseable)
  lines.push('## Actions');
  lines.push('');
  lines.push('Check the boxes for actions to execute with `crux statements apply-draft`:');
  lines.push('');

  // Suggest retraction of duplicates
  if (duplicates.length > 0) {
    lines.push('### Retract');
    for (const [, b] of duplicates) {
      lines.push(`- [ ] RETRACT #${b.id} reason="duplicate"`);
    }
    lines.push('');
  }

  // Suggest property assignment for null-property statements
  if (nullPropertyStmts.length > 0) {
    lines.push('### Classify');
    lines.push('');
    lines.push('Assign properties to unclassified statements:');
    lines.push('');
    for (const stmt of nullPropertyStmts.slice(0, 20)) {
      const text = (stmt.statementText ?? '').slice(0, 80);
      lines.push(`- [ ] CLASSIFY #${stmt.id} property="<!-- FILL IN -->" # ${text}`);
    }
    if (nullPropertyStmts.length > 20) {
      lines.push(`<!-- ${nullPropertyStmts.length - 20} more unclassified statements omitted -->`);
    }
    lines.push('');
  }

  // Suggest new properties
  lines.push('### Create Properties');
  lines.push('');
  lines.push('<!-- Add new properties needed for this entity: -->');
  lines.push('<!-- - [ ] NEW_PROPERTY id="property-id" label="Property Label" category="category" -->');
  lines.push('');

  // Suggest new statements
  lines.push('### Create Statements');
  lines.push('');
  lines.push('<!-- Add new statements: -->');
  lines.push('<!-- - [ ] CREATE property="property-id" value=NUMBER date="YYYY-MM-DD" text="Statement text" -->');
  lines.push('');

  // Footer
  lines.push('---');
  lines.push('');
  lines.push('## How to use this draft');
  lines.push('');
  lines.push('1. Review the structure above and add your annotations/comments');
  lines.push('2. Check boxes `[x]` for actions you approve');
  lines.push('3. Fill in `<!-- FILL IN -->` placeholders for property assignments');
  lines.push('4. Add new `CREATE` or `NEW_PROPERTY` lines as needed');
  lines.push('5. Run `pnpm crux statements apply-draft ' + entityId + '` to execute approved actions');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const c = getColors(false);
  const positional = (args._positional as string[]) || [];
  const entityId = positional[0];
  const orgType = args['org-type'] as string | undefined;
  const outputPath = args.output as string | undefined;

  if (!entityId) {
    console.error(`${c.red}Error: provide an entity ID${c.reset}`);
    console.error(`  Usage: pnpm crux statements draft <entity-id> [--org-type=X] [--output=path]`);
    process.exit(1);
  }

  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.error(`${c.red}Wiki server not available.${c.reset}`);
    process.exit(1);
  }

  // Fetch data in parallel
  const [statementsResult, propertiesResult, entityResult] = await Promise.all([
    getStatementsByEntity(entityId),
    getProperties(),
    getEntity(entityId),
  ]);

  if (!statementsResult.ok) {
    console.error(`${c.red}Could not fetch statements for ${entityId}: ${statementsResult.message}${c.reset}`);
    process.exit(1);
  }

  if (!propertiesResult.ok) {
    console.error(`${c.red}Could not fetch properties: ${propertiesResult.message}${c.reset}`);
    process.exit(1);
  }

  const statements: StatementRow[] = [
    ...statementsResult.data.structured,
    ...statementsResult.data.attributed,
  ];

  const propertyMap = new Map<string, PropertyInfo>();
  for (const p of propertiesResult.data.properties as PropertyInfo[]) {
    propertyMap.set(p.id, p);
  }

  const entityType = entityResult.ok ? (entityResult.data as { entityType?: string }).entityType ?? null : null;

  // Coverage gap analysis
  const gapCategories = new Map<string, { target: number; current: number }>();
  try {
    const gapAnalysis = await analyzeGaps(entityId, orgType ?? null);
    for (const gap of gapAnalysis.gaps) {
      gapCategories.set(gap.category, { target: gap.target, current: gap.actual });
    }
  } catch {
    // Gap analysis may fail if coverage targets aren't configured; that's OK
  }

  // Generate draft
  const markdown = generateDraft(entityId, entityType, statements, propertyMap, gapCategories);

  // Determine output path
  const defaultDir = path.resolve('.claude/ontology-drafts');
  const outPath = outputPath ?? path.join(defaultDir, `${entityId}.md`);

  // Ensure directory exists
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, markdown, 'utf-8');

  console.log(`${c.green}✓ Draft written to ${outPath}${c.reset}`);
  console.log(`\n  ${statements.length} statements analyzed`);
  console.log(`  ${statements.filter((s) => !s.propertyId).length} unclassified (null propertyId)`);
  console.log(`\n  Next: review the file, annotate it, then run:`);
  console.log(`  ${c.bold}pnpm crux statements apply-draft ${entityId}${c.reset}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Statement draft generation failed:', err);
    process.exit(1);
  });
}
