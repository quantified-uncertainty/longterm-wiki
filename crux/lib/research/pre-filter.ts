// Pre-submission token filter for proposed claims.
// Drops claims whose distinguishing tokens are absent from the resource content.
// Findings from FISA-702 post-mortem (E2): 7 of 17 unverifiable verdicts had
// "absent" tokens — claims that the verifier could never have confirmed.
// Filtering them at submission time saves LLM cost and reduces unverifiable rate.

export interface PreFilterClaim {
  claimText: string;
  proposedValue?: string | null;
  resourceId: string;
  sourceUrl: string;
  // Anything else passes through unchanged.
  [k: string]: unknown;
}

export interface PreFilterDecision {
  /** The original claim. */
  claim: PreFilterClaim;
  /** Whether to submit. */
  keep: boolean;
  /** Tokens we extracted from claimText + proposedValue. */
  tokens: string[];
  /** Tokens that were not found in the source content. */
  missing: string[];
  /** Tokens that were found and their first-occurrence index. */
  hits: Array<{ token: string; idx: number }>;
}

const MIN_TOKEN_LEN = 4;

/** Extract distinguishing tokens (proper nouns, numbers, dates, statute refs, quoted phrases). */
export function extractKeyTokens(text: string): string[] {
  const out = new Set<string>();
  // 4-digit years
  for (const m of text.matchAll(/\b(19|20)\d{2}\b/g)) out.add(m[0]);
  // Acronyms (3+ caps)
  for (const m of text.matchAll(/\b[A-Z]{3,}\b/g)) out.add(m[0]);
  // Multi-word capitalized phrases
  for (const m of text.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}\b/g)) out.add(m[0]);
  // Statute references (e.g., 50 U.S.C. § 1881a)
  for (const m of text.matchAll(/\b\d+\s+U\.?S\.?C\.?\s*§?\s*\d+\w*/gi)) out.add(m[0]);
  // Vote tallies (e.g., 273-147)
  for (const m of text.matchAll(/\b\d{2,4}-\d{2,4}\b/g)) out.add(m[0]);
  // Quoted phrases
  for (const m of text.matchAll(/['"]([^'"]{4,40})['"]/g)) out.add(m[1]);
  // Drop tokens shorter than MIN_TOKEN_LEN
  return [...out].filter((t) => t.length >= MIN_TOKEN_LEN);
}

/** Check whether each token appears in the source content. */
export function decide(
  claim: PreFilterClaim,
  sourceContent: string,
  options: { minHits?: number } = {},
): PreFilterDecision {
  const minHits = options.minHits ?? 1;
  const text = `${claim.claimText}\n${claim.proposedValue ?? ""}`;
  const tokens = extractKeyTokens(text);
  if (tokens.length === 0) {
    // No distinguishing tokens — let it through; we have no signal either way.
    return { claim, keep: true, tokens, missing: [], hits: [] };
  }
  const lc = sourceContent.toLowerCase();
  const hits: Array<{ token: string; idx: number }> = [];
  const missing: string[] = [];
  for (const t of tokens) {
    const idx = lc.indexOf(t.toLowerCase());
    if (idx === -1) missing.push(t);
    else hits.push({ token: t, idx });
  }
  const keep = hits.length >= minHits;
  return { claim, keep, tokens, missing, hits };
}

/** Filter a batch of claims given a map of resourceId → fetched content. */
export function preFilterBatch(
  claims: PreFilterClaim[],
  contentByResourceId: Map<string, string>,
): { kept: PreFilterClaim[]; dropped: PreFilterDecision[]; decisions: PreFilterDecision[] } {
  const decisions: PreFilterDecision[] = [];
  const kept: PreFilterClaim[] = [];
  const dropped: PreFilterDecision[] = [];
  for (const c of claims) {
    const content = contentByResourceId.get(c.resourceId) ?? "";
    if (!content) {
      // No content — we can't pre-filter. Let the verifier handle it.
      const dec: PreFilterDecision = {
        claim: c, keep: true, tokens: [], missing: [], hits: [],
      };
      decisions.push(dec);
      kept.push(c);
      continue;
    }
    const dec = decide(c, content);
    decisions.push(dec);
    if (dec.keep) kept.push(c);
    else dropped.push(dec);
  }
  return { kept, dropped, decisions };
}
