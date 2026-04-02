/**
 * LLM Source-Checker — call LLM for source-checking claims and parse verdicts.
 *
 * Shared by factbase-source-check and source-check-orchestrate. Provides:
 * - LLM source-check call with structured JSON parsing
 * - Verdict validation against allowed values
 */

import { z } from 'zod';
import { callLlm, MODELS, type createLlmClient } from '../llm.ts';
import { parseJsonResponse } from '../anthropic.ts';
import {
  VALID_SOURCE_CHECK_VERDICTS,
  type SourceCheckVerdict,
} from '../../../apps/wiki-server/src/api-types.ts';
import type { LlmSourceCheckResult } from './types.ts';

export const LlmResponseSchema = z.object({
  verdict: z.string().default('unverifiable'),
  confidence: z.number().min(0).max(1).default(0.5),
  extracted_value: z.string().default(''),
  reasoning: z.string().default(''),
});

/**
 * Call the LLM to source-check a claim/record against source text.
 *
 * @param client - LLM client instance
 * @param prompt - The full source-check prompt
 * @param retryLabel - Label for retry tracking
 * @returns Parsed and validated source-check result
 * @throws Error if the LLM call fails
 */
export async function callLlmForSourceCheck(
  client: ReturnType<typeof createLlmClient>,
  prompt: string,
  retryLabel: string,
): Promise<LlmSourceCheckResult> {
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

  const verdict = (VALID_SOURCE_CHECK_VERDICTS as readonly string[]).includes(parsed.data.verdict)
    ? parsed.data.verdict
    : 'unverifiable';

  return {
    verdict,
    confidence: parsed.data.confidence,
    extractedValue: parsed.data.extracted_value,
    reasoning: parsed.data.reasoning,
  };
}

/**
 * Validate a verdict string against the canonical list.
 * Returns the validated verdict or 'unverifiable' if invalid.
 */
export function validateVerdict(verdict: string): SourceCheckVerdict {
  return (VALID_SOURCE_CHECK_VERDICTS as readonly string[]).includes(verdict)
    ? (verdict as SourceCheckVerdict)
    : 'unverifiable';
}

export { MODELS };
