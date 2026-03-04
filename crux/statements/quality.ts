/**
 * Statement Quality Review — reports coverage stats for extracted statements.
 *
 * Analyzes statements for a page/entity and reports:
 *   - Total statements, % with property, % verified, % with citations
 *   - Statements without properties
 *   - Low verdict confidence
 *   - Missing citations
 *   - Section coverage
 *
 * Usage:
 *   pnpm crux statements quality <page-id>
 *   pnpm crux statements quality <page-id> --json
 *
 * Requires: LONGTERMWIKI_SERVER_URL
 */

import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { getStatementsByEntity } from '../lib/wiki-server/statements.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QualityReport {
  entityId: string;
  total: number;
  structured: number;
  attributed: number;
  withProperty: number;
  withPropertyPercent: number;
  withCitations: number;
  withCitationsPercent: number;
  withNumericValue: number;
  verified: number;
  verifiedPercent: number;
  disputed: number;
  unsupported: number;
  unverified: number;
  bySection: Record<string, number>;
  byProperty: Record<string, number>;
  byCategory: Record<string, number>;
  issues: QualityIssue[];
}

interface QualityIssue {
  type: 'no-property' | 'no-citations' | 'low-confidence' | 'no-text';
  statementId: number;
  text: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const jsonOutput = args.json === true;
  const c = getColors(false);
  const positional = (args._positional as string[]) || [];
  const pageId = positional[0];

