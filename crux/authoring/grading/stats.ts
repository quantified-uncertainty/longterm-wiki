/**
 * Statistics output — prints summary distributions after a grading run.
 */

import type { PageResult } from './types.ts';

/** Print importance and quality distribution summaries. */
export function printStats(results: PageResult[]): void {
  const importanceScores: number[] = results
    .map(r => r.readerImportance)
    .filter((x): x is number => x != null)
    .sort((a, b) => b - a);

  const qualityScores: number[] = results
    .map(r => r.quality)
    .filter((x): x is number => x != null)
    .sort((a, b) => b - a);

  const impRanges: Record<string, number> = {
    '90-100': importanceScores.filter(x => x >= 90).length,
    '70-89': importanceScores.filter(x => x >= 70 && x < 90).length,
    '50-69': importanceScores.filter(x => x >= 50 && x < 70).length,
    '30-49': importanceScores.filter(x => x >= 30 && x < 50).length,
    '0-29': importanceScores.filter(x => x < 30).length,
  };

  console.log('\nImportance Distribution (0-100):');
  for (const [range, count] of Object.entries(impRanges)) {
    const bar = '\u2588'.repeat(Math.ceil(count / 3));
    console.log(`  ${range}: ${bar} (${count})`);
  }

  if (importanceScores.length > 0) {
    const impAvg: number = importanceScores.reduce((a, b) => a + b, 0) / importanceScores.length;
    const impMedian: number = importanceScores[Math.floor(importanceScores.length / 2)];
    console.log(`\n  Avg: ${impAvg.toFixed(1)}, Median: ${impMedian.toFixed(1)}`);
    console.log(`  Top 5: ${importanceScores.slice(0, 5).map(x => x.toFixed(1)).join(', ')}`);
    console.log(`  Bottom 5: ${importanceScores.slice(-5).map(x => x.toFixed(1)).join(', ')}`);
  }

  if (qualityScores.length > 0) {
    const qualRanges: Record<string, number> = {
      '80-100 (Comprehensive)': qualityScores.filter(x => x >= 80).length,
      '60-79 (Good)': qualityScores.filter(x => x >= 60 && x < 80).length,
      '40-59 (Adequate)': qualityScores.filter(x => x >= 40 && x < 60).length,
      '20-39 (Draft)': qualityScores.filter(x => x >= 20 && x < 40).length,
      '0-19 (Stub)': qualityScores.filter(x => x < 20).length,
    };

    console.log('\nQuality Distribution (0-100):');
    for (const [range, count] of Object.entries(qualRanges)) {
      const bar = '\u2588'.repeat(Math.ceil(count / 3));
      console.log(`  ${range}: ${bar} (${count})`);
    }

    const qualAvg: number = qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length;
    const qualMedian: number = qualityScores[Math.floor(qualityScores.length / 2)];
    console.log(`\n  Avg: ${qualAvg.toFixed(1)}, Median: ${qualMedian.toFixed(1)}`);
  }
}
