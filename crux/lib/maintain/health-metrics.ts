/**
 * Codebase health metrics collection.
 *
 * Shell-based metric gathering for trend tracking.
 */

import { execSync } from 'child_process';
import { PROJECT_ROOT } from '../content-types.ts';
import type { HealthMetrics } from './types.ts';

const EXEC_OPTS = { encoding: 'utf-8' as const, cwd: PROJECT_ROOT, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 };

function grepCount(pattern: string, dirs: string): number {
  try {
    const out = execSync(
      `grep -rc '${pattern}' ${dirs} --include='*.ts' --include='*.tsx' 2>/dev/null | awk -F: '{s+=$2} END {print s}'`,
      EXEC_OPTS,
    ).trim();
    return parseInt(out, 10) || 0;
  } catch {
    return 0;
  }
}

function fileCount(pattern: string): number {
  try {
    const out = execSync(
      `find crux/ apps/web/src/ apps/wiki-server/src/ ${pattern} 2>/dev/null | wc -l`,
      EXEC_OPTS,
    ).trim();
    return parseInt(out, 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Collect all health metrics for the codebase.
 */
export function collectHealthMetrics(): HealthMetrics {
  const dirs = 'crux/ apps/web/src/';

  const metrics: HealthMetrics = {
    date: new Date().toISOString().slice(0, 10),
    todoCount: grepCount('TODO', dirs),
    fixmeCount: grepCount('FIXME\\\\|HACK\\\\|XXX', dirs),
    anyTypeCount: grepCount(': any\\\\b\\\\|as any\\\\b', dirs),
    largeFiles: [],
    largeFileCount: 0,
    testFileCount: 0,
    sourceFileCount: 0,
    testToSourceRatio: 0,
    totalSourceLines: 0,
    recentCommits: { total: 0, fixes: 0, features: 0, fixRatio: 0 },
    skippedTests: 0,
  };

  // Large files (>500 lines)
  try {
    const wcOut = execSync(
      `find crux/ apps/web/src/ \\( -name '*.ts' -o -name '*.tsx' \\) ! -name '*.test.*' ! -name '*.d.ts' | xargs wc -l 2>/dev/null | sort -rn | head -30`,
      EXEC_OPTS,
    );
    for (const line of wcOut.split('\n').filter(Boolean)) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (match && match[2] !== 'total') {
        const lineCount = parseInt(match[1], 10);
        metrics.totalSourceLines += lineCount;
        if (lineCount > 500) {
          metrics.largeFiles.push({ path: match[2], lines: lineCount });
        }
      }
    }
    metrics.largeFileCount = metrics.largeFiles.length;
  } catch { /* empty */ }

  // Test vs source file counts
  metrics.testFileCount = fileCount("-name '*.test.*' -o -name '*.spec.*'");
  metrics.sourceFileCount = fileCount("\\( -name '*.ts' -o -name '*.tsx' \\) ! -name '*.test.*' ! -name '*.spec.*' ! -name '*.d.ts'");

  metrics.testToSourceRatio = metrics.sourceFileCount > 0
    ? Math.round((metrics.testFileCount / metrics.sourceFileCount) * 100) / 100
    : 0;

  // Recent commit analysis (last 60 commits)
  try {
    const logOut = execSync('git log --oneline -60', EXEC_OPTS);
    const lines = logOut.split('\n').filter(Boolean);
    metrics.recentCommits.total = lines.length;
    metrics.recentCommits.fixes = lines.filter(l => /\bfix[:(]/i.test(l)).length;
    metrics.recentCommits.features = lines.filter(l => /\bfeat[:(]/i.test(l)).length;
    metrics.recentCommits.fixRatio = metrics.recentCommits.total > 0
      ? Math.round((metrics.recentCommits.fixes / metrics.recentCommits.total) * 100) / 100
      : 0;
  } catch { /* empty */ }

  // Skipped tests
  metrics.skippedTests = grepCount(
    'it\\.skip\\\\|describe\\.skip\\\\|test\\.skip',
    'crux/ apps/web/src/ apps/wiki-server/src/',
  );

  return metrics;
}
