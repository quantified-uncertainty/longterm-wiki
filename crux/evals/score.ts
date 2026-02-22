/**
 * Eval Scoring
 *
 * Matches detector findings against injected errors to compute recall,
 * precision, and F1 scores. Uses fuzzy matching (paragraph proximity +
 * text overlap) since detectors won't quote errors verbatim.
 */

import type {
  InjectedError,
  DetectorFinding,
  ErrorMatch,
  EvalScores,
  ErrorCategory,
  DetectorName,
} from './types.ts';

// ---------------------------------------------------------------------------
// Fuzzy matching
// ---------------------------------------------------------------------------

/** Maximum paragraph distance for a finding to match an injected error. */
const PARAGRAPH_PROXIMITY_THRESHOLD = 3;

/** Minimum text overlap (Jaccard similarity) for a text-based match. */
const TEXT_OVERLAP_THRESHOLD = 0.15;

/**
 * Compute Jaccard similarity between two strings (word-level).
 */
function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);

  return intersection.size / union.size;
}

/**
 * Check if a detector finding matches an injected error.
 *
 * Matching criteria (any of):
 * 1. Paragraph proximity: finding is within ±PARAGRAPH_PROXIMITY_THRESHOLD paragraphs
 * 2. Text overlap: finding's flagged text has sufficient Jaccard similarity
 *    to the error's corrupted text
 * 3. Section match: finding mentions the same section heading
 */
function findingMatchesError(finding: DetectorFinding, error: InjectedError): boolean {
  // Paragraph proximity check
  if (
    finding.paragraphIndex != null &&
    error.paragraphIndex >= 0 &&
    Math.abs(finding.paragraphIndex - error.paragraphIndex) <= PARAGRAPH_PROXIMITY_THRESHOLD
  ) {
    return true;
  }

  // Text overlap check
  if (finding.flaggedText && error.corruptedText) {
    const similarity = jaccardSimilarity(finding.flaggedText, error.corruptedText);
    if (similarity >= TEXT_OVERLAP_THRESHOLD) return true;
  }

  // Also check against original text (detector might flag the area even though
  // it doesn't know the original — its description might overlap)
  if (finding.description && error.originalText) {
    const similarity = jaccardSimilarity(finding.description, error.originalText);
    if (similarity >= TEXT_OVERLAP_THRESHOLD) return true;
  }

  if (finding.description && error.corruptedText) {
    const similarity = jaccardSimilarity(finding.description, error.corruptedText);
    if (similarity >= TEXT_OVERLAP_THRESHOLD) return true;
  }

  // Section heading match (weak signal, only if both have section info)
  if (
    finding.sectionHeading &&
    error.sectionHeading &&
    finding.sectionHeading.toLowerCase() === error.sectionHeading.toLowerCase()
  ) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Match all findings against all injected errors.
 */
export function matchFindings(
  errors: InjectedError[],
  findings: DetectorFinding[],
): { matches: ErrorMatch[]; truePositiveFindings: Set<number>; falsePositiveFindings: number[] } {
  const matches: ErrorMatch[] = [];
  const truePositiveFindings = new Set<number>();

  for (const error of errors) {
    const matchingFindings: DetectorFinding[] = [];
    const caughtBy = new Set<DetectorName>();

    for (let fi = 0; fi < findings.length; fi++) {
      if (findingMatchesError(findings[fi], error)) {
        matchingFindings.push(findings[fi]);
        caughtBy.add(findings[fi].detector);
        truePositiveFindings.add(fi);
      }
    }

    matches.push({
      error,
      caught: matchingFindings.length > 0,
      caughtBy: [...caughtBy],
      matchingFindings,
    });
  }

  // False positives: findings that don't match any error
  const falsePositiveFindings: number[] = [];
  for (let fi = 0; fi < findings.length; fi++) {
    if (!truePositiveFindings.has(fi)) {
      falsePositiveFindings.push(fi);
    }
  }

  return { matches, truePositiveFindings, falsePositiveFindings };
}

/**
 * Compute aggregate eval scores from matches.
 */
export function computeScores(
  matches: ErrorMatch[],
  allFindings: DetectorFinding[],
  truePositiveCount: number,
): EvalScores {
  const totalErrors = matches.length;
  const errorsCaught = matches.filter(m => m.caught).length;
  const recall = totalErrors > 0 ? errorsCaught / totalErrors : 0;

  const totalFindings = allFindings.length;
  const truePositives = truePositiveCount;
  const falsePositives = totalFindings - truePositives;
  const precision = totalFindings > 0 ? truePositives / totalFindings : 1;

  const f1 = precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : 0;

  // Breakdown by category
  const byCategory: Record<string, { total: number; caught: number; recall: number }> = {};
  for (const match of matches) {
    const cat = match.error.category;
    if (!byCategory[cat]) byCategory[cat] = { total: 0, caught: 0, recall: 0 };
    byCategory[cat].total++;
    if (match.caught) byCategory[cat].caught++;
  }
  for (const cat of Object.keys(byCategory)) {
    byCategory[cat].recall = byCategory[cat].total > 0
      ? byCategory[cat].caught / byCategory[cat].total
      : 0;
  }

  // Breakdown by detector
  const byDetector: Record<string, { findings: number; truePositives: number; precision: number }> = {};
  for (const finding of allFindings) {
    const det = finding.detector;
    if (!byDetector[det]) byDetector[det] = { findings: 0, truePositives: 0, precision: 0 };
    byDetector[det].findings++;
  }
  // Count true positives per detector
  for (const match of matches) {
    if (match.caught) {
      for (const det of match.caughtBy) {
        if (byDetector[det]) byDetector[det].truePositives++;
      }
    }
  }
  for (const det of Object.keys(byDetector)) {
    byDetector[det].precision = byDetector[det].findings > 0
      ? byDetector[det].truePositives / byDetector[det].findings
      : 0;
  }

  return {
    totalErrors,
    errorsCaught,
    recall,
    totalFindings,
    truePositives,
    falsePositives,
    precision,
    f1,
    byCategory: byCategory as EvalScores['byCategory'],
    byDetector: byDetector as EvalScores['byDetector'],
  };
}

/**
 * Format eval scores as a readable report.
 */
export function formatScoreReport(scores: EvalScores, pageId?: string): string {
  const lines: string[] = [];

  if (pageId) lines.push(`## Eval Report: ${pageId}`);
  lines.push('');
  lines.push('### Overall Scores');
  lines.push(`- **Recall**: ${(scores.recall * 100).toFixed(1)}% (${scores.errorsCaught}/${scores.totalErrors} errors caught)`);
  lines.push(`- **Precision**: ${(scores.precision * 100).toFixed(1)}% (${scores.truePositives}/${scores.totalFindings} findings were true positives)`);
  lines.push(`- **F1 Score**: ${(scores.f1 * 100).toFixed(1)}%`);
  lines.push('');

  lines.push('### By Error Category');
  lines.push('| Category | Total | Caught | Recall |');
  lines.push('|---|---|---|---|');
  for (const [cat, data] of Object.entries(scores.byCategory)) {
    lines.push(`| ${cat} | ${data.total} | ${data.caught} | ${(data.recall * 100).toFixed(0)}% |`);
  }
  lines.push('');

  lines.push('### By Detector');
  lines.push('| Detector | Findings | True Positives | Precision |');
  lines.push('|---|---|---|---|');
  for (const [det, data] of Object.entries(scores.byDetector)) {
    lines.push(`| ${det} | ${data.findings} | ${data.truePositives} | ${(data.precision * 100).toFixed(0)}% |`);
  }

  return lines.join('\n');
}
