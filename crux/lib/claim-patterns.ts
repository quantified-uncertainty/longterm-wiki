/**
 * Shared claim-extraction regex patterns.
 *
 * Centralises patterns used by three consumers to ensure consistency:
 *   - adversarial-review.ts   (FACTUAL_CLAIM_PATTERNS, SPECULATION_PATTERNS, WEASEL_PATTERNS)
 *   - wrong-numbers.ts        (NUMBER_EXTRACTION_PATTERNS)
 *   - cross-reference-checker.ts (ENTITY_FACT_PATTERNS, FactType)
 *
 * When adding a new pattern here it is automatically picked up by all three.
 */

// ---------------------------------------------------------------------------
// Claim quality assessment patterns (adversarial-review)
// ---------------------------------------------------------------------------

/** Words/phrases that indicate speculative or hedging language. */
export const SPECULATION_PATTERNS: RegExp[] = [
  /\b(?:might|may|could|possibly|perhaps|likely|probably|presumably|arguably)\b/i,
  /\b(?:it is believed|some believe|many think|it is thought|widely considered)\b/i,
  /\b(?:appears to|seems to|tends to)\b/i,
];

/** Weasel words that weaken claims without attribution. */
export const WEASEL_PATTERNS: RegExp[] = [
  /\b(?:some experts|many researchers|critics argue|supporters claim|some say)\b/i,
  /\b(?:it has been suggested|it is often said|it is sometimes argued)\b/i,
];

/** Patterns that indicate factual claims (dates, numbers, dollar amounts). */
export const FACTUAL_CLAIM_PATTERNS: RegExp[] = [
  /\$[\d,.]+\s*(?:billion|million|trillion|B|M|K|T)/i,
  /\b(?:founded|established|created|launched)\s+in\s+\d{4}/i,
  /\b\d[\d,]*\s+(?:employees?|staff|researchers?|members?|people)\b/i,
  /\b(?:raised|received|secured|invested)\s+\$[\d,.]+/i,
  /\bin\s+\d{4},/i, // "In 2023," temporal claims
];

// ---------------------------------------------------------------------------
// Number extraction patterns (wrong-numbers injector)
// ---------------------------------------------------------------------------

/**
 * Patterns with capture groups for extracting and mutating specific numbers.
 *
 * Capture structure: [prefix (group 1), number (group 2), suffix (group 3)].
 * Exception: the 'percentage' label has [number (group 1), suffix (group 2)] — no prefix group.
 */
export const NUMBER_EXTRACTION_PATTERNS: { regex: RegExp; label: string }[] = [
  // Years: "founded in 2015", "established 2019", "since 2020"
  {
    regex: /\b((?:founded|established|created|launched|started|formed|incorporated)\s+(?:in\s+)?)((?:19|20)\d{2})\b/gi,
    label: 'founding-year',
  },
  // Dollar amounts with scale: "$100 million", "$2.5 billion"
  {
    regex: /(\$)([\d,.]+)\s*(million|billion|thousand|[MBK])\b/gi,
    label: 'dollar-amount',
  },
  // Plain dollar amounts: "$100", "$2,500"
  {
    regex: /(\$)([\d,]+)(?!\s*(?:million|billion|thousand|[MBK]))/gi,
    label: 'dollar-plain',
  },
  // Employee/staff counts: "50 employees", "200 researchers", "~150 staff"
  {
    regex: /(~?\s*)([\d,]+)\s*(employees?|researchers?|staff|people|members?|engineers?|scientists?)\b/gi,
    label: 'headcount',
  },
  // Percentages: "25%", "increased by 50%"
  {
    regex: /([\d.]+)(%)/g,
    label: 'percentage',
  },
  // Year references: "in 2023", "by 2025", "since 2019"
  {
    regex: /\b(in|by|since|from|during|around)\s+((?:19|20)\d{2})\b/gi,
    label: 'year-reference',
  },
];

// ---------------------------------------------------------------------------
// Entity-aware fact extraction patterns (cross-reference-checker)
// ---------------------------------------------------------------------------

/** Fact types extracted by entity-aware patterns. */
export type FactType = 'founding-year' | 'funding' | 'employee-count' | 'role' | 'date';

/**
 * Patterns for extracting structured facts with entity name capture groups.
 * Used for cross-page contradiction detection.
 *
 * Each entry captures: [entity name (group entityGroup), value (group valueGroup)].
 */
export const ENTITY_FACT_PATTERNS: Array<{
  regex: RegExp;
  factType: FactType;
  entityGroup: number;
  valueGroup: number;
}> = [
  // "X was founded in YYYY"
  {
    regex: /(\b[A-Z][a-zA-Z\s&.-]+?) (?:was )?(?:founded|established|created|launched|incorporated) (?:in )?((?:19|20)\d{2})/g,
    factType: 'founding-year',
    entityGroup: 1,
    valueGroup: 2,
  },
  // "X raised $N million/billion" (handles escaped \$ in MDX)
  {
    regex: /(\b[A-Z][a-zA-Z\s&.-]+?) (?:has )?(?:raised|received|secured) \\?\$([\d,.]+)\s*(million|billion)/gi,
    factType: 'funding',
    entityGroup: 1,
    valueGroup: 2,
  },
  // "X has/had/grown to N employees/staff/researchers"
  {
    regex: /(\b[A-Z][a-zA-Z\s&.-]+?) (?:has|had|employs|employed)(?: grown to)? (?:approximately |about |around |~)?([\d,]+) (?:employees|staff|researchers|people|members)/gi,
    factType: 'employee-count',
    entityGroup: 1,
    valueGroup: 2,
  },
];
