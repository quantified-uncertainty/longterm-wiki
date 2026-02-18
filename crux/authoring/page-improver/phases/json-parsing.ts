/**
 * Shared JSON Parsing for LLM Responses
 *
 * Centralizes the try/catch JSON.parse pattern used across all phases.
 * Provides type-safe parsing with structured fallbacks.
 */

import { z } from 'zod';
import { log } from '../utils.ts';

/**
 * Attempt to recover a partial JSON object from a truncated string.
 *
 * Walks the string character-by-character tracking bracket/brace depth and
 * string context.  When we find the outermost closing brace/bracket we stop,
 * so the returned slice is the longest complete JSON value starting from
 * `startIdx`.  Returns null if no complete value can be found.
 */
function extractLongestCompleteJson(text: string, startIdx: number): string | null {
  const opener = text[startIdx];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === opener || ch === '[' || ch === '{') depth++;
    else if (ch === closer || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null; // Truncated — no closing brace/bracket found
}

/**
 * Extract complete objects from a potentially-truncated JSON array.
 * Useful for recovering partial research source lists.
 */
function extractPartialArray(text: string): unknown[] {
  const arrayStart = text.indexOf('[');
  if (arrayStart === -1) return [];

  const results: unknown[] = [];
  let i = arrayStart + 1;

  while (i < text.length) {
    // Skip whitespace and commas
    while (i < text.length && (text[i] === ',' || text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++;
    if (i >= text.length || text[i] === ']') break;
    if (text[i] !== '{') break; // Unexpected token — give up

    const fragment = extractLongestCompleteJson(text, i);
    if (!fragment) break; // Truncated — stop here
    try {
      results.push(JSON.parse(fragment));
      i += fragment.length;
    } catch {
      break;
    }
  }

  return results;
}

/**
 * Parse a JSON object from an LLM response string.
 * Handles markdown code blocks, extra text before/after JSON, and parse errors.
 * Falls back to partial extraction for truncated responses (e.g. long research results).
 *
 * @param raw - The raw LLM response string
 * @param phase - Phase name for logging
 * @param fallback - Function that creates a fallback value on parse failure
 */
export function parseJsonFromLlm<T>(
  raw: string,
  phase: string,
  fallback: (raw: string, error?: string) => T,
): T {
  // Strip markdown code fences if present
  const stripped = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim();

  // Strategy 1: standard parse of the outermost {} block
  const firstBrace = stripped.indexOf('{');
  if (firstBrace !== -1) {
    const complete = extractLongestCompleteJson(stripped, firstBrace);
    if (complete) {
      try {
        return JSON.parse(complete);
      } catch {
        // fall through to strategy 2
      }
    }

    // Strategy 2: the object is truncated — try to salvage individual fields
    // Build a best-effort object: extract any "key": <value> pairs that parsed
    const truncated = stripped.slice(firstBrace);
    const partial: Record<string, unknown> = {};

    // Extract "sources" array if present (most important field for research phase)
    const sourcesMatch = truncated.match(/"sources"\s*:\s*(\[[\s\S]*)/);
    if (sourcesMatch) {
      const partialSources = extractPartialArray(sourcesMatch[1]);
      if (partialSources.length > 0) {
        partial.sources = partialSources;
        log(phase, `Warning: Truncated JSON in ${phase} — recovered ${partialSources.length} items from partial array`);
      }
    }

    // Extract simple string fields: "key": "value"
    for (const m of truncated.matchAll(/"(\w+)"\s*:\s*"([^"\\]*)"/g)) {
      if (m[1] !== 'sources') partial[m[1]] = m[2];
    }

    if (Object.keys(partial).length > 0) {
      return partial as T;
    }
  }

  // Strategy 3: plain JSON.parse of the raw string
  try {
    return JSON.parse(stripped);
  } catch {
    // fall through to fallback
  }

  const errorMsg = `Could not parse ${phase} result as JSON (response may have been truncated)`;
  log(phase, `Warning: ${errorMsg}`);
  return fallback(raw, errorMsg);
}

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
