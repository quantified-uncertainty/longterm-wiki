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
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { getClaimsByEntity, type ClaimRow } from '../lib/wiki-server/claims.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const CHECK_NAMES = [
  'self-contained',
  'correctly-attributed',
  'clean-text',
  'atomic',
  'specific',
  'correctly-typed',
  'temporally-grounded',
  'complete',
  'non-tautological',
  'contextually-complete',
] as const;

type CheckName = (typeof CHECK_NAMES)[number];

interface CheckResult {
  check: CheckName;
  passed: boolean;
  detail?: string;
}

interface ClaimQualityReport {
  claimId: number;
  claimText: string;
  checks: CheckResult[];
  passCount: number;
  failCount: number;
}

interface QualityAuditResult {
  entityId: string;
  totalClaims: number;
  checkBreakdown: Record<CheckName, { passed: number; total: number; pct: number }>;
  overallPassed: number;
  overallTotal: number;
  overallPct: number;
  worstClaims: ClaimQualityReport[];
  allReports: ClaimQualityReport[];
}

// ---------------------------------------------------------------------------
// Patterns (reused from validate-claim.ts, kept local to avoid coupling)
// ---------------------------------------------------------------------------

/** Vague words that indicate low-quality claims when used without specifics. */
const VAGUE_PATTERNS = [
  { pattern: /\bsignificant(?:ly)?\b/i, word: 'significant' },
  { pattern: /\bvarious\b/i, word: 'various' },
  { pattern: /\bseveral\b/i, word: 'several' },
  { pattern: /\bnumerous\b/i, word: 'numerous' },
  { pattern: /\bmany\b/i, word: 'many' },
];

