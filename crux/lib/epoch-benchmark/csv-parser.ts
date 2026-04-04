/**
 * Epoch AI Benchmark CSV Parser
 *
 * Parses Epoch's benchmark CSVs which have varying score column names
 * and may contain multiline fields (notes with embedded newlines).
 *
 * Uses the existing parseCSVLine/reassembleCSVRows utilities from
 * the grant-import pipeline.
 */

import { parseCSVLine, reassembleCSVRows } from "../grant-import/csv.ts";
import type { EpochBenchmarkRow } from "./types.ts";

/**
 * Score column names used across different Epoch benchmark CSVs.
 * The parser tries each in order and uses the first match.
 *
 * Epoch-run benchmarks use "mean_score". External benchmarks use
 * various names like "Score", "EM", "Accuracy", "Average", etc.
 */
const SCORE_COLUMN_NAMES = [
  "mean_score",
  "Score",
  "EM",
  "Accuracy",
  "Average",
  "Overall accuracy",
  "Global average",
  "Percent correct",
  "% Resolved",
  "% Score",
  "Average score",
  "Arena Score",
  "Win Rate (%)",
  "Score (AVG@5)",
  "Challenge score",
  "Average progress",
  "Unguided % Solved",
  "Overall (no subtitles)",
  "Pass@1 score",
  "Overall pass (%)",
  "Mean score",
  "120k token score",
  "Correct",
  "ECI Score",
  "Average (%)",
  "Score OPT@1",
  "Accuracy mean",
  "Time horizon",
  "ACW Avg Score",
];

/**
 * Parse a single Epoch benchmark CSV string into rows.
 *
 * Handles multiline fields, varying score column names, and filters
 * out rows with missing or non-numeric scores.
 */
export function parseEpochBenchmarkCsv(csvText: string): EpochBenchmarkRow[] {
  const lines = csvText.split("\n");
  if (lines.length < 2) return [];

  // Parse header
  const headerLine = lines[0];
  const headers = parseCSVLine(headerLine).map((h) => h.trim());

  // Find the model version column (always first)
  const modelVersionIdx = headers.findIndex(
    (h) => h.toLowerCase() === "model version",
  );
  if (modelVersionIdx === -1) return [];

  // Find the score column
  const scoreIdx = findScoreColumnIndex(headers);
  if (scoreIdx === -1) return [];

  // Find optional columns
  const releaseDateIdx = headers.findIndex(
    (h) => h.toLowerCase() === "release date",
  );
  const orgIdx = headers.findIndex(
    (h) => h.toLowerCase() === "organization",
  );

  // Reassemble multiline rows (skips header line internally)
  const dataRows = reassembleCSVRows(csvText);

  const results: EpochBenchmarkRow[] = [];

  for (const row of dataRows) {
    const fields = parseCSVLine(row);
    const modelVersion = fields[modelVersionIdx]?.trim();
    const scoreStr = fields[scoreIdx]?.trim();

    if (!modelVersion || !scoreStr) continue;

    const score = parseFloat(scoreStr);
    if (isNaN(score)) continue;

    // Skip rows where the model version looks like a URL or note (data quality issue)
    if (
      modelVersion.startsWith("http") ||
      modelVersion.startsWith("(") ||
      modelVersion.length > 200
    ) {
      continue;
    }

    const releaseDate =
      releaseDateIdx >= 0 ? fields[releaseDateIdx]?.trim() || null : null;
    const organization =
      orgIdx >= 0 ? fields[orgIdx]?.trim() || null : null;

    results.push({
      modelVersion,
      score,
      releaseDate,
      organization,
    });
  }

  return results;
}

/**
 * Find the index of the score column in the header.
 * Tries known column names in priority order.
 */
function findScoreColumnIndex(headers: string[]): number {
  for (const name of SCORE_COLUMN_NAMES) {
    const idx = headers.findIndex(
      (h) => h.toLowerCase() === name.toLowerCase(),
    );
    if (idx !== -1) return idx;
  }

  // Fallback: column index 1 (second column) is the score in most Epoch CSVs
  if (headers.length > 1) return 1;

  return -1;
}
