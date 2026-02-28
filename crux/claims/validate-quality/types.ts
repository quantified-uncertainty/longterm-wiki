/**
 * Types, constants, and patterns for claims quality validation.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const CHECK_NAMES = [
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

export type CheckName = (typeof CHECK_NAMES)[number];

export interface CheckResult {
  check: CheckName;
  passed: boolean;
  detail?: string;
}

export interface ClaimQualityReport {
  claimId: number;
  claimText: string;
  checks: CheckResult[];
  passCount: number;
  failCount: number;
}

export interface QualityAuditResult {
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
export const VAGUE_PATTERNS = [
  { pattern: /\bsignificant(?:ly)?\b/i, word: 'significant' },
  { pattern: /\bvarious\b/i, word: 'various' },
  { pattern: /\bseveral\b/i, word: 'several' },
  { pattern: /\bnumerous\b/i, word: 'numerous' },
  { pattern: /\bmany\b/i, word: 'many' },
];

/** MDX/markup patterns that should not appear in clean claim text. */
export const MDX_PATTERNS = [
  { pattern: /<F\s/, label: '<F> tag' },
  { pattern: /<EntityLink\b/, label: '<EntityLink> tag' },
  { pattern: /\{\/\*/, label: '{/* comment' },
  { pattern: /<Calc\b/, label: '<Calc> tag' },
  { pattern: /<SquiggleEstimate\b/, label: '<SquiggleEstimate> tag' },
  { pattern: /\{#\w/, label: 'MDX expression' },
];

/** Volatile measures that need temporal grounding (asOf or valueDate). */
export const VOLATILE_MEASURES = new Set([
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
export const VOLATILE_TEXT_PATTERNS = [
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
