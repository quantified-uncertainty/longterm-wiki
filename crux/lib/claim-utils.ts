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
