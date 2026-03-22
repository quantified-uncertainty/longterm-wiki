/**
 * LLM Source-Checker — call LLM for source-checking claims and parse verdicts.
 *
 * Shared by factbase-source-check and source-check-orchestrate. Provides:
 * - LLM source-check call with structured JSON parsing
 * - Verdict validation against allowed values
 */

import { callLlm, MODELS, type createLlmClient } from '../llm.ts';
import { parseJsonResponse } from '../anthropic.ts';
import {
  VALID_SOURCE_CHECK_VERDICTS,
  type SourceCheckVerdict,
} from '../../../apps/wiki-server/src/api-types.ts';
import type { LlmSourceCheckResult } from './types.ts';

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

  const parsed = parseJsonResponse(result.text) as {
    verdict: string;
    confidence: number;
    extracted_value: string;
    reasoning: string;
  };

  const verdict = (VALID_SOURCE_CHECK_VERDICTS as readonly string[]).includes(parsed.verdict)
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
export function validateVerdict(verdict: string): SourceCheckVerdict {
  return (VALID_SOURCE_CHECK_VERDICTS as readonly string[]).includes(verdict)
    ? (verdict as SourceCheckVerdict)
    : 'unverifiable';
}

export { MODELS };
