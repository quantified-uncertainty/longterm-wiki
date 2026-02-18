/**
 * Shared JSON Parsing for LLM Responses (page-improver phases)
 *
 * Re-exports parseJsonFromLlm from the shared crux/lib/json-parsing.ts module,
 * and adds page-improver-specific Zod schemas and the parseAndValidate helper.
 */

import { z } from 'zod';
import { log } from '../utils.ts';
import { parseJsonFromLlm } from '../../../lib/json-parsing.ts';
export { parseJsonFromLlm } from '../../../lib/json-parsing.ts';

// ---------------------------------------------------------------------------
// Zod Schemas for LLM response validation
// ---------------------------------------------------------------------------

/** Schema for the analyze phase response. */
export const AnalysisResultSchema = z.object({
  currentState: z.string().optional(),
  gaps: z.array(z.string()).optional(),
  researchNeeded: z.array(z.string()).optional(),
  improvements: z.array(z.string()).optional(),
  entityLinks: z.array(z.string()).optional(),
  citations: z.unknown().optional(),
  objectivityIssues: z.array(z.string()).optional(),
}).passthrough();

/** Schema for the research phase response. */
export const ResearchResultSchema = z.object({
  sources: z.array(z.object({
    topic: z.string(),
    title: z.string(),
    url: z.string(),
    author: z.string().optional(),
    date: z.string().optional(),
    facts: z.array(z.string()),
    relevance: z.string(),
  })),
  summary: z.string().optional(),
}).passthrough();

/** Schema for the review phase response. */
export const ReviewResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(z.string()),
  objectivityIssues: z.array(z.string()).optional(),
  suggestions: z.array(z.string()).optional(),
  qualityScore: z.number().min(0).max(100).optional(),
}).passthrough();

/** Schema for the triage phase response. */
export const TriageResponseSchema = z.object({
  recommendedTier: z.enum(['skip', 'polish', 'standard', 'deep']),
  reason: z.string(),
  newDevelopments: z.array(z.string()),
});

/**
 * Parse and validate an LLM response against a Zod schema.
 * Returns the validated result or the fallback on failure.
 */
export function parseAndValidate<T>(
  raw: string,
  schema: z.ZodType<T>,
  phase: string,
  fallback: (raw: string, error?: string) => T,
): T {
  const parsed = parseJsonFromLlm(raw, phase, fallback);
  const result = schema.safeParse(parsed);
  if (result.success) {
    return result.data;
  }
  log(phase, `Warning: ${phase} result failed schema validation: ${result.error.message.slice(0, 200)}`);
  return parsed as T;
}
