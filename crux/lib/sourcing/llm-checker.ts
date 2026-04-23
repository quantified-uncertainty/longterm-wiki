/**
 * LLM Source-Checker — call LLM for sourcing claims and parse verdicts.
 *
 * Shared by factbase-sourcing and sourcing-orchestrate. Provides:
 * - LLM sourcing call with structured JSON parsing
 * - Verdict validation against allowed values
 */

import { z } from 'zod';
import { callLlm, MODELS, type createLlmClient } from '../llm.ts';
import { parseJsonResponse } from '../anthropic.ts';
import {
  VALID_SOURCE_CHECK_VERDICTS,
  type SourcingVerdict,
} from '../../../apps/wiki-server/src/api-types.ts';
import type { LlmSourcingResult } from './types.ts';

export const LlmResponseSchema = z.object({
  verdict: z.string().default('unverifiable'),
  confidence: z.number().min(0).max(1).default(0.5),
  extracted_value: z.string().default(''),
  reasoning: z.string().default(''),
  // QUA-648: the LLM names the source's actual subject and flags if it diverges from the claim.
  // Both fields are optional for backward compat — pre-QUA-648 prompts don't request them.
  source_subject: z.string().default(''),
  subject_matches_claim: z.boolean().optional(),
});

/**
 * Call the LLM to sourcing a claim/record against source text.
 *
 * @param client - LLM client instance
 * @param prompt - The full sourcing prompt
 * @param retryLabel - Label for retry tracking
 * @returns Parsed and validated sourcing result
 * @throws Error if the LLM call fails
 */
export async function callLlmForSourcing(
  client: ReturnType<typeof createLlmClient>,
  prompt: string,
  retryLabel: string,
): Promise<LlmSourcingResult> {
  const result = await callLlm(client, prompt, {
    model: MODELS.haiku,
    maxTokens: 500,
    temperature: 0,
    retryLabel,
  });

  const raw = parseJsonResponse(result.text);
  const parsed = LlmResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      verdict: 'unverifiable',
      confidence: 0.5,
      extractedValue: '',
      reasoning: `LLM response failed validation: ${parsed.error.message}`,
    };
  }

  let verdict = (VALID_SOURCE_CHECK_VERDICTS as readonly string[]).includes(parsed.data.verdict)
    ? parsed.data.verdict
    : 'unverifiable';
  let reasoning = parsed.data.reasoning;

  // QUA-648: defense-in-depth downgrade. The prompt instructs the LLM to
  // return `subject_matches_claim: false` when the source is about a
  // materially different entity than the claim (e.g. Microsoft AI vs.
  // Microsoft), in which case `confirmed` must be downgraded to `partial`.
  // The prompt also forbids the combination, but the LLM has shipped
  // `confirmed` + mismatch anyway (see QUA-648 case study), so we enforce
  // the rule here too. The downgrade is only applied to `confirmed` — if
  // the LLM already chose `partial`/`unverifiable`/etc., the verdict stands.
  if (
    parsed.data.subject_matches_claim === false &&
    verdict === 'confirmed'
  ) {
    verdict = 'partial';
    const mismatchNote = parsed.data.source_subject
      ? `[subject-mismatch: source is about "${parsed.data.source_subject}", not the claim's subject] `
      : '[subject-mismatch: LLM flagged source subject as different from claim subject] ';
    reasoning = `${mismatchNote}${reasoning}`;
  }

  return {
    verdict,
    confidence: parsed.data.confidence,
    extractedValue: parsed.data.extracted_value,
    reasoning,
    sourceSubject: parsed.data.source_subject || undefined,
    subjectMatchesClaim: parsed.data.subject_matches_claim,
  };
}

/**
 * Validate a verdict string against the canonical list.
 * Returns the validated verdict or 'unverifiable' if invalid.
 */
export function validateVerdict(verdict: string): SourcingVerdict {
  return (VALID_SOURCE_CHECK_VERDICTS as readonly string[]).includes(verdict)
    ? (verdict as SourcingVerdict)
    : 'unverifiable';
}

export { MODELS };
