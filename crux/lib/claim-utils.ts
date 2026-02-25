/**
 * Parse a raw value (number, string, or unknown) into a finite number.
 * Handles string-encoded numbers like "7300000000" or "7,300,000,000".
 * Returns undefined if the value cannot be parsed.
 */
export function parseNumericValue(v: unknown): number | undefined {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/,/g, ''));
    if (isFinite(n)) return n;
  }
  return undefined;
}

/** Valid claim types — expanded taxonomy from claim-first architecture. */
export const VALID_CLAIM_TYPES = [
  'factual', 'evaluative', 'causal', 'historical',
  'numeric', 'consensus', 'speculative', 'relational',
] as const;

export type ClaimTypeValue = (typeof VALID_CLAIM_TYPES)[number];

/** Map from granular claimType → high-level claimCategory. */
export function claimTypeToCategory(claimType: ClaimTypeValue): string {
  switch (claimType) {
    case 'factual':
    case 'numeric':
    case 'historical':
      return 'factual';
    case 'evaluative':
      return 'opinion';
    case 'causal':
      return 'analytical';
    case 'consensus':
      return 'opinion';
    case 'speculative':
      return 'speculative';
    case 'relational':
      return 'relational';
    default:
      return 'factual';
  }
}
