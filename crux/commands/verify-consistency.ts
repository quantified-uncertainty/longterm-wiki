/**
 * Unified Consistency Check Command
 *
 * Runs all three consistency validators and produces a combined report:
 *   1. Cross-entity consistency (person<->org, model<->org, bidirectional refs)
 *   2. Prose consistency (probability estimates, terminology, causal claims)
 *   3. Numeric consistency (contradictory numeric claims across pages)
 *
 * Usage:
 *   crux w verify-consistency                          Run all consistency checks
 *   crux w verify-consistency --type=cross-entity      Just cross-entity checks
 *   crux w verify-consistency --type=numeric           Just numeric consistency
 *   crux w verify-consistency --type=prose             Just prose/terminology consistency
 *   crux w verify-consistency --ci                     JSON output for CI
 *   crux w verify-consistency --verbose                Show all issues including info-level
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { getColors } from '../lib/output.ts';
import {
  runCrossEntityCheck,
  type Mismatch,
  type CrossEntityCheckResult,
} from '../validate/cross-entity-consistency.ts';
import {
  runDetailedCheck,
  type ProseConsistencyResult,
} from '../validate/validate-consistency.ts';
import {
  runNumericConsistencyDetailed,
  type NumericConsistencyDetailedResult,
} from '../validate/validate-numeric-consistency.ts';

// ── Types ────────────────────────────────────────────────────────────

type CheckType = 'cross-entity' | 'prose' | 'numeric';

const VALID_TYPES: CheckType[] = ['cross-entity', 'prose', 'numeric'];

interface VerifyConsistencyOptions extends BaseOptions {
  type?: string;
  ci?: boolean;
  verbose?: boolean;
}

interface CheckCategoryCounts {
  errors: number;
  warnings: number;
  infos: number;
}

interface SummaryRow {
  label: string;
  counts: CheckCategoryCounts;
}

// ── Cross-entity result processing ──────────────────────────────────

function processCrossEntityMismatches(mismatches: Mismatch[]): SummaryRow[] {
  const byCheckType = new Map<string, Mismatch[]>();
  for (const m of mismatches) {
    if (!byCheckType.has(m.checkType)) byCheckType.set(m.checkType, []);
    byCheckType.get(m.checkType)!.push(m);
  }

  const CHECK_LABELS: Record<string, string> = {
    'person-org': 'person-org',
    'model-org': 'model-org',
    'bidirectional-related': 'bidirectional',
    'person-affiliation-coherence': 'affiliation',
    'project-org': 'project-org',
  };

  const rows: SummaryRow[] = [];
  for (const [checkType, label] of Object.entries(CHECK_LABELS)) {
    const items = byCheckType.get(checkType) || [];
    rows.push({
      label,
      counts: {
        errors: items.filter(m => m.severity === 'error').length,
        warnings: items.filter(m => m.severity === 'warning').length,
        infos: items.filter(m => m.severity === 'info').length,
      },
    });
  }

  return rows;
}

// ── Prose result processing ─────────────────────────────────────────

function processProseResult(result: ProseConsistencyResult): SummaryRow[] {
  const rows: SummaryRow[] = [];

  const probWarnings = result.probabilityIssues.filter(i => i.severity === 'warning').length;
  const probInfos = result.probabilityIssues.filter(i => i.severity === 'info').length;
  rows.push({
    label: 'probability',
    counts: { errors: 0, warnings: probWarnings, infos: probInfos },
  });

  rows.push({
    label: 'terminology',
    counts: { errors: 0, warnings: 0, infos: result.terminologyIssues.length },
  });

  rows.push({
    label: 'causal-claims',
    counts: { errors: 0, warnings: 0, infos: result.causalIssues.length },
  });

  return rows;
}

// ── Numeric result processing ───────────────────────────────────────

function processNumericResult(result: NumericConsistencyDetailedResult): SummaryRow[] {
  return [{
    label: 'numeric',
    counts: {
      errors: 0,
      warnings: result.contradictions.length,
      infos: 0,
    },
  }];
}

// ── Summary table rendering ─────────────────────────────────────────

function renderSummaryTable(
  rows: SummaryRow[],
  c: ReturnType<typeof getColors>,
): string {
  const lines: string[] = [];

  const LABEL_WIDTH = 22;
  const COL_WIDTH = 10;

  const header =
    'Check Type'.padEnd(LABEL_WIDTH) +
    'Errors'.padStart(COL_WIDTH) +
    'Warnings'.padStart(COL_WIDTH) +
    'Info'.padStart(COL_WIDTH);
  const separator = '-'.repeat(header.length);

  lines.push(header);
  lines.push(separator);

  let totalErrors = 0;
  let totalWarnings = 0;
  let totalInfos = 0;

  for (const row of rows) {
    const { errors, warnings, infos } = row.counts;
    totalErrors += errors;
    totalWarnings += warnings;
    totalInfos += infos;

    const fmtE = errors > 0
      ? c.red + errors.toString().padStart(COL_WIDTH) + c.reset
      : c.dim + '0'.padStart(COL_WIDTH) + c.reset;
    const fmtW = warnings > 0
      ? c.yellow + warnings.toString().padStart(COL_WIDTH) + c.reset
      : c.dim + '0'.padStart(COL_WIDTH) + c.reset;
    const fmtI = infos > 0
      ? c.blue + infos.toString().padStart(COL_WIDTH) + c.reset
      : c.dim + '0'.padStart(COL_WIDTH) + c.reset;

    lines.push(row.label.padEnd(LABEL_WIDTH) + fmtE + fmtW + fmtI);
  }

  lines.push(separator);

  const fmtTE = totalErrors > 0
    ? c.red + totalErrors.toString().padStart(COL_WIDTH) + c.reset
    : c.dim + '0'.padStart(COL_WIDTH) + c.reset;
  const fmtTW = totalWarnings > 0
    ? c.yellow + totalWarnings.toString().padStart(COL_WIDTH) + c.reset
    : c.dim + '0'.padStart(COL_WIDTH) + c.reset;
  const fmtTI = totalInfos > 0
    ? c.blue + totalInfos.toString().padStart(COL_WIDTH) + c.reset
    : c.dim + '0'.padStart(COL_WIDTH) + c.reset;

  lines.push('Total'.padEnd(LABEL_WIDTH) + fmtTE + fmtTW + fmtTI);

  return lines.join('\n');
}

// ── Detailed output rendering ───────────────────────────────────────

function renderCrossEntityDetails(
  mismatches: Mismatch[],
  verbose: boolean,
  c: ReturnType<typeof getColors>,
): string {
  if (mismatches.length === 0) return '';

  const lines: string[] = [];
  const warnings = mismatches.filter(m => m.severity === 'warning');
  const infos = mismatches.filter(m => m.severity === 'info');

  if (warnings.length > 0) {
    lines.push('');
    lines.push(c.bold + 'Cross-Entity Warnings' + c.reset);
    const toShow = verbose ? warnings : warnings.slice(0, 10);
    for (const m of toShow) {
      lines.push(`  ${c.yellow}!${c.reset} [${m.checkType}] ${m.description}`);
      lines.push(`    ${c.dim}Fix: ${m.suggestion}${c.reset}`);
    }
    if (!verbose && warnings.length > 10) {
      lines.push(`  ${c.dim}... and ${warnings.length - 10} more (use --verbose)${c.reset}`);
    }
  }

  if (verbose && infos.length > 0) {
    lines.push('');
    lines.push(c.bold + 'Cross-Entity Info' + c.reset);
    const toShow = infos.slice(0, 20);
    for (const m of toShow) {
      lines.push(`  ${c.blue}i${c.reset} ${c.dim}[${m.checkType}] ${m.description}${c.reset}`);
    }
    if (infos.length > 20) {
      lines.push(`  ${c.dim}... and ${infos.length - 20} more${c.reset}`);
    }
  }

  return lines.join('\n');
}

function renderProseDetails(
  result: ProseConsistencyResult,
  verbose: boolean,
  c: ReturnType<typeof getColors>,
): string {
  const lines: string[] = [];

  const probWarnings = result.probabilityIssues.filter(i => i.severity === 'warning');
  if (probWarnings.length > 0) {
    lines.push('');
    lines.push(c.bold + 'Probability Estimate Warnings' + c.reset);
    const toShow = verbose ? probWarnings : probWarnings.slice(0, 5);
    for (const issue of toShow) {
      lines.push(`  ${c.yellow}!${c.reset} ${issue.description} (${issue.gap})`);
      for (const loc of issue.locations) {
        lines.push(`    ${c.dim}${loc.file}:${loc.line} -> ${loc.value}${c.reset}`);
      }
    }
    if (!verbose && probWarnings.length > 5) {
      lines.push(`  ${c.dim}... and ${probWarnings.length - 5} more (use --verbose)${c.reset}`);
    }
  }

  if (verbose && result.terminologyIssues.length > 0) {
    lines.push('');
    lines.push(c.bold + 'Terminology Variations' + c.reset);
    for (const issue of result.terminologyIssues) {
      lines.push(`  ${c.blue}i${c.reset} ${issue.term}: ${issue.variants.map(v => `"${v.variant}" (${v.totalUses})`).join(', ')}`);
    }
  }

  if (verbose && result.causalIssues.length > 0) {
    lines.push('');
    lines.push(c.bold + 'Potential Missing Entity Relationships' + c.reset);
    const toShow = result.causalIssues.slice(0, 10);
    for (const issue of toShow) {
      lines.push(`  ${c.blue}i${c.reset} ${c.dim}${issue.sourceId} -> ${issue.targetId} (${issue.claimType})${c.reset}`);
    }
    if (result.causalIssues.length > 10) {
      lines.push(`  ${c.dim}... and ${result.causalIssues.length - 10} more${c.reset}`);
    }
  }

  return lines.join('\n');
}

function renderNumericDetails(
  result: NumericConsistencyDetailedResult,
  verbose: boolean,
  c: ReturnType<typeof getColors>,
): string {
  if (result.contradictions.length === 0) return '';

  const lines: string[] = [];
  lines.push('');
  lines.push(c.bold + 'Potential Numeric Contradictions' + c.reset);
  lines.push(`  ${c.dim}Note: heuristic detection — false-positive rate is high${c.reset}`);

  const toShow = verbose ? result.contradictions : result.contradictions.slice(0, 10);
  for (const contradiction of toShow) {
    lines.push(`  ${c.yellow}!${c.reset} [${contradiction.entityId}] ${contradiction.reason}`);
    lines.push(`    ${c.dim}${contradiction.claim1.pageId}: ${contradiction.claim1.sentence.substring(0, 80)}...${c.reset}`);
    lines.push(`    ${c.dim}${contradiction.claim2.pageId}: ${contradiction.claim2.sentence.substring(0, 80)}...${c.reset}`);
  }
  if (!verbose && result.contradictions.length > 10) {
    lines.push(`  ${c.dim}... and ${result.contradictions.length - 10} more (use --verbose)${c.reset}`);
  }

  return lines.join('\n');
}

// ── CI JSON output ──────────────────────────────────────────────────

interface CiOutput {
  passed: boolean;
  checksRun: CheckType[];
  summary: {
    errors: number;
    warnings: number;
    infos: number;
  };
  byCategory: Record<string, CheckCategoryCounts>;
  crossEntity?: {
    stats: CrossEntityCheckResult['stats'];
    mismatches: Mismatch[];
  };
  prose?: {
    stats: ProseConsistencyResult['stats'];
    probabilityIssues: number;
    terminologyIssues: number;
    causalIssues: number;
  };
  numeric?: {
    stats: NumericConsistencyDetailedResult['stats'];
    contradictions: number;
  };
}

// ── Main command ────────────────────────────────────────────────────

async function verifyConsistencyCommand(
  args: string[],
  options: VerifyConsistencyOptions,
): Promise<CommandResult> {
  const ci = !!options.ci;
  const verbose = !!options.verbose;
  const c = getColors(ci);

  // Determine which check types to run
  let typesToRun: CheckType[] = [...VALID_TYPES];

  if (options.type) {
    const requestedType = options.type as string;
    if (!VALID_TYPES.includes(requestedType as CheckType)) {
      return {
        output: `${c.red}Unknown check type: ${requestedType}${c.reset}\nValid types: ${VALID_TYPES.join(', ')}`,
        exitCode: 1,
      };
    }
    typesToRun = [requestedType as CheckType];
  }

  // Run selected checks
  let crossEntityResult: CrossEntityCheckResult | null = null;
  let proseResult: ProseConsistencyResult | null = null;
  let numericResult: NumericConsistencyDetailedResult | null = null;

  const allRows: SummaryRow[] = [];

  if (typesToRun.includes('cross-entity')) {
    try {
      crossEntityResult = runCrossEntityCheck();
      allRows.push(...processCrossEntityMismatches(crossEntityResult.mismatches));
    } catch (err) {
      return {
        output: `${c.red}Cross-entity check failed: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
        exitCode: 1,
      };
    }
  }

  if (typesToRun.includes('prose')) {
    try {
      proseResult = runDetailedCheck();
      allRows.push(...processProseResult(proseResult));
    } catch (err) {
      return {
        output: `${c.red}Prose consistency check failed: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
        exitCode: 1,
      };
    }
  }

  if (typesToRun.includes('numeric')) {
    try {
      numericResult = await runNumericConsistencyDetailed();
      allRows.push(...processNumericResult(numericResult));
    } catch (err) {
      return {
        output: `${c.red}Numeric consistency check failed: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
        exitCode: 1,
      };
    }
  }

  // Compute totals
  const totalErrors = allRows.reduce((sum, r) => sum + r.counts.errors, 0);
  const totalWarnings = allRows.reduce((sum, r) => sum + r.counts.warnings, 0);
  const totalInfos = allRows.reduce((sum, r) => sum + r.counts.infos, 0);

  // Determine pass/fail: warnings and errors cause non-zero exit
  // Numeric contradictions are advisory (high false-positive rate), so excluded from exit code
  const nonAdvisoryWarnings = totalWarnings - (numericResult?.contradictions.length ?? 0);
  const passed = totalErrors === 0 && nonAdvisoryWarnings <= 0;

  // ── CI JSON output ──────────────────────────────────────────────
  if (ci) {
    const ciOutput: CiOutput = {
      passed,
      checksRun: typesToRun,
      summary: {
        errors: totalErrors,
        warnings: totalWarnings,
        infos: totalInfos,
      },
      byCategory: Object.fromEntries(allRows.map(r => [r.label, r.counts])),
    };

    if (crossEntityResult) {
      ciOutput.crossEntity = {
        stats: crossEntityResult.stats,
        mismatches: crossEntityResult.mismatches,
      };
    }

    if (proseResult) {
      ciOutput.prose = {
        stats: proseResult.stats,
        probabilityIssues: proseResult.probabilityIssues.length,
        terminologyIssues: proseResult.terminologyIssues.length,
        causalIssues: proseResult.causalIssues.length,
      };
    }

    if (numericResult) {
      ciOutput.numeric = {
        stats: numericResult.stats,
        contradictions: numericResult.contradictions.length,
      };
    }

    return {
      output: JSON.stringify(ciOutput, null, 2),
      exitCode: passed ? 0 : 1,
    };
  }

  // ── Human-readable output ───────────────────────────────────────
  const outputParts: string[] = [];

  outputParts.push('');
  outputParts.push(c.bold + c.blue + 'Cross-Data Consistency Report' + c.reset);
  outputParts.push('');

  // Stats line
  const statParts: string[] = [];
  if (crossEntityResult) {
    const s = crossEntityResult.stats;
    statParts.push(`${s.totalEntities} entities (${s.people} people, ${s.models} models, ${s.projects} projects)`);
  }
  if (proseResult) {
    statParts.push(`${proseResult.stats.filesScanned} MDX files, ${proseResult.stats.probabilityClaims} probability claims`);
  }
  if (numericResult) {
    statParts.push(`${numericResult.stats.entitiesWithClaims} entities with numeric claims`);
  }
  if (statParts.length > 0) {
    outputParts.push(c.dim + 'Scanned: ' + statParts.join(' | ') + c.reset);
    outputParts.push('');
  }

  // Summary table
  outputParts.push(renderSummaryTable(allRows, c));

  // Detailed output
  if (crossEntityResult) {
    const details = renderCrossEntityDetails(crossEntityResult.mismatches, verbose, c);
    if (details) outputParts.push(details);
  }

  if (proseResult) {
    const details = renderProseDetails(proseResult, verbose, c);
    if (details) outputParts.push(details);
  }

  if (numericResult) {
    const details = renderNumericDetails(numericResult, verbose, c);
    if (details) outputParts.push(details);
  }

  // Final summary
  outputParts.push('');
  outputParts.push('-'.repeat(52));

  if (totalErrors === 0 && totalWarnings === 0 && totalInfos === 0) {
    outputParts.push(c.green + 'No consistency issues found.' + c.reset);
  } else {
    const parts: string[] = [];
    if (totalErrors > 0) parts.push(c.red + totalErrors + ' error(s)' + c.reset);
    if (totalWarnings > 0) parts.push(c.yellow + totalWarnings + ' warning(s)' + c.reset);
    if (totalInfos > 0) parts.push(c.blue + totalInfos + ' info(s)' + c.reset);
    outputParts.push(`Found: ${parts.join(', ')}`);

    if (!verbose && totalInfos > 0) {
      outputParts.push(c.dim + 'Use --verbose to see info-level items' + c.reset);
    }
  }

  outputParts.push('');

  return {
    output: outputParts.join('\n'),
    exitCode: passed ? 0 : 1,
  };
}

// ── Exports ─────────────────────────────────────────────────────────

export const commands = {
  default: verifyConsistencyCommand,
};

export function getHelp(): string {
  return `
Unified Consistency Check — run all consistency checks with a combined report

Usage:
  crux w verify-consistency                     Run all consistency checks
  crux w verify-consistency --type=cross-entity Just cross-entity checks
  crux w verify-consistency --type=prose        Just prose/terminology consistency
  crux w verify-consistency --type=numeric      Just numeric consistency
  crux w verify-consistency --ci                JSON output for CI
  crux w verify-consistency --verbose           Show all issues including info-level

Check Types:
  cross-entity   Bidirectional relationships (person<->org, model<->org, etc.)
  prose          Probability estimates, terminology, causal claims across pages
  numeric        Contradictory numeric claims about the same entity

Options:
  --type=TYPE    Run only one check type (cross-entity, prose, numeric)
  --ci           JSON output
  --verbose      Show info-level items (not just warnings/errors)

Exit Codes:
  0 = No actionable issues (info items and advisory numeric contradictions don't block)
  1 = Warnings or errors found
`;
}
