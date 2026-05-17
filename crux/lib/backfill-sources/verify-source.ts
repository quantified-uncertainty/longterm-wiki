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
import { rememberContent } from './content-cache.ts';
import { contentMentionsEntity, isSelfDomain } from './entity-mention.ts';
import { extractSupportingQuotes, verifyEntailment } from './llm-calls.ts';
import { verifyQuoteInContent } from './prompts.ts';
import type { CandidateRecord, RankCandidate } from './types.ts';

export type RejectionReason =
  | 'invalid-url'
  | 'self-domain'
  | 'placeholder-url'
  | 'too-short'
  | 'no-entity-mention'
  | 'no-quote'
  | 'quote-fabricated'
  | 'entailment-failed';

function isHttpUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Patterns that indicate an editor-side placeholder URL (auto-saved draft,
 * preview, admin page, raw post-id). These pages aren't stable — they may
 * 404 by the time anyone clicks through, or change content arbitrarily.
 *
 * Real example seen in the wild: `https://theverge.com/news/627849/auto-draft`
 * matched against an Anthropic investment row.
 */
const PLACEHOLDER_URL_PATTERNS: RegExp[] = [
  /\/auto-draft(?:\/|$)/i,            // WordPress auto-saved draft (exact slug)
  /\/wp-admin(?:\/|$)/i,               // WordPress admin (never content)
  /[?&]p=\d+(?:&|$)/i,                 // raw WP post-id query (?p=12345)
  /\/\d{4}-\d{2}-\d{2}\/?$/i,          // date-only slug, no title segment
];
// Deliberately excluded: `/draft-*` (false-positive risk on legal/policy
// articles like "draft bill on AI safety") and `/preview/...` (real
// content directories on news/sports sites). Keep this list tight —
// false-negatives are cheaper than rejecting real sources.

export function isPlaceholderUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const pathAndQuery = url.pathname + url.search;
  return PLACEHOLDER_URL_PATTERNS.some(re => re.test(pathAndQuery));
}

/** USD spent on LLM calls during one source's verification. */
export interface VerifyCost {
  quoteExtractCost: number;
  entailmentCost: number;
}

export type VerifyResult =
  | { kind: 'accepted'; candidate: RankCandidate; cost: VerifyCost; record: CandidateRecord }
  | {
      kind: 'rejected';
      reason: RejectionReason;
      cost: VerifyCost;
      record: CandidateRecord;
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
  const record: CandidateRecord = {
    url: source.url,
    provider: source.provider,
    title: source.title,
    decision: 'rejected',
    rejection_reason: null,
    content_sha256: null,
    content_chars: null,
    quote_extraction: null,
    entailment: null,
  };

  if (!isHttpUrl(source.url)) {
    record.rejection_reason = 'invalid-url';
    return { kind: 'rejected', reason: 'invalid-url', cost, record };
  }

  if (isSelfDomain(source.url)) {
    record.rejection_reason = 'self-domain';
    return { kind: 'rejected', reason: 'self-domain', cost, record };
  }

  if (isPlaceholderUrl(source.url)) {
    record.rejection_reason = 'placeholder-url';
    return { kind: 'rejected', reason: 'placeholder-url', cost, record };
  }

  if (source.content.length < MIN_CONTENT_LENGTH) {
    record.rejection_reason = 'too-short';
    return { kind: 'rejected', reason: 'too-short', cost, record };
  }

  const missingSlots = mentionTargets.filter(
    variants => !variants.some(v => contentMentionsEntity(source.content, v, source.url)),
  );
  if (missingSlots.length > 0) {
    record.rejection_reason = 'no-entity-mention';
    record.missing_slots = missingSlots;
    return { kind: 'rejected', reason: 'no-entity-mention', cost, record, detail: { missingSlots } };
  }

  // Persist the exact text the judges saw before any LLM call so the
  // call can be replayed byte-for-byte after the run.
  record.content_sha256 = rememberContent(source.content);
  record.content_chars = source.content.length;

  const extracted = await extractSupportingQuotes(claim, entityName, source.content);
  cost.quoteExtractCost = extracted.cost;
  const haikuVerified = extracted.quotes.filter(q => verifyQuoteInContent(q, source.content));
  record.quote_extraction = {
    haiku: {
      raw_text: extracted.rawText,
      quotes: extracted.quotes,
      duration_ms: extracted.durationMs,
    },
    haiku_verified_quotes: haikuVerified,
    vllm: extracted.vllm
      ? {
          raw_text: extracted.vllm.raw_text,
          quotes: extracted.vllm.quotes,
          verified_quotes: extracted.vllm.quotes.filter(q => verifyQuoteInContent(q, source.content)),
          duration_ms: extracted.vllm.duration_ms,
        }
      : null,
  };
  if (extracted.quotes.length === 0) {
    record.rejection_reason = 'no-quote';
    return { kind: 'rejected', reason: 'no-quote', cost, record };
  }

  if (haikuVerified.length === 0) {
    record.rejection_reason = 'quote-fabricated';
    return {
      kind: 'rejected',
      reason: 'quote-fabricated',
      cost,
      record,
      detail: { haikuQuotes: extracted.quotes },
    };
  }

  const entailment = await verifyEntailment(claim, haikuVerified, source.url, source.title);
  cost.entailmentCost = entailment.cost;
  record.entailment = {
    sonnet: {
      raw_text: entailment.rawText,
      supports: entailment.supports,
      duration_ms: entailment.durationMs,
    },
    vllm: entailment.vllm
      ? {
          raw_text: entailment.vllm.raw_text,
          decision:
            entailment.vllm.supports === true
              ? 'supports'
              : entailment.vllm.supports === false
                ? 'no-support'
                : 'unparseable',
          duration_ms: entailment.vllm.duration_ms,
        }
      : null,
  };
  if (!entailment.supports) {
    record.rejection_reason = 'entailment-failed';
    return { kind: 'rejected', reason: 'entailment-failed', cost, record, detail: { verifiedQuotes: haikuVerified } };
  }

  record.decision = 'accepted';
  record.rejection_reason = null;
  return {
    kind: 'accepted',
    cost,
    record,
    candidate: {
      url: source.url,
      snippet: source.content.slice(0, 600),
      provider: source.provider,
      quotes: haikuVerified,
    },
  };
}