  if (!pageId) {
    console.error(`${c.red}Error: provide a page ID${c.reset}`);
    console.error(`  Usage: pnpm crux statements quality <page-id> [--json]`);
    process.exit(1);
  }

  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.error(`${c.red}Wiki server not available.${c.reset}`);
    process.exit(1);
  }

  // Fetch statements
  const result = await getStatementsByEntity(pageId);
  if (!result.ok) {
    console.error(`${c.red}Could not fetch statements for ${pageId}.${c.reset}`);
    process.exit(1);
  }

  const allStatements = [
    ...result.data.structured,
    ...result.data.attributed,
  ];

  if (allStatements.length === 0) {
    if (jsonOutput) {
      console.log(JSON.stringify({ entityId: pageId, total: 0, message: 'No statements found' }));
    } else {
      console.log(`${c.yellow}No statements found for ${pageId}. Run extract first.${c.reset}`);
      console.log(`  pnpm crux statements extract ${pageId} --apply`);
    }
    process.exit(0);
  }

  // Analyze
  const issues: QualityIssue[] = [];
  const bySection = new Map<string, number>();
  const byProperty = new Map<string, number>();
  const byCategory = new Map<string, number>();

  let withProperty = 0;
  let withCitations = 0;
  let withNumericValue = 0;
  let verified = 0;
  let disputed = 0;
  let unsupported = 0;
  let unverified = 0;

  for (const stmt of allStatements) {
    // Property coverage
    if (stmt.propertyId) {
      withProperty++;
      byProperty.set(stmt.propertyId, (byProperty.get(stmt.propertyId) ?? 0) + 1);
    } else {
      issues.push({
        type: 'no-property',
        statementId: stmt.id,
        text: (stmt.statementText ?? '').slice(0, 80),
        detail: 'No property assigned',
      });
    }

    // Citation coverage
    const citations = stmt.citations ?? [];
    if (citations.length > 0) {
      withCitations++;
    } else {
      issues.push({
        type: 'no-citations',
        statementId: stmt.id,
        text: (stmt.statementText ?? '').slice(0, 80),
        detail: 'No citations',
      });
    }

    // Numeric values
    if (stmt.valueNumeric !== null && stmt.valueNumeric !== undefined) {
      withNumericValue++;
    }

    // Verdict coverage
    if (stmt.verdict === 'verified') verified++;
    else if (stmt.verdict === 'disputed') disputed++;
    else if (stmt.verdict === 'unsupported') unsupported++;
    else unverified++;

    // Low confidence
    if (stmt.verdictScore !== null && stmt.verdictScore !== undefined && stmt.verdictScore < 0.5) {
      issues.push({
        type: 'low-confidence',
        statementId: stmt.id,
        text: (stmt.statementText ?? '').slice(0, 80),
        detail: `Verdict confidence: ${stmt.verdictScore}`,
      });
    }

    // No text
    if (!stmt.statementText || stmt.statementText.length < 10) {
      issues.push({
        type: 'no-text',
        statementId: stmt.id,
        text: '(empty)',
        detail: 'Missing or very short statementText',
      });
    }

    // Category tracking
    const cat = stmt.claimCategory ?? 'unknown';
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
  }

  // Section tracking from page references
  for (const stmt of allStatements) {
    const pageRefs = ('pageReferences' in stmt) ? (stmt as { pageReferences?: Array<{ section: string | null }> }).pageReferences ?? [] : [];
    for (const ref of pageRefs) {
      if (ref.section) {
        bySection.set(ref.section, (bySection.get(ref.section) ?? 0) + 1);
      }
    }
  }

  const total = allStatements.length;
  const structured = result.data.structured.length;
  const attributed = result.data.attributed.length;

  const report: QualityReport = {
    entityId: pageId,
    total,
    structured,
    attributed,
    withProperty,
    withPropertyPercent: total > 0 ? Math.round(withProperty / total * 100) : 0,
    withCitations,
    withCitationsPercent: total > 0 ? Math.round(withCitations / total * 100) : 0,
    withNumericValue,
    verified,
    verifiedPercent: total > 0 ? Math.round(verified / total * 100) : 0,
    disputed,
    unsupported,
    unverified,
    bySection: Object.fromEntries(bySection),
    byProperty: Object.fromEntries(byProperty),
    byCategory: Object.fromEntries(byCategory),
    issues,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Pretty print
  console.log(`\n${c.bold}${c.blue}Statement Quality Report: ${pageId}${c.reset}\n`);

  console.log(`${c.bold}Overview:${c.reset}`);
  console.log(`  Total statements:     ${c.bold}${total}${c.reset}`);
  console.log(`  Structured:           ${structured}`);
  console.log(`  Attributed:           ${attributed}`);
  console.log('');

  console.log(`${c.bold}Coverage:${c.reset}`);
  const propPctColor = report.withPropertyPercent >= 50 ? c.green : c.yellow;
  const citPctColor = report.withCitationsPercent >= 70 ? c.green : c.yellow;
  const verPctColor = report.verifiedPercent >= 50 ? c.green : c.yellow;
  console.log(`  With property:        ${propPctColor}${withProperty}/${total} (${report.withPropertyPercent}%)${c.reset}`);
  console.log(`  With citations:       ${citPctColor}${withCitations}/${total} (${report.withCitationsPercent}%)${c.reset}`);
  console.log(`  With numeric value:   ${withNumericValue}`);
  console.log('');

  console.log(`${c.bold}Verification:${c.reset}`);
  console.log(`  Verified:     ${c.green}${verified}${c.reset} (${verPctColor}${report.verifiedPercent}%${c.reset})`);
  console.log(`  Disputed:     ${c.red}${disputed}${c.reset}`);
  console.log(`  Unsupported:  ${c.yellow}${unsupported}${c.reset}`);
  console.log(`  Unverified:   ${c.dim}${unverified}${c.reset}`);

  if (byProperty.size > 0) {
    console.log(`\n${c.bold}By property:${c.reset}`);
    const sorted = [...byProperty.entries()].sort((a, b) => b[1] - a[1]);
    for (const [prop, cnt] of sorted.slice(0, 15)) {
      console.log(`  ${prop.padEnd(30)} ${cnt}`);
    }
    if (sorted.length > 15) {
      console.log(`  ... and ${sorted.length - 15} more`);
    }
  }

  if (byCategory.size > 0) {
    console.log(`\n${c.bold}By category:${c.reset}`);
    for (const [cat, cnt] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${cat.padEnd(20)} ${cnt}`);
    }
  }

  if (bySection.size > 0) {
    console.log(`\n${c.bold}By section:${c.reset}`);
    for (const [sec, cnt] of [...bySection.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${sec.slice(0, 40).padEnd(40)} ${cnt}`);
    }
  }

  // Show issues (top 10)
  const issuesByType = new Map<string, number>();
  for (const issue of issues) {
    issuesByType.set(issue.type, (issuesByType.get(issue.type) ?? 0) + 1);
  }

  if (issues.length > 0) {
    console.log(`\n${c.bold}Issues (${issues.length}):${c.reset}`);
    for (const [type, cnt] of [...issuesByType.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${type.padEnd(20)} ${cnt}`);
    }

    console.log(`\n  ${c.dim}Sample issues:${c.reset}`);
    for (const issue of issues.slice(0, 5)) {
      console.log(`    [${issue.type}] ${issue.text}...`);
      console.log(`      ${c.dim}${issue.detail}${c.reset}`);
    }
    if (issues.length > 5) {
      console.log(`    ... and ${issues.length - 5} more`);
    }
  }

  // Grade
  console.log(`\n${c.bold}Grade:${c.reset}`);
  const score =
    (report.withPropertyPercent * 0.3) +
    (report.withCitationsPercent * 0.3) +
    (report.verifiedPercent * 0.4);
  const grade = score >= 70 ? 'A' : score >= 50 ? 'B' : score >= 30 ? 'C' : 'D';
  const gradeColor = grade === 'A' ? c.green : grade === 'B' ? c.yellow : c.red;
  console.log(`  ${gradeColor}${grade}${c.reset} (score: ${Math.round(score)})`);
  console.log(`    Property coverage: ${report.withPropertyPercent}% (target: 50%+)`);
  console.log(`    Citation coverage: ${report.withCitationsPercent}% (target: 70%+)`);
  console.log(`    Verification: ${report.verifiedPercent}% (target: 50%+)`);

  console.log('');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Statement quality review failed:', err);
    process.exit(1);
  });
}
