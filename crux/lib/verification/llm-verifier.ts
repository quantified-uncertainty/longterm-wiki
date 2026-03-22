/**
 * LLM Verifier — call LLM for fact-checking and parse verdicts.
 *
 * Shared by records-verify and verify-orchestrate. Provides:
 * - LLM verification call with structured JSON parsing
 * - Verdict validation against allowed values
 */

import { callLlm, MODELS, type createLlmClient } from '../llm.ts';
import { parseJsonResponse } from '../anthropic.ts';
import {
  VALID_VERIFICATION_VERDICTS,
  type VerificationVerdict,
} from '../../../apps/wiki-server/src/api-types.ts';
import type { LlmVerificationResult } from './types.ts';

/**
 * Call the LLM to verify a claim/record against source text.
 *
 * @param client - LLM client instance
 * @param prompt - The full verification prompt
 * @param retryLabel - Label for retry tracking
 * @returns Parsed and validated verification result
 * @throws Error if the LLM call fails
 */
export async function callLlmForVerification(
  client: ReturnType<typeof createLlmClient>,
  prompt: string,
  retryLabel: string,
): Promise<LlmVerificationResult> {
  const result = await callLlm(client, prompt, {
    model: MODELS.haiku,
    maxTokens: 500,
    temperature: 0,
    retryLabel,
  });

  const parsed = parseJsonResponse(result.text) as {
    verdict: string;
    confidence: number;
    extracted_value: string;
    reasoning: string;
  };

  const verdict = (VALID_VERIFICATION_VERDICTS as readonly string[]).includes(parsed.verdict)
    ? parsed.verdict
    : 'unverifiable';

  return {
    verdict,
    confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
    extractedValue: parsed.extracted_value ?? '',
    reasoning: parsed.reasoning ?? '',
  };
}

/**
 * Validate a verdict string against the canonical list.
 * Returns the validated verdict or 'unverifiable' if invalid.
 */
export function validateVerdict(verdict: string): VerificationVerdict {
  return (VALID_VERIFICATION_VERDICTS as readonly string[]).includes(verdict)
    ? (verdict as VerificationVerdict)
    : 'unverifiable';
}

export { MODELS };
