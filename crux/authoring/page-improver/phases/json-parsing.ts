/**
 * Shared JSON Parsing for LLM Responses (page-improver phases)
 *
 * Re-exports parseJsonFromLlm and parseAndValidate from the shared
 * crux/lib/json-parsing.ts module, and adds page-improver-specific Zod
 * schemas.
 */

import { z } from 'zod';
export { parseJsonFromLlm, parseAndValidate } from '../../../lib/json-parsing.ts';

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
    facts: z.array(z.string()).optional().default([]),
    relevance: z.string().optional().default('unknown'),
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

/** Schema for a single gap in the adversarial review response. */
export const AdversarialGapSchema = z.object({
  type: z.enum(['fact-density', 'speculation', 'missing-standard-data', 'redundancy', 'source-gap']),
  description: z.string().min(1),
  reResearchQuery: z.string().optional(),
  actionType: z.enum(['re-research', 'edit', 'none']),
});

/** Schema for the adversarial review phase response. */
export const AdversarialReviewResultSchema = z.object({
  gaps: z.array(AdversarialGapSchema),
  needsReResearch: z.boolean(),
  reResearchQueries: z.array(z.string()),
  overallAssessment: z.string(),
}).passthrough();

