/**
 * Coverage Gap Analysis CLI — shows which property categories need more statements.
 *
 * Usage:
 *   pnpm crux statements gaps <entity-id>
 *   pnpm crux statements gaps <entity-id> --org-type=frontier-lab
 *   pnpm crux statements gaps <entity-id> --json
 */

import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { getStatementsByEntity, getProperties } from '../lib/wiki-server/statements.ts';
import { getEntity } from '../lib/wiki-server/entities.ts';
import {
  resolveCoverageTargets,
  computeCoverageScore,
  computeGaps,
  type CategoryGap,
} from './coverage-targets.ts';

// ---------------------------------------------------------------------------
// Reusable gap analysis (imported by improve.ts)
// ---------------------------------------------------------------------------

export interface GapAnalysis {
  entityType: string;
  totalStatements: number;
  coverageScore: number;
  gaps: CategoryGap[];
  categoryCounts: Record<string, number>;
  allStatements: Array<{
    id: number;
    variety: string;
    statementText: string | null;
    subjectEntityId: string;
    propertyId: string | null;
    [key: string]: unknown;
  }>;
  propertyMap: Map<string, { category: string }>;
}

/**
 * Fetch entity data and compute coverage gaps.
 * Throws if the server is unreachable or statements can't be fetched.
 */
export async function analyzeGaps(entityId: string, orgType?: string | null): Promise<GapAnalysis> {
  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    throw new Error('Wiki server not available');
  }

  const [entityResult, stmtResult, propResult] = await Promise.all([
    getEntity(entityId),
    getStatementsByEntity(entityId),
    getProperties(),
  ]);

  let entityType = 'organization';
  if (entityResult.ok && entityResult.data.entityType) {
    entityType = entityResult.data.entityType;
  }

  const targets = resolveCoverageTargets(entityType, orgType);
  if (!targets) {
    throw new Error(`No coverage targets defined for entity type "${entityType}"`);
  }

  if (!stmtResult.ok) {
    throw new Error(`Could not fetch statements for ${entityId}`);
  }

  const propertyMap = new Map<string, { category: string }>();
  if (propResult.ok) {
    for (const p of propResult.data.properties) {
      propertyMap.set(p.id, { category: p.category });
    }
  }

  const allStatements = [
    ...stmtResult.data.structured,
    ...stmtResult.data.attributed,
  ];

  const categoryCounts: Record<string, number> = {};
  for (const stmt of allStatements) {
    const prop = stmt.propertyId ? propertyMap.get(stmt.propertyId) : null;
    const category = prop?.category ?? 'uncategorized';
    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
  }

  const coverageScore = computeCoverageScore(categoryCounts, targets);
  const gaps = computeGaps(categoryCounts, targets);

  return {
    entityType,
    totalStatements: allStatements.length,
    coverageScore,
    gaps,
    categoryCounts,
    allStatements,
    propertyMap,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const jsonOutput = args.json === true;
  const orgType = (args['org-type'] as string) ?? null;
  const c = getColors(false);
  const positional = (args._positional as string[]) || [];
  const entityId = positional[0];

  if (!entityId) {
    console.error(`${c.red}Error: provide an entity ID${c.reset}`);
    console.error(`  Usage: pnpm crux statements gaps <entity-id> [--org-type=TYPE] [--json]`);
    process.exit(1);
  }

  let analysis: GapAnalysis;
  try {
    analysis = await analyzeGaps(entityId, orgType);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonOutput) {
      console.log(JSON.stringify({ entityId, orgType, error: msg }));
    } else {
      console.error(`${c.red}${msg}${c.reset}`);
    }
    process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify({
      entityId,
      entityType: analysis.entityType,
      orgType,
      totalStatements: analysis.totalStatements,
      coverageScore: analysis.coverageScore,
      gaps: analysis.gaps,
    }, null, 2));
  } else {
    printGaps(entityId, analysis.entityType, orgType, analysis.totalStatements, analysis.coverageScore, analysis.gaps, c);
  }
}

// ---------------------------------------------------------------------------
// Pretty printing
// ---------------------------------------------------------------------------

function printGaps(
  entityId: string,
  entityType: string,
  orgType: string | null,
  totalStatements: number,
  coverageScore: number,
  gaps: CategoryGap[],
  c: ReturnType<typeof getColors>,
) {
  const typeLabel = orgType ? `${entityType}:${orgType}` : entityType;

  console.log(`\n${c.bold}${c.blue}Coverage Gap Analysis: ${entityId}${c.reset}`);
  console.log(`  Entity type:    ${typeLabel}`);
  console.log(`  Statements:     ${totalStatements}`);
  console.log(`  Coverage score: ${colorScore(coverageScore, c)}\n`);

  console.log(`${c.bold}Gaps by priority:${c.reset}\n`);

  const maxCatLen = Math.max(...gaps.map(g => g.category.length), 10);

  for (const gap of gaps) {
    const bar = makeBar(gap.fillRate, 20);
    const pct = (gap.fillRate * 100).toFixed(0).padStart(3);
    const defStr = gap.deficit > 0
      ? `${c.red}-${gap.deficit}${c.reset}`
      : `${c.green}OK${c.reset}`;

    console.log(
      `  ${gap.category.padEnd(maxCatLen)}  ${bar}  ${pct}%  ` +
      `(${gap.actual}/${gap.target})  ${defStr}`,
    );
  }

  // Summary
  const totalDeficit = gaps.reduce((sum, g) => sum + g.deficit, 0);
  if (totalDeficit > 0) {
    console.log(`\n  ${c.yellow}Total deficit: ${totalDeficit} statements needed${c.reset}`);
  } else {
    console.log(`\n  ${c.green}All categories at or above target!${c.reset}`);
  }
  console.log('');
}

function makeBar(fillRate: number, width: number): string {
  const filled = Math.round(fillRate * width);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}

function colorScore(score: number, c: ReturnType<typeof getColors>): string {
  const formatted = score.toFixed(3);
  if (score >= 0.7) return `${c.green}${formatted}${c.reset}`;
  if (score >= 0.4) return `${c.yellow}${formatted}${c.reset}`;
  return `${c.red}${formatted}${c.reset}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Coverage gap analysis failed:', err);
    process.exit(1);
  });
}
