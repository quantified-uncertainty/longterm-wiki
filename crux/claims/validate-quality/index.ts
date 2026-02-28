/**
 * Claims Quality Validation — post-hoc auditor for existing claims in the DB
 *
 * Fetches all claims for an entity from the wiki-server API and runs 10 quality
 * checks on each claim, reporting a breakdown of issues found.
 *
 * Usage:
 *   pnpm crux claims validate-quality <entity-id>
 *   pnpm crux claims validate-quality <entity-id> --json
 *
 * Quality checks:
 *   1. self-contained       — contains recognized entity name
 *   2. correctly-attributed — subjectEntity matches entityId or known related entity
 *   3. clean-text           — no MDX markup (<F, <EntityLink, {/*, etc.)
 *   4. atomic               — no "and" joining two distinct facts, no semicolons splitting assertions
 *   5. specific             — no vague quantifiers without numbers
 *   6. correctly-typed      — claimType matches content (numeric has valueNumeric, etc.)
 *   7. temporally-grounded  — volatile numeric claims have asOf or valueDate
 *   8. complete             — ends with terminal punctuation, length > 20 chars
 *   9. non-tautological     — not just restating a definition
 *  10. contextually-complete — numeric claims include units/context
 */

import { fileURLToPath } from 'url';
import { parseCliArgs } from '../../lib/cli.ts';
import { getColors } from '../../lib/output.ts';
import { getClaimsByEntity, type ClaimRow } from '../../lib/wiki-server/claims.ts';
import { isServerAvailable } from '../../lib/wiki-server/client.ts';

import {
  CHECK_NAMES,
  type CheckName,
  type CheckResult,
  type ClaimQualityReport,
  type QualityAuditResult,
} from './types.ts';
import {
  slugToDisplayName,
  checkSelfContained,
  checkCorrectlyAttributed,
  checkCleanText,
  checkAtomic,
  checkSpecific,
  checkCorrectlyTyped,
  checkTemporallyGrounded,
  checkComplete,
  checkNonTautological,
  checkContextuallyComplete,
} from './checks.ts';
import { printHumanReport, printJsonReport } from './report.ts';

// Re-export types for any future consumers
export type { CheckName, CheckResult, ClaimQualityReport, QualityAuditResult } from './types.ts';
export { CHECK_NAMES } from './types.ts';

// ---------------------------------------------------------------------------
// Run all checks on a single claim
// ---------------------------------------------------------------------------

function runAllChecks(
  claim: ClaimRow,
  entityId: string,
  entityName: string,
): ClaimQualityReport {
  const checks: CheckResult[] = [
    checkSelfContained(claim, entityId, entityName),
    checkCorrectlyAttributed(claim, entityId),
    checkCleanText(claim),
    checkAtomic(claim),
    checkSpecific(claim),
    checkCorrectlyTyped(claim),
    checkTemporallyGrounded(claim),
    checkComplete(claim),
    checkNonTautological(claim, entityId, entityName),
    checkContextuallyComplete(claim),
  ];

  const passCount = checks.filter((c) => c.passed).length;
  const failCount = checks.filter((c) => !c.passed).length;

  return {
    claimId: claim.id,
    claimText: claim.claimText,
    checks,
    passCount,
    failCount,
  };
}

// ---------------------------------------------------------------------------
// Audit orchestrator
// ---------------------------------------------------------------------------

function runAudit(
  claims: ClaimRow[],
  entityId: string,
): QualityAuditResult {
  const entityName = slugToDisplayName(entityId);
  const allReports = claims.map((claim) =>
    runAllChecks(claim, entityId, entityName),
  );

  // Build per-check breakdown
  const checkBreakdown = {} as Record<
    CheckName,
    { passed: number; total: number; pct: number }
  >;
  for (const name of CHECK_NAMES) {
    const passed = allReports.filter((r) =>
      r.checks.find((c) => c.check === name)?.passed,
    ).length;
    const total = allReports.length;
    checkBreakdown[name] = {
      passed,
      total,
      pct: total > 0 ? (passed / total) * 100 : 100,
    };
  }

  const overallTotal = allReports.length * CHECK_NAMES.length;
  const overallPassed = allReports.reduce((sum, r) => sum + r.passCount, 0);

  // Sort by most failures for "worst claims"
  const worstClaims = [...allReports]
    .filter((r) => r.failCount > 0)
    .sort((a, b) => b.failCount - a.failCount)
    .slice(0, 10);

  return {
    entityId,
    totalClaims: claims.length,
    checkBreakdown,
    overallPassed,
    overallTotal,
    overallPct: overallTotal > 0 ? (overallPassed / overallTotal) * 100 : 100,
    worstClaims,
    allReports,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const json = args.json === true;
  const c = getColors(json);
  const positional = (args._positional as string[]) || [];
  const entityId = positional[0];

  if (!entityId) {
    console.error(`${c.red}Error: provide an entity ID${c.reset}`);
    console.error(`  Usage: pnpm crux claims validate-quality <entity-id>`);
    console.error(`  Usage: pnpm crux claims validate-quality <entity-id> --json`);
    process.exit(1);
  }

  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.error(
      `${c.red}Wiki server not available. Set LONGTERMWIKI_SERVER_URL and LONGTERMWIKI_SERVER_API_KEY.${c.reset}`,
    );
    process.exit(1);
  }

  const result = await getClaimsByEntity(entityId);
  if (!result.ok) {
    console.error(
      `${c.red}Could not fetch claims for ${entityId}${c.reset}`,
    );
    process.exit(1);
  }

  const claims = result.data.claims;

  if (claims.length === 0) {
    if (json) {
      console.log(
        JSON.stringify({
          entityId,
          totalClaims: 0,
          message: `No claims found. Run: pnpm crux claims extract ${entityId}`,
        }),
      );
    } else {
      console.log(`${c.yellow}No claims found for ${entityId}${c.reset}`);
      console.log(`  Run: pnpm crux claims extract ${entityId}`);
    }
    process.exit(0);
  }

  const audit = runAudit(claims, entityId);

  if (json) {
    printJsonReport(audit);
  } else {
    printHumanReport(audit);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Claims quality validation failed:', err);
    process.exit(1);
  });
}