/** MDX/markup patterns that should not appear in clean claim text. */
const MDX_PATTERNS = [
  { pattern: /<F\s/, label: '<F> tag' },
  { pattern: /<EntityLink\b/, label: '<EntityLink> tag' },
  { pattern: /\{\/\*/, label: '{/* comment' },
  { pattern: /<Calc\b/, label: '<Calc> tag' },
  { pattern: /<SquiggleEstimate\b/, label: '<SquiggleEstimate> tag' },
  { pattern: /\{#\w/, label: 'MDX expression' },
];

/** Volatile measures that need temporal grounding (asOf or valueDate). */
const VOLATILE_MEASURES = new Set([
  'revenue',
  'valuation',
  'headcount',
  'employee_count',
  'funding_round_amount',
  'market_share',
  'cash-burn',
  'user-count',
  'customer-count',
]);

/** Volatile keywords detected in claim text (for claims without a measure field). */
const VOLATILE_TEXT_PATTERNS = [
  /\brevenue\b/i,
  /\bvaluation\b/i,
  /\bheadcount\b/i,
  /\bemployees?\b/i,
  /\bfunding\b/i,
  /\bmarket share\b/i,
  /\bcash burn\b/i,
  /\busers?\b/i,
  /\bcustomers?\b/i,
  /\bworth\b/i,
  /\braised?\b/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a slug like "sam-altman" to a display name like "Sam Altman". */
function slugToDisplayName(slug: string): string {
  return slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Escape special regex characters. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if claim text mentions the entity by name, slug, or common variations.
 * Mirrors the pattern from validate-claim.ts.
 */
function containsEntityReference(
  text: string,
  entityId: string,
  entityName: string,
): boolean {
  const lower = text.toLowerCase();

  if (entityName.length > 0 && lower.includes(entityName.toLowerCase())) {
    return true;
  }

  if (entityId.length > 0 && lower.includes(entityId.toLowerCase())) {
    return true;
  }

  // For hyphenated slugs like "sam-altman", check for "Sam Altman"
  if (entityId.includes('-')) {
    const slugWords = entityId.split('-').join(' ');
    if (lower.includes(slugWords.toLowerCase())) {
      return true;
    }
  }

  return false;
}

/**
 * Detect tautological definitions like "X is a/an Y".
 * Mirrors the pattern from validate-claim.ts.
 */
function isTautologicalDefinition(
  text: string,
  entityId: string,
  entityName: string,
): boolean {
  const lower = text.toLowerCase();
  const entityLower = entityName.toLowerCase();
  const idLower = entityId.toLowerCase();

  const startsWithEntity =
    lower.startsWith(entityLower + ' ') || lower.startsWith(idLower + ' ');

  if (!startsWithEntity) return false;

  const tautologyPattern = new RegExp(
    `^(?:${escapeRegex(entityLower)}|${escapeRegex(idLower)})\\s+(?:is|was)\\s+(?:a|an|the)\\s+`,
    'i',
  );

  if (!tautologyPattern.test(text)) return false;

  const afterEntity = text.replace(tautologyPattern, '');
  const hasSpecifics =
    /\d/.test(afterEntity) ||
    /\b(?:in|from|based|founded|headquartered|located)\b/i.test(afterEntity);

  return !hasSpecifics;
}

// ---------------------------------------------------------------------------
// Quality check implementations
// ---------------------------------------------------------------------------

function checkSelfContained(
  claim: ClaimRow,
  entityId: string,
  entityName: string,
): CheckResult {
  const passed = containsEntityReference(claim.claimText, entityId, entityName);
  return {
    check: 'self-contained',
    passed,
    detail: passed
      ? undefined
      : `missing entity name "${entityName}" or "${entityId}"`,
  };
}

function checkCorrectlyAttributed(
  claim: ClaimRow,
  entityId: string,
): CheckResult {
  // If subjectEntity is not set, we can't validate — pass by default
  if (!claim.subjectEntity) {
    return { check: 'correctly-attributed', passed: true };
  }

  // subjectEntity should match the entityId or be a known related entity
  const subject = claim.subjectEntity.toLowerCase();
  const entityLower = entityId.toLowerCase();

  // Direct match
  if (subject === entityLower) {
    return { check: 'correctly-attributed', passed: true };
  }

  // Check if subjectEntity is in relatedEntities
  const related = claim.relatedEntities ?? [];
  const isRelated = related.some((r) => r.toLowerCase() === subject);
  if (isRelated) {
    return { check: 'correctly-attributed', passed: true };
  }

  // Check if entityId is in relatedEntities (subject is something else but entity is related)
  const entityIsRelated = related.some((r) => r.toLowerCase() === entityLower);
  if (entityIsRelated) {
    return { check: 'correctly-attributed', passed: true };
  }

  return {
    check: 'correctly-attributed',
    passed: false,
    detail: `subjectEntity "${claim.subjectEntity}" is not "${entityId}" or in relatedEntities`,
  };
}

function checkCleanText(claim: ClaimRow): CheckResult {
  for (const { pattern, label } of MDX_PATTERNS) {
    if (pattern.test(claim.claimText)) {
      return {
        check: 'clean-text',
        passed: false,
        detail: `contains ${label}`,
      };
    }
  }
  return { check: 'clean-text', passed: true };
}

function checkAtomic(claim: ClaimRow): CheckResult {
  const text = claim.claimText;

  // Check for semicolons splitting independent clauses
  // (but not semicolons in URLs or data)
  if (/;\s+[A-Z]/.test(text)) {
    return {
      check: 'atomic',
      passed: false,
      detail: 'contains semicolon splitting independent clauses',
    };
  }

  // Check for "and" joining two distinct facts with separate subjects
  // Heuristic: look for patterns like "Subject verb X, and Subject verb Y"
  // or "Subject verb X and also verb Y"
  if (/,\s+and\s+(?:also\s+)?[A-Z]/.test(text)) {
    return {
      check: 'atomic',
      passed: false,
      detail: 'uses ", and [A-Z]" pattern suggesting multiple facts',
    };
  }

  // Check for "Additionally" / "Also" / "Furthermore" mid-sentence joining facts
  if (/\.\s+(?:Additionally|Also|Furthermore|Moreover),?\s+/i.test(text)) {
    return {
      check: 'atomic',
      passed: false,
      detail: 'contains multiple sentences with connective adverbs',
    };
  }

  return { check: 'atomic', passed: true };
}

function checkSpecific(claim: ClaimRow): CheckResult {
  const text = claim.claimText;
  const hasSpecifics = /\d/.test(text);

  if (!hasSpecifics) {
    for (const { pattern, word } of VAGUE_PATTERNS) {
      if (pattern.test(text)) {
        return {
          check: 'specific',
          passed: false,
          detail: `uses "${word}" without specifics`,
        };
      }
    }
  }

  return { check: 'specific', passed: true };
}

function checkCorrectlyTyped(claim: ClaimRow): CheckResult {
  const { claimType, claimText, valueNumeric } = claim;

  // If claimType is "numeric" or "quantitative", there should be a valueNumeric or a number in text
  if (
    claimType === 'numeric' ||
    claimType === 'quantitative' ||
    claimType === 'metric'
  ) {
    const hasNumber = valueNumeric != null || /\d/.test(claimText);
    if (!hasNumber) {
      return {
        check: 'correctly-typed',
        passed: false,
        detail: `claimType is "${claimType}" but no numeric value found`,
      };
    }
  }

  // If claimType is "historical" or "temporal", there should be a date reference
  if (claimType === 'historical' || claimType === 'temporal') {
    const hasDate =
      claim.valueDate != null ||
      claim.asOf != null ||
      /\b(?:19|20)\d{2}\b/.test(claimText) ||
      /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(
        claimText,
      );
    if (!hasDate) {
      return {
        check: 'correctly-typed',
        passed: false,
        detail: `claimType is "${claimType}" but no date reference found`,
      };
    }
  }

  // If text has a clear numeric value but claimType is "descriptive"/"qualitative", warn
  if (
    (claimType === 'descriptive' || claimType === 'qualitative') &&
    valueNumeric != null
  ) {
    return {
      check: 'correctly-typed',
      passed: false,
      detail: `claimType is "${claimType}" but has valueNumeric=${valueNumeric}`,
    };
  }

  return { check: 'correctly-typed', passed: true };
}

function checkTemporallyGrounded(claim: ClaimRow): CheckResult {
  const { measure, claimText, asOf, valueDate } = claim;

  // Check 1: if the claim has a known volatile measure
  const isVolatileMeasure = measure != null && VOLATILE_MEASURES.has(measure);

  // Check 2: if the claim text mentions volatile topics
  const isVolatileText =
    !isVolatileMeasure &&
    claim.valueNumeric != null &&
    VOLATILE_TEXT_PATTERNS.some((p) => p.test(claimText));

  if (isVolatileMeasure || isVolatileText) {
    const hasTemporalGrounding =
      asOf != null ||
      valueDate != null ||
      /\b(?:as of|in|during|since)\s+(?:19|20)\d{2}\b/i.test(claimText) ||
      /\b(?:Q[1-4])\s+(?:19|20)\d{2}\b/i.test(claimText) ||
      /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:19|20)\d{2}\b/i.test(
        claimText,
      );

    if (!hasTemporalGrounding) {
      const topic = isVolatileMeasure ? `measure="${measure}"` : 'numeric value with volatile topic';
      return {
        check: 'temporally-grounded',
        passed: false,
        detail: `${topic} lacks temporal grounding (no asOf, valueDate, or date in text)`,
      };
    }
  }

  return { check: 'temporally-grounded', passed: true };
}

function checkComplete(claim: ClaimRow): CheckResult {
  const text = claim.claimText.trim();

  if (text.length < 20) {
    return {
      check: 'complete',
      passed: false,
      detail: `claim is only ${text.length} chars (min 20)`,
    };
  }

  if (!/[.!?]$/.test(text)) {
    return {
      check: 'complete',
      passed: false,
      detail: 'missing terminal punctuation',
    };
  }

  return { check: 'complete', passed: true };
}

function checkNonTautological(
  claim: ClaimRow,
  entityId: string,
  entityName: string,
): CheckResult {
  if (isTautologicalDefinition(claim.claimText, entityId, entityName)) {
    return {
      check: 'non-tautological',
      passed: false,
      detail: `merely defines what ${entityName} is`,
    };
  }
  return { check: 'non-tautological', passed: true };
}

function checkContextuallyComplete(claim: ClaimRow): CheckResult {
  const { claimText, valueNumeric, valueUnit } = claim;

  // Only relevant for claims with numeric values
  if (valueNumeric == null) {
    return { check: 'contextually-complete', passed: true };
  }

  // If there's a valueUnit set, that's sufficient context
  if (valueUnit != null && valueUnit.length > 0) {
    return { check: 'contextually-complete', passed: true };
  }

  // Check if the text itself provides units/context around the number
  // Look for currency symbols, percentage signs, unit words near numbers
  const hasUnitsInText =
    /\$[\d,.]+/.test(claimText) ||
    /[\d,.]+\s*%/.test(claimText) ||
    /[\d,.]+\s*(?:billion|million|thousand|trillion|USD|EUR|GBP)/i.test(claimText) ||
    /[\d,.]+\s*(?:people|employees|users|customers|members|researchers|scientists)/i.test(claimText) ||
    /[\d,.]+\s*(?:years?|months?|days?|hours?|minutes?|seconds?)/i.test(claimText) ||
    /[\d,.]+\s*(?:GB|TB|MB|KB|km|mi|kg|lb|m|ft)/i.test(claimText);

  if (!hasUnitsInText) {
    return {
      check: 'contextually-complete',
      passed: false,
      detail: `has valueNumeric=${valueNumeric} but no unit in valueUnit or claim text`,
    };
  }

  return { check: 'contextually-complete', passed: true };
}

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
// Output formatting
// ---------------------------------------------------------------------------

function printHumanReport(result: QualityAuditResult): void {
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

function printJsonReport(result: QualityAuditResult): void {
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
