/**
 * Single-source verification — given one fetched page, decide whether it
 * supports the record's claim, and if so package it as a ranking candidate.
 *
 * Order of checks (cheapest first; bail at first reason):
 *   1. Self-domain (circular sourcing) — free, regex-only.
 *   2. Content too short (<50 chars) — free, length check.
 *   3. Page mentions all required entity slots — free, substring check.
 *   4. Haiku extracts up to 3 verbatim supporting quotes — paid.
 *   5. Substring-verify each quote really exists in the page — free,
 *      drops the call if Haiku fabricated the quote.
 *   6. Sonnet judges whether the verified quotes entail the claim — paid.
 *
 * Returns either { accepted } with the candidate + costs, or { rejected }
 * with a machine-readable reason + costs incurred so far.
 */

import { MIN_CONTENT_LENGTH } from './config.ts';
import { contentMentionsEntity, isSelfDomain } from './entity-mention.ts';
import { extractSupportingQuotes, verifyEntailment } from './llm-calls.ts';
import { verifyQuoteInContent } from './prompts.ts';
import type { RankCandidate } from './types.ts';

export type RejectionReason =
  | 'self-domain'
  | 'too-short'
  | 'no-entity-mention'
  | 'no-quote'
  | 'quote-fabricated'
  | 'entailment-failed';

/** USD spent on LLM calls during one source's verification. */
export interface VerifyCost {
  quoteExtractCost: number;
  entailmentCost: number;
}

export type VerifyResult =
  | { kind: 'accepted'; candidate: RankCandidate; cost: VerifyCost }
  | {
      kind: 'rejected';
      reason: RejectionReason;
      cost: VerifyCost;
      /** Extra context for debug logs (e.g. missing entity slots, fabricated quotes). */
      detail?: { missingSlots?: string[][]; haikuQuotes?: string[]; verifiedQuotes?: string[] };
    };

export interface VerifySourceInput {
  url: string;
  content: string;
  title?: string;
  provider?: string;
}

/**
 * Run the verification pipeline against one source. `mentionTargets` is the
 * AND-of-OR slot list returned by `entitiesToMention(record)` — every slot
 * must match at least one variant.
 */
export async function verifySource(
  source: VerifySourceInput,
  claim: string,
  entityName: string,
  mentionTargets: string[][],
): Promise<VerifyResult> {
  const cost: VerifyCost = { quoteExtractCost: 0, entailmentCost: 0 };

  if (isSelfDomain(source.url)) {
    return { kind: 'rejected', reason: 'self-domain', cost };
  }

  if (source.content.length < MIN_CONTENT_LENGTH) {
    return { kind: 'rejected', reason: 'too-short', cost };
  }

  const missingSlots = mentionTargets.filter(
    variants => !variants.some(v => contentMentionsEntity(source.content, v, source.url)),
  );
  if (missingSlots.length > 0) {
    return { kind: 'rejected', reason: 'no-entity-mention', cost, detail: { missingSlots } };
  }

  const extracted = await extractSupportingQuotes(claim, entityName, source.content);
  cost.quoteExtractCost = extracted.cost;
  if (extracted.quotes.length === 0) {
    return { kind: 'rejected', reason: 'no-quote', cost };
  }

  const verifiedQuotes = extracted.quotes.filter(q => verifyQuoteInContent(q, source.content));
  if (verifiedQuotes.length === 0) {
    return {
      kind: 'rejected',
      reason: 'quote-fabricated',
      cost,
      detail: { haikuQuotes: extracted.quotes },
    };
  }

  const entailment = await verifyEntailment(claim, verifiedQuotes, source.url, source.title);
  cost.entailmentCost = entailment.cost;
  if (!entailment.supports) {
    return { kind: 'rejected', reason: 'entailment-failed', cost, detail: { verifiedQuotes } };
  }

  return {
    kind: 'accepted',
    cost,
    candidate: {
      url: source.url,
      snippet: source.content.slice(0, 600),
      provider: source.provider,
      quotes: verifiedQuotes,
    },
  };
}
