#!/usr/bin/env node
/**
 * Entity Completeness Matrix — CLI Scanner
 *
 * Usage:
 *   pnpm crux matrix scan           # Full scan, table output
 *   pnpm crux matrix scan --json    # Full scan, JSON output
 *   pnpm crux matrix scan --brief   # Summary only
 */

import { parseCliArgs } from "../lib/cli.ts";
import { scanMatrix } from "./scanner.ts";
import { DIMENSION_GROUPS } from "./config.ts";
import type { MatrixSnapshot, EntityTypeRow } from "./types.ts";

const args = parseCliArgs(process.argv.slice(2));
const jsonOutput = args.json === true;
const brief = args.brief === true;

// ============================================================================
// RUN SCAN
// ============================================================================

console.error("Scanning entity completeness matrix...");
const snapshot = scanMatrix();
console.error(
  `Scanned ${snapshot.rows.length} entity types × ${snapshot.dimensions.length} dimensions\n`,
);

// ============================================================================
// JSON OUTPUT
// ============================================================================

if (jsonOutput) {
  console.log(JSON.stringify(snapshot, null, 2));
  process.exit(0);
}

// ============================================================================
// FORMATTED OUTPUT
// ============================================================================

const SCORE_COLORS = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};

function colorScore(score: number): string {
  if (score < 0) return `${SCORE_COLORS.gray}N/A${SCORE_COLORS.reset}`;
  if (score >= 80) return `${SCORE_COLORS.green}${score}%${SCORE_COLORS.reset}`;
  if (score >= 40) return `${SCORE_COLORS.yellow}${score}%${SCORE_COLORS.reset}`;
  return `${SCORE_COLORS.red}${score}%${SCORE_COLORS.reset}`;
}

function scoreBar(score: number, width: number = 20): string {
  if (score < 0) return SCORE_COLORS.gray + "░".repeat(width) + SCORE_COLORS.reset;
  const filled = Math.round((score / 100) * width);
  const empty = width - filled;
  const color = score >= 80 ? SCORE_COLORS.green : score >= 40 ? SCORE_COLORS.yellow : SCORE_COLORS.red;
  return color + "█".repeat(filled) + SCORE_COLORS.gray + "░".repeat(empty) + SCORE_COLORS.reset;
}

// --- Overall Summary ---
console.log(`${SCORE_COLORS.bold}Entity Completeness Matrix${SCORE_COLORS.reset}`);
console.log(`Generated: ${snapshot.generatedAt}`);
console.log(`Overall: ${colorScore(snapshot.overallScore)}`);
console.log();

// --- Group Averages ---
console.log(`${SCORE_COLORS.bold}Group Averages:${SCORE_COLORS.reset}`);
for (const group of DIMENSION_GROUPS) {
  const score = snapshot.groupAverages[group.id] ?? 0;
  console.log(`  ${group.label.padEnd(22)} ${scoreBar(score)} ${colorScore(score)}`);
}
console.log();

if (brief) {
  // Brief: just show entity type scores sorted
  console.log(`${SCORE_COLORS.bold}Entity Scores:${SCORE_COLORS.reset}`);
  const sorted = [...snapshot.rows].sort(
    (a, b) => b.aggregateScore - a.aggregateScore,
  );
  for (const row of sorted) {
    const tierBadge = row.tier === "sub-entity" ? SCORE_COLORS.dim + " [sub]" + SCORE_COLORS.reset : "";
    console.log(
      `  ${row.label.padEnd(22)} ${scoreBar(row.aggregateScore)} ${colorScore(row.aggregateScore)}${tierBadge}`,
    );
  }
  process.exit(0);
}

// --- Full Matrix ---
printEntityDetails(snapshot);

function printEntityDetails(snap: MatrixSnapshot) {
  const sorted = [...snap.rows].sort(
    (a, b) => b.aggregateScore - a.aggregateScore,
  );

  for (const row of sorted) {
    const tierBadge =
      row.tier === "sub-entity"
        ? `${SCORE_COLORS.dim} [sub-entity]${SCORE_COLORS.reset}`
        : "";
    console.log(
      `${SCORE_COLORS.bold}${row.label}${SCORE_COLORS.reset}${tierBadge}  ${scoreBar(row.aggregateScore, 15)} ${colorScore(row.aggregateScore)}`,
    );

    // Show group breakdown
    for (const group of DIMENSION_GROUPS) {
      const groupScore = row.groupScores[group.id];
      if (groupScore === undefined) continue;

      console.log(
        `  ${SCORE_COLORS.dim}${group.shortLabel}:${SCORE_COLORS.reset} ${colorScore(groupScore)}`,
      );

      // Show individual dimensions in this group
      const groupDims = snap.dimensions.filter(
        (d) => d.group === group.id,
      );
      for (const dim of groupDims) {
        const cell = row.cells[dim.id];
        if (!cell) continue;

        const scoreStr =
          cell.score < 0
            ? `${SCORE_COLORS.gray}N/A${SCORE_COLORS.reset}`
            : cell.score >= 80
              ? `${SCORE_COLORS.green}●${SCORE_COLORS.reset}`
              : cell.score >= 40
                ? `${SCORE_COLORS.yellow}◐${SCORE_COLORS.reset}`
                : cell.score > 0
                  ? `${SCORE_COLORS.red}○${SCORE_COLORS.reset}`
                  : `${SCORE_COLORS.red}✗${SCORE_COLORS.reset}`;

        const rawStr =
          cell.raw === null
            ? ""
            : typeof cell.raw === "boolean"
              ? cell.raw
                ? "yes"
                : "no"
              : String(cell.raw);

        const detailStr = cell.details
          ? `${SCORE_COLORS.dim}${cell.details}${SCORE_COLORS.reset}`
          : "";

        console.log(
          `    ${scoreStr} ${dim.label.padEnd(20)} ${rawStr.padEnd(10)} ${detailStr}`,
        );
      }
    }
    console.log();
  }
}
