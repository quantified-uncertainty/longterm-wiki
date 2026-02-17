/**
 * Rule: Cross-Page Value Consistency
 *
 * Global-scope rule that detects conflicting numeric claims about the same
 * entity across different wiki pages.
 *
 * Unlike fact-consistency (which checks prose against canonical YAML facts),
 * this rule compares page-to-page: if page A says "$350B" and page B says
 * "$380B" for the same entity's valuation, that's flagged as a conflict.
 *
 * Extraction targets:
 * - Dollar amounts with units: $350B, $2.5 billion, \$380B (MDX-escaped)
 * - Headcounts: "1,000 employees", "~1,200 staff"
 * - Founded-year claims: "founded in 2015"
 *
 * Percentages are skipped (handled elsewhere).
 *
 * Entity attribution strategy:
 * - Claims are attributed to the page's own entity (from slug) by default
 * - A claim is attributed to a different entity only when an EntityLink
 *   appears on the SAME line as the numeric value
 * - This tight proximity requirement avoids false associations
 */

import { createRule, Issue, Severity, ContentFile, ValidationEngine } from '../validation-engine.ts';
import { isInCodeBlock, isInComment } from '../mdx-utils.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A numeric claim extracted from a page */
interface NumericClaim {
  entityId: string;
  metric: string;
  rawValue: string;
  normalizedValue: number;
  filePath: string;
  fileSlug: string;
  line: number;
}

