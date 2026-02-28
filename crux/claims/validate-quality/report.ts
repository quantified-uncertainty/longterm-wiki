/**
 * Output formatting for claims quality audit reports.
 */

import { getColors } from '../../lib/output.ts';
import { CHECK_NAMES, type QualityAuditResult } from './types.ts';

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

export function printHumanReport(result: QualityAuditResult): void {
  const c = getColors(false);

  console.log(
    `\n${c.bold}${c.blue}Claims Quality Audit: ${result.entityId}${c.reset}\n`,
  );
  console.log(`  Total claims: ${c.bold}${result.totalClaims}${c.reset}\n`);

  console.log(`  ${c.bold}Check Breakdown:${c.reset}`);
  for (const name of CHECK_NAMES) {
    const { passed, total, pct } = result.checkBreakdown[name];
    const color = pct >= 95 ? c.green : pct >= 80 ? c.yellow : c.red;
    console.log(
      `    ${name.padEnd(24)} ${color}${String(passed).padStart(4)}/${total} (${pct.toFixed(1)}%)${c.reset}`,
    );
  }

  console.log(
    `\n  ${c.bold}Overall:${c.reset} ${result.overallPassed}/${result.overallTotal} checks passed (${result.overallPct.toFixed(1)}%)\n`,
  );

  if (result.worstClaims.length > 0) {
    console.log(`  ${c.bold}Worst claims (most failures):${c.reset}`);
    for (const report of result.worstClaims.slice(0, 5)) {
      const truncated =
        report.claimText.length > 80
          ? report.claimText.slice(0, 77) + '...'
          : report.claimText;
      console.log(
        `    ${c.yellow}#${report.claimId}:${c.reset} "${truncated}" ${c.red}(${report.failCount} failure${report.failCount === 1 ? '' : 's'})${c.reset}`,
      );
      for (const check of report.checks) {
        if (!check.passed) {
          console.log(
            `      ${c.dim}- ${check.check}: ${check.detail ?? 'failed'}${c.reset}`,
          );
        }
      }
    }
  }

  console.log('');
}

export function printJsonReport(result: QualityAuditResult): void {
  const output = {
    entityId: result.entityId,
    totalClaims: result.totalClaims,
    checkBreakdown: result.checkBreakdown,
    overallPassed: result.overallPassed,
    overallTotal: result.overallTotal,
    overallPct: result.overallPct,
    worstClaims: result.worstClaims.map((r) => ({
      claimId: r.claimId,
      claimText: r.claimText,
      failCount: r.failCount,
      failures: r.checks
        .filter((ch) => !ch.passed)
        .map((ch) => ({ check: ch.check, detail: ch.detail })),
    })),
    allReports: result.allReports.map((r) => ({
      claimId: r.claimId,
      claimText: r.claimText,
      passCount: r.passCount,
      failCount: r.failCount,
      checks: r.checks.map((ch) => ({
        check: ch.check,
        passed: ch.passed,
        ...(ch.detail ? { detail: ch.detail } : {}),
      })),
    })),
  };
  console.log(JSON.stringify(output, null, 2));
}
