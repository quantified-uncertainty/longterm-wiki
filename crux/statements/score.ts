/**
 * Statement Scoring CLI — scores all statements for an entity.
 *
 * Fetches statements + properties, runs 10-dimension quality scoring locally,
 * and stores results via wiki-server batch update.
 *
 * Usage:
 *   pnpm crux statements score <entity-id>
 *   pnpm crux statements score <entity-id> --json
 *   pnpm crux statements score <entity-id> --dry-run
 */

import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import {
  getStatementsByEntity,
  getProperties,
  batchUpdateScores,
  storeCoverageScore,
  type BatchScoreInput,
} from '../lib/wiki-server/statements.ts';
import { slugToDisplayName } from '../lib/claim-text-utils.ts';
import {
  scoreAllStatements,
  type ScoringStatement,
  type ScoringResult,
} from './scoring.ts';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const jsonOutput = args.json === true;
  const dryRun = args['dry-run'] === true;
  const c = getColors(false);
  const positional = (args._positional as string[]) || [];
  const entityId = positional[0];

  if (!entityId) {
    console.error(`${c.red}Error: provide an entity ID${c.reset}`);
    console.error(`  Usage: pnpm crux statements score <entity-id> [--json] [--dry-run]`);
    process.exit(1);
  }

  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.error(`${c.red}Wiki server not available.${c.reset}`);
    process.exit(1);
  }

  // Fetch data in parallel
  const [stmtResult, propResult] = await Promise.all([
    getStatementsByEntity(entityId),
    getProperties(),
  ]);

  if (!stmtResult.ok) {
    console.error(`${c.red}Could not fetch statements for ${entityId}.${c.reset}`);
    process.exit(1);
  }

  if (!propResult.ok) {
    console.error(`${c.red}Could not fetch properties.${c.reset}`);
    process.exit(1);
  }

  const allStatements = [
    ...stmtResult.data.structured,
    ...stmtResult.data.attributed,
  ];

  if (allStatements.length === 0) {
    if (jsonOutput) {
      console.log(JSON.stringify({ entityId, total: 0, message: 'No statements found' }));
    } else {
      console.log(`${c.yellow}No statements found for ${entityId}.${c.reset}`);
    }
    process.exit(0);
  }

  // Build property map for enriching statements with property metadata
  const propertyMap = new Map(
    propResult.data.properties.map((p) => [p.id, p]),
  );

  // Convert to ScoringStatement format
  const scoringStmts: ScoringStatement[] = allStatements.map((stmt) => {
    const prop = stmt.propertyId ? propertyMap.get(stmt.propertyId) : null;
    return {
      id: stmt.id,
      variety: stmt.variety,
      statementText: stmt.statementText,
      subjectEntityId: stmt.subjectEntityId,
      propertyId: stmt.propertyId,
      valueNumeric: stmt.valueNumeric,
      valueUnit: stmt.valueUnit,
      valueText: stmt.valueText,
      valueEntityId: stmt.valueEntityId,
      valueDate: stmt.valueDate,
      validStart: stmt.validStart,
      validEnd: stmt.validEnd,
      status: stmt.status,
      claimCategory: stmt.claimCategory,
      citations: stmt.citations?.map((cit) => ({
        resourceId: cit.resourceId,
        url: cit.url,
        sourceQuote: cit.sourceQuote,
      })),
      property: prop ? {
        id: prop.id,
        label: prop.label,
        category: prop.category,
        stalenessCadence: prop.stalenessCadence,
      } : null,
    };
  });

  const entityName = slugToDisplayName(entityId);
  const results = scoreAllStatements(scoringStmts, entityId, entityName);

  // Compute summary stats
  const scores = results.map((r) => r.qualityScore);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const sorted = [...scores].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  // Category-level scores
  const categoryScores = new Map<string, number[]>();
  for (let i = 0; i < results.length; i++) {
    const cat = scoringStmts[i].property?.category ?? 'uncategorized';
    const list = categoryScores.get(cat) ?? [];
    list.push(results[i].qualityScore);
    categoryScores.set(cat, list);
  }

  const categoryAvgs: Record<string, number> = {};
  for (const [cat, catScores] of categoryScores) {
    categoryAvgs[cat] = Math.round(
      (catScores.reduce((a, b) => a + b, 0) / catScores.length) * 1000,
    ) / 1000;
  }

  // Quality distribution
  const distribution = {
    excellent: results.filter((r) => r.qualityScore >= 0.8).length,
    good: results.filter((r) => r.qualityScore >= 0.6 && r.qualityScore < 0.8).length,
    fair: results.filter((r) => r.qualityScore >= 0.4 && r.qualityScore < 0.6).length,
    poor: results.filter((r) => r.qualityScore < 0.4).length,
  };

  // Top issues — dimensions with lowest average
  const dimensionAvgs: Record<string, number> = {};
  const dimensionNames = [
    'structure', 'precision', 'clarity', 'resolvability',
    'uniqueness', 'atomicity', 'importance', 'neglectedness',
    'recency', 'crossEntityUtility',
  ] as const;
  for (const dim of dimensionNames) {
    const dimScores = results.map((r) => r.dimensions[dim]);
    dimensionAvgs[dim] = dimScores.reduce((a, b) => a + b, 0) / dimScores.length;
  }

  if (jsonOutput) {
    console.log(JSON.stringify({
      entityId,
      total: results.length,
      avg: Math.round(avg * 1000) / 1000,
      median: Math.round(median * 1000) / 1000,
      min: Math.round(min * 1000) / 1000,
      max: Math.round(max * 1000) / 1000,
      distribution,
      categoryAvgs,
      dimensionAvgs,
      results: results.map((r) => ({
        statementId: r.statementId,
        qualityScore: r.qualityScore,
        dimensions: r.dimensions,
      })),
    }, null, 2));
  } else {
    // Pretty print
    console.log(`\n${c.bold}${c.blue}Statement Quality Scores: ${entityId}${c.reset}\n`);

    console.log(`${c.bold}Summary:${c.reset}`);
    console.log(`  Statements scored:  ${c.bold}${results.length}${c.reset}`);
    console.log(`  Average score:      ${colorScore(avg, c)}`);
    console.log(`  Median:             ${colorScore(median, c)}`);
    console.log(`  Range:              ${min.toFixed(3)} — ${max.toFixed(3)}`);
    console.log('');

    console.log(`${c.bold}Distribution:${c.reset}`);
    console.log(`  Excellent (≥0.8):   ${c.green}${distribution.excellent}${c.reset}`);
    console.log(`  Good (0.6–0.8):     ${c.green}${distribution.good}${c.reset}`);
    console.log(`  Fair (0.4–0.6):     ${c.yellow}${distribution.fair}${c.reset}`);
    console.log(`  Poor (<0.4):        ${c.red}${distribution.poor}${c.reset}`);
    console.log('');

    console.log(`${c.bold}By category:${c.reset}`);
    for (const [cat, avg] of Object.entries(categoryAvgs).sort((a, b) => b[1] - a[1])) {
      const cnt = categoryScores.get(cat)?.length ?? 0;
      console.log(`  ${cat.padEnd(20)} ${colorScore(avg, c)}  (${cnt} stmts)`);
    }
    console.log('');

    console.log(`${c.bold}Dimension averages:${c.reset}`);
    const sortedDims = Object.entries(dimensionAvgs).sort((a, b) => a[1] - b[1]);
    for (const [dim, avg] of sortedDims) {
      console.log(`  ${dim.padEnd(22)} ${colorScore(avg, c)}`);
    }

    // Lowest-scoring statements
    const bottomN = results
      .sort((a, b) => a.qualityScore - b.qualityScore)
      .slice(0, 5);
    console.log(`\n${c.bold}Lowest-scoring statements:${c.reset}`);
    for (const r of bottomN) {
      const stmt = scoringStmts.find((s) => s.id === r.statementId);
      const text = (stmt?.statementText ?? '').slice(0, 60);
      console.log(`  [${r.qualityScore.toFixed(3)}] #${r.statementId}: ${text}...`);
    }
    console.log('');
  }

  // Store scores (unless dry-run)
  if (!dryRun) {
    const scoreInputs: BatchScoreInput[] = results.map((r) => ({
      statementId: r.statementId,
      qualityScore: r.qualityScore,
      qualityDimensions: r.dimensions as unknown as Record<string, number>,
    }));

    // Batch in chunks of 100
    const CHUNK_SIZE = 100;
    let totalUpdated = 0;
    for (let i = 0; i < scoreInputs.length; i += CHUNK_SIZE) {
      const chunk = scoreInputs.slice(i, i + CHUNK_SIZE);
      const updateResult = await batchUpdateScores(chunk);
      if (updateResult.ok) {
        totalUpdated += updateResult.data.updated;
      } else {
        console.error(`${c.red}Failed to store scores for batch ${i / CHUNK_SIZE + 1}.${c.reset}`);
      }
    }

    // Store entity coverage score
    const coverageResult = await storeCoverageScore({
      entityId,
      coverageScore: avg,
      categoryScores: categoryAvgs,
      statementCount: results.length,
      qualityAvg: Math.round(avg * 1000) / 1000,
    });

    if (!jsonOutput) {
      if (coverageResult.ok) {
        console.log(`${c.green}Stored ${totalUpdated} statement scores + entity coverage score.${c.reset}`);
      } else {
        console.log(`${c.yellow}Stored ${totalUpdated} statement scores (coverage score failed).${c.reset}`);
      }
    }
  } else if (!jsonOutput) {
    console.log(`${c.dim}Dry run — scores not stored.${c.reset}`);
  }
}

function colorScore(score: number, c: ReturnType<typeof getColors>): string {
  const formatted = score.toFixed(3);
  if (score >= 0.7) return `${c.green}${formatted}${c.reset}`;
  if (score >= 0.4) return `${c.yellow}${formatted}${c.reset}`;
  return `${c.red}${formatted}${c.reset}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Statement scoring failed:', err);
    process.exit(1);
  });
}
