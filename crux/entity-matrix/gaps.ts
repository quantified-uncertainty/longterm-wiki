#!/usr/bin/env node
/**
 * Entity Completeness Matrix — Gap Analysis
 *
 * Identifies the highest-priority missing infrastructure cells
 * and ranks them by impact (dimension importance × entity importance).
 *
 * Usage:
 *   pnpm crux matrix gaps              # Top 20 gaps
 *   pnpm crux matrix gaps --top=10     # Top 10 gaps
 *   pnpm crux matrix gaps --group=api  # Only API gaps
 *   pnpm crux matrix gaps --type=organization  # Only org gaps
 *   pnpm crux matrix gaps --json       # JSON output
 */

import { parseCliArgs, parseIntOpt } from "../lib/cli.ts";
import { scanMatrix } from "./scanner.ts";
import { DIMENSIONS, DIMENSION_GROUPS } from "./config.ts";

const args = parseCliArgs(process.argv.slice(2));
const jsonOutput = args.json === true;
const topN = parseIntOpt(args.top, 20);
const filterGroup = args.group as string | undefined;
const filterType = args.type as string | undefined;

// ============================================================================
// SCAN
// ============================================================================

console.error("Scanning for gaps...");
const snapshot = scanMatrix();

// ============================================================================
// FIND GAPS
// ============================================================================

interface Gap {
  entityType: string;
  entityLabel: string;
  tier: string;
  dimensionId: string;
  dimensionLabel: string;
  group: string;
  groupLabel: string;
  score: number;
  raw: unknown;
  details: string;
  importance: number;
  /** Impact = dimension importance × (100 - score). Higher = more impactful to fix. */
  impact: number;
}

const dimMap = new Map(DIMENSIONS.map((d) => [d.id, d]));
const groupMap = new Map(DIMENSION_GROUPS.map((g) => [g.id, g]));

const gaps: Gap[] = [];

for (const row of snapshot.rows) {
  if (filterType && row.entityType !== filterType) continue;

  for (const [dimId, cellVal] of Object.entries(row.cells)) {
    // Skip N/A cells
    if (cellVal.score < 0) continue;
    // Only include cells that aren't fully complete
    if (cellVal.score >= 80) continue;

    const dim = dimMap.get(dimId);
    if (!dim) continue;
    if (filterGroup && dim.group !== filterGroup) continue;

    const group = groupMap.get(dim.group);
    const impact = dim.importance * (100 - cellVal.score);

    gaps.push({
      entityType: row.entityType,
      entityLabel: row.label,
      tier: row.tier,
      dimensionId: dimId,
      dimensionLabel: dim.label,
      group: dim.group,
      groupLabel: group?.label ?? dim.group,
      score: cellVal.score,
      raw: cellVal.raw,
      details: cellVal.details ?? "",
      importance: dim.importance,
      impact,
    });
  }
}

// Sort by impact (highest first)
gaps.sort((a, b) => b.impact - a.impact);
const topGaps = gaps.slice(0, topN);

// ============================================================================
// OUTPUT
// ============================================================================

if (jsonOutput) {
  console.log(JSON.stringify({ total: gaps.length, gaps: topGaps }, null, 2));
  process.exit(0);
}

const C = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

console.log(`\n${C.bold}Top ${topGaps.length} Gaps${C.reset} (of ${gaps.length} total)\n`);

for (let i = 0; i < topGaps.length; i++) {
  const gap = topGaps[i];
  const rank = `${i + 1}.`.padStart(3);

  const scoreColor =
    gap.score === 0 ? C.red : gap.score < 40 ? C.red : C.yellow;
  const tierBadge =
    gap.tier === "sub-entity" ? `${C.dim} [sub]${C.reset}` : "";

  console.log(
    `${C.dim}${rank}${C.reset} ${C.bold}${gap.entityLabel}${C.reset}${tierBadge} → ${gap.dimensionLabel} ${C.dim}(${gap.groupLabel})${C.reset}`,
  );
  console.log(
    `     ${scoreColor}Score: ${gap.score}%${C.reset}  ${C.dim}Impact: ${gap.impact}  Importance: ${gap.importance}/10${C.reset}`,
  );
  if (gap.details) {
    console.log(`     ${C.dim}${gap.details}${C.reset}`);
  }
  console.log();
}

// Summary by group
console.log(`${C.bold}Gaps by Group:${C.reset}`);
const groupCounts: Record<string, number> = {};
for (const gap of gaps) {
  groupCounts[gap.groupLabel] = (groupCounts[gap.groupLabel] ?? 0) + 1;
}
for (const [label, count] of Object.entries(groupCounts).sort(
  (a, b) => b[1] - a[1],
)) {
  console.log(`  ${label.padEnd(25)} ${count} gaps`);
}