/** A conflict between two claims */
interface Conflict {
  entityId: string;
  metric: string;
  claimA: NumericClaim;
  claimB: NumericClaim;
  percentDiff: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Multipliers for unit suffixes */
const UNIT_MULTIPLIERS: Record<string, number> = {
  thousand: 1e3,
  k: 1e3,
  million: 1e6,
  m: 1e6,
  mn: 1e6,
  billion: 1e9,
  b: 1e9,
  bn: 1e9,
  trillion: 1e12,
  t: 1e12,
  tn: 1e12,
};

/**
 * Context keywords that qualify a dollar amount as a specific metric.
 * Each keyword list is checked against the same line (or immediately
 * surrounding lines) as the dollar amount.
 */
const METRIC_KEYWORDS: Record<string, string[]> = {
  revenue: [
    'revenue', 'arr', 'run-rate revenue', 'run rate revenue',
    'annualized revenue', 'annual revenue', 'sales',
  ],
  valuation: [
    'valuation', 'valued at', 'market cap', 'post-money',
    'pre-money', 'worth',
  ],
  funding: [
    'total funding', 'funding raised', 'raised over', 'raised more than',
    'total raised',
  ],
  // Note: "employees" and "founded" are NOT here — they are extracted by
  // their own dedicated regexes (HEADCOUNT_RE and FOUNDED_RE). Including
  // them here would cause dollar amounts on the same line to be
  // misclassified.
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a numeric string with optional unit suffix to a raw number.
 * "350" + "B" → 350_000_000_000, "1,200" → 1200
 */
function normalizeAmount(numStr: string, unitStr?: string): number | null {
  const cleaned = numStr.replace(/,/g, '').trim();
  if (!cleaned) return null;

  const num = parseFloat(cleaned);
  if (isNaN(num) || num === 0) return null;

  if (unitStr) {
    const multiplier = UNIT_MULTIPLIERS[unitStr.toLowerCase()];
    if (multiplier) return num * multiplier;
  }

  return num;
}

/**
 * Infer the metric type from the text of a single line.
 * Returns the metric name or null if no qualifying keyword is found.
 */
function inferMetricFromLine(line: string): string | null {
  const lower = line.toLowerCase();
  for (const [metric, keywords] of Object.entries(METRIC_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return metric;
    }
  }
  return null;
}

/**
 * Find EntityLink ids on a given line.
 * Returns null if no EntityLink is present on the line.
 * If there's exactly one EntityLink, return its id.
 * If there are multiple, return null (ambiguous — fall back to page entity).
 */
function findEntityLinkOnLine(line: string): string | null {
  const regex = /<EntityLink\s+id=["']([^"']+)["']/g;
  const ids: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    if (!ids.includes(match[1])) ids.push(match[1]);
  }
  // Only attribute to a linked entity if there's exactly one on the line.
  // Multiple links means the line is comparing entities — use page entity.
  return ids.length === 1 ? ids[0] : null;
}

/**
 * Check if position is inside a SquiggleEstimate, code block, or comment.
 */
function shouldSkip(body: string, position: number): boolean {
  if (isInCodeBlock(body, position)) return true;
  if (isInComment(body, position)) return true;

  // Check for SquiggleEstimate
  const before = body.slice(0, position);
  const lastOpen = before.lastIndexOf('<SquiggleEstimate');
  if (lastOpen !== -1) {
    const lastClose = Math.max(
      before.lastIndexOf('</SquiggleEstimate>'),
      before.lastIndexOf('`}'),
    );
    // If we're between the open and close of a SquiggleEstimate
    if (lastOpen > lastClose) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

/**
 * Dollar amounts with unit suffixes.
 * Captures: (number)(unit)
 * Matches: $350B, $2.5 billion, \$380B, $67 billion
 */
const DOLLAR_UNIT_RE =
  /\\?\$([\d,.]+)\s*(billion|million|trillion|thousand|[BMKTbmkt]n?)\b/g;

/**
 * Headcounts with unit words.
 * Captures: (count)
 * Matches: "1,000 employees", "~1,200 staff"
 */
const HEADCOUNT_RE =
  /(?:~|≈|approximately\s+)?([\d,]+)\s+(?:employees|staff|headcount|workers)\b/gi;

/**
 * Founded-year claims.
 * Captures: (year)
 * Matches: "founded in 2015", "established in 2021"
 */
const FOUNDED_RE =
  /(?:founded|established|incorporated)\s+in\s+(\d{4})\b/gi;

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extract numeric claims from a single page.
 * Each claim is attributed to an entity and a metric type.
 */
function extractClaims(file: ContentFile): NumericClaim[] {
  const claims: NumericClaim[] = [];
  const body = file.body;
  if (!body) return claims;

  const lines = body.split('\n');
  const pageEntityId = file.slug.split('/').pop() || '';

  // Process line by line for precise entity attribution
  let charOffset = 0;
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineNum = lineIdx + 1;

    // --- Dollar amounts with units ---
    {
      const regex = new RegExp(DOLLAR_UNIT_RE.source, DOLLAR_UNIT_RE.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(line)) !== null) {
        const absPos = charOffset + match.index;
        if (shouldSkip(body, absPos)) continue;

        const normalized = normalizeAmount(match[1], match[2]);
        if (normalized === null) continue;

        // Infer metric from the same line
        const metric = inferMetricFromLine(line);
        if (!metric) continue;

        // Attribute to EntityLink on same line, else page entity
        const linkedEntity = findEntityLinkOnLine(line);
        const entityId = linkedEntity || pageEntityId;

        claims.push({
          entityId,
          metric,
          rawValue: match[0],
          normalizedValue: normalized,
          filePath: file.path,
          fileSlug: file.slug,
          line: lineNum,
        });
      }
    }

    // --- Headcounts ---
    {
      const regex = new RegExp(HEADCOUNT_RE.source, HEADCOUNT_RE.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(line)) !== null) {
        const absPos = charOffset + match.index;
        if (shouldSkip(body, absPos)) continue;

        const normalized = normalizeAmount(match[1]);
        if (normalized === null) continue;

        const linkedEntity = findEntityLinkOnLine(line);
        const entityId = linkedEntity || pageEntityId;

        claims.push({
          entityId,
          metric: 'employees',
          rawValue: match[0],
          normalizedValue: normalized,
          filePath: file.path,
          fileSlug: file.slug,
          line: lineNum,
        });
      }
    }

    // --- Founded year ---
    // For founded claims, always attribute to the page's own entity.
    // The EntityLink on the line is typically the *founder* (a person),
    // not the entity being founded (which is the page subject).
    {
      const regex = new RegExp(FOUNDED_RE.source, FOUNDED_RE.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(line)) !== null) {
        const absPos = charOffset + match.index;
        if (shouldSkip(body, absPos)) continue;

        const year = parseInt(match[1], 10);
        if (isNaN(year) || year < 1900 || year > 2100) continue;

        claims.push({
          entityId: pageEntityId,
          metric: 'founded',
          rawValue: match[0],
          normalizedValue: year,
          filePath: file.path,
          fileSlug: file.slug,
          line: lineNum,
        });
      }
    }

    charOffset += line.length + 1; // +1 for \n
  }

  return claims;
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

/**
 * Detect conflicts between numeric claims about the same entity+metric
 * across different pages.
 *
 * Strategy:
 * - Group claims by (entityId, metric)
 * - Keep only one claim per file per group (first occurrence)
 * - Compare pairs from different files
 * - For founded years: any difference is a conflict
 * - For dollar amounts/headcounts: >5% difference is WARNING, >2% is INFO
 */
function detectConflicts(claims: NumericClaim[]): Conflict[] {
  // Group by entity+metric
  const groups = new Map<string, NumericClaim[]>();
  for (const claim of claims) {
    const key = `${claim.entityId}::${claim.metric}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(claim);
  }

  const conflicts: Conflict[] = [];
  const seen = new Set<string>();

  for (const [_key, group] of groups) {
    if (group.length < 2) continue;

    // Deduplicate: one claim per file per entity+metric group
    const byFile = new Map<string, NumericClaim>();
    for (const claim of group) {
      if (!byFile.has(claim.filePath)) {
        byFile.set(claim.filePath, claim);
      }
    }

    const fileClaims = [...byFile.values()];
    if (fileClaims.length < 2) continue;

    // Compare pairs from different files
    for (let i = 0; i < fileClaims.length; i++) {
      for (let j = i + 1; j < fileClaims.length; j++) {
        const a = fileClaims[i];
        const b = fileClaims[j];

        // Deduplicate by file pair + entity + metric
        const pairKey = [a.filePath, b.filePath].sort().join('|')
          + `|${a.entityId}|${a.metric}`;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        if (a.metric === 'founded') {
          // For years, any difference is a conflict
          if (a.normalizedValue !== b.normalizedValue) {
            conflicts.push({
              entityId: a.entityId,
              metric: a.metric,
              claimA: a,
              claimB: b,
              percentDiff: 100,
            });
          }
          continue;
        }

        // For amounts, compute symmetric percentage difference
        const avg = (a.normalizedValue + b.normalizedValue) / 2;
        if (avg === 0) continue;
        const pctDiff = (Math.abs(a.normalizedValue - b.normalizedValue) / avg) * 100;

        if (pctDiff > 5) {
          conflicts.push({
            entityId: a.entityId,
            metric: a.metric,
            claimA: a,
            claimB: b,
            percentDiff: pctDiff,
          });
        }
      }
    }
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// Rule export
// ---------------------------------------------------------------------------

export const valueConsistencyRule = createRule({
  id: 'value-consistency',
  name: 'Value Consistency',
  description: 'Check for conflicting numeric values across pages for the same entity',
  scope: 'global',

  check(allFiles: ContentFile[], _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // 1. Extract claims from all non-internal pages
    const allClaims: NumericClaim[] = [];
    for (const file of allFiles) {
      if (file.relativePath.startsWith('internal/')) continue;
      if (file.frontmatter?.pageType === 'documentation') continue;
      if (file.frontmatter?.pageType === 'stub') continue;

      const claims = extractClaims(file);
      allClaims.push(...claims);
    }

    if (allClaims.length === 0) return issues;

    // 2. Detect conflicts
    const conflicts = detectConflicts(allClaims);

    // 3. Convert conflicts to issues (report on both files)
    for (const conflict of conflicts) {
      const { claimA, claimB, percentDiff, metric, entityId } = conflict;

      // >5% or year mismatch → WARNING; otherwise INFO (only INFO for 2-5% range,
      // but we currently filter at >5% for amounts so all amount conflicts are WARNING)
      const severity = Severity.WARNING;

      const diffLabel = metric === 'founded'
        ? `different years`
        : `${percentDiff.toFixed(0)}% difference`;

      const slugA = claimA.fileSlug.split('/').pop() || claimA.fileSlug;
      const slugB = claimB.fileSlug.split('/').pop() || claimB.fileSlug;

      const message =
        `Conflicting ${metric} for "${entityId}": ` +
        `"${claimA.rawValue}" (${slugA}:${claimA.line}) vs ` +
        `"${claimB.rawValue}" (${slugB}:${claimB.line}) — ${diffLabel}`;

      issues.push(new Issue({
        rule: 'value-consistency',
        file: claimA.filePath,
        line: claimA.line,
        message,
        severity,
      }));

      issues.push(new Issue({
        rule: 'value-consistency',
        file: claimB.filePath,
        line: claimB.line,
        message,
        severity,
      }));
    }

    return issues;
  },
});

export default valueConsistencyRule;
