/**
 * Contradiction Checker
 *
 * Detects factual contradictions between new claims added to a page
 * and the existing claims on the same page (or cross-page).
 *
 * Uses two strategies:
 * 1. Rule-based: numeric contradiction detection using keyValue comparison
 *    (fast, deterministic, catches obvious cases like "50 employees" vs "200 employees")
 * 2. LLM-based: Haiku semantic contradiction detection for complex contradictions
 *    (slower, catches nuanced contradictions)
 *
 * The LLM check only runs on added/changed claims, keeping cost minimal.
 */

import { jaccardWordSimilarity } from '../claim-utils.ts';
import { createLlmClient, callLlm, MODELS } from '../llm.ts';
import { parseJsonFromLlm } from '../json-parsing.ts';
import type {
  ExtractedClaim,
  Contradiction,
  ContradictionResult,
  ContradictionSeverity,
} from './types.ts';

// ---------------------------------------------------------------------------
// Rule-based contradiction detection
// ---------------------------------------------------------------------------

/**
 * Extract a numeric value from a claim's keyValue or text.
 * Returns undefined if no numeric value can be parsed.
 */
function parseNumericFromClaim(claim: ExtractedClaim): number | undefined {
  const source = claim.keyValue ?? '';
  if (!source) return undefined;

  // Remove commas and try to parse
  const cleaned = source.replace(/[$,]/g, '').trim();
  const value = parseFloat(cleaned);
  return isFinite(value) ? value : undefined;
}

/**
 * Check if two claims are about the same subject based on text similarity.
 * Higher threshold means we only flag contradictions when claims are clearly
 * talking about the same thing.
 */
function areClaimsAboutSameSubject(a: ExtractedClaim, b: ExtractedClaim): boolean {
  return jaccardWordSimilarity(a.text, b.text) >= 0.4;
}

/**
 * Detect rule-based numeric contradictions.
 * If two similar claims have different numeric keyValues, that's likely a contradiction.
 */
function detectNumericContradictions(
  newClaims: ExtractedClaim[],
  existingClaims: ExtractedClaim[],
): Contradiction[] {
  const contradictions: Contradiction[] = [];

  const numericNew = newClaims.filter(c => c.type === 'numeric' && c.keyValue);
  const numericExisting = existingClaims.filter(c => c.type === 'numeric' && c.keyValue);

  for (const newClaim of numericNew) {
    for (const existing of numericExisting) {
      if (!areClaimsAboutSameSubject(newClaim, existing)) continue;

      const newVal = parseNumericFromClaim(newClaim);
      const existVal = parseNumericFromClaim(existing);

      if (newVal !== undefined && existVal !== undefined && newVal !== existVal) {
        // Calculate how different the values are
        const ratio = Math.max(newVal, existVal) / Math.min(newVal, existVal);
        const severity: ContradictionSeverity =
          ratio >= 2 ? 'high' : ratio >= 1.2 ? 'medium' : 'low';

        contradictions.push({
          newClaim,
          existingClaim: existing,
          reason: `Numeric value mismatch: new claim has "${newClaim.keyValue}", existing has "${existing.keyValue}"`,
          severity,
        });
      }
    }
  }

  return contradictions;
}

/**
 * Detect temporal contradictions (different years/dates for the same event).
 */
function detectTemporalContradictions(
  newClaims: ExtractedClaim[],
  existingClaims: ExtractedClaim[],
): Contradiction[] {
  const contradictions: Contradiction[] = [];

  const temporalNew = newClaims.filter(c => c.type === 'temporal' && c.keyValue);
  const temporalExisting = existingClaims.filter(c => c.type === 'temporal' && c.keyValue);

  for (const newClaim of temporalNew) {
    for (const existing of temporalExisting) {
      if (!areClaimsAboutSameSubject(newClaim, existing)) continue;
      if (newClaim.keyValue === existing.keyValue) continue;

      // Year-based comparison for temporal claims
      const newYear = parseInt(newClaim.keyValue ?? '', 10);
      const existYear = parseInt(existing.keyValue ?? '', 10);

      if (!isNaN(newYear) && !isNaN(existYear) && newYear !== existYear) {
        contradictions.push({
          newClaim,
          existingClaim: existing,
          reason: `Temporal mismatch: new claim says "${newClaim.keyValue}", existing says "${existing.keyValue}"`,
          severity: 'high',
        });
      }
    }
  }

  return contradictions;
}

// ---------------------------------------------------------------------------
// LLM-based contradiction detection
// ---------------------------------------------------------------------------

const CONTRADICTION_SYSTEM_PROMPT = `You are a fact-checker for an AI safety wiki. Your job is to detect factual contradictions between new claims and existing claims.

A contradiction is when two claims assert incompatible facts about the same subject:
- "OpenAI was founded in 2015" contradicts "OpenAI was founded in 2019"
- "The organization has 300 employees" contradicts "The organization employs 50 people"
- "X is the CEO of Y" contradicts "X was fired from Y in 2023"

NOT contradictions:
- Claims about different time periods ("had 50 employees in 2020" vs "has 300 employees now")
- Claims about different subjects
- Vague vs specific statements (vague doesn't contradict specific)
- Complementary information

Output valid JSON:
{
  "contradictions": [
    {
      "newClaimIndex": 0,
      "existingClaimIndex": 1,
      "reason": "Why these contradict",
      "severity": "high|medium|low"
    }
  ]
}

Return an empty contradictions array if no contradictions are found.`;

interface RawContradiction {
  newClaimIndex?: unknown;
  existingClaimIndex?: unknown;
  reason?: unknown;
  severity?: unknown;
}

interface LlmContradictionResult {
  contradictions: RawContradiction[];
}

/**
 * Use Haiku to detect semantic contradictions between new and existing claims.
 * Only called for added/changed claims to keep costs low.
 */
async function detectLlmContradictions(
  newClaims: ExtractedClaim[],
  existingClaims: ExtractedClaim[],
): Promise<Contradiction[]> {
  if (newClaims.length === 0 || existingClaims.length === 0) return [];

  // Limit claim counts to keep prompt size manageable
  const limitedNew = newClaims.slice(0, 20);
  const limitedExisting = existingClaims.slice(0, 30);

  const client = createLlmClient();

  const prompt = `Check these NEW claims against EXISTING claims for contradictions.

NEW CLAIMS (just added/changed):
${limitedNew.map((c, i) => `[${i}] ${c.text}${c.keyValue ? ` (key value: ${c.keyValue})` : ''}`).join('\n')}

EXISTING CLAIMS (already in the page):
${limitedExisting.map((c, i) => `[${i}] ${c.text}${c.keyValue ? ` (key value: ${c.keyValue})` : ''}`).join('\n')}

Find any contradictions between the NEW claims and EXISTING claims. Return JSON.`;

  const result = await callLlm(client, {
    system: CONTRADICTION_SYSTEM_PROMPT,
    user: prompt,
  }, {
    model: MODELS.haiku,
    maxTokens: 1500,
    retryLabel: 'contradiction-check',
  });

  const parsed = parseJsonFromLlm<LlmContradictionResult>(
    result.text,
    'contradiction-check',
    (raw, err) => {
      console.warn(
        `[semantic-diff] Failed to parse contradiction check response: ${err ?? 'unknown error'}. Raw (first 200): ${raw.slice(0, 200)}`
      );
      return { contradictions: [] };
    },
  );

  if (!parsed.contradictions || !Array.isArray(parsed.contradictions)) {
    return [];
  }

  const validSeverities = new Set<ContradictionSeverity>(['high', 'medium', 'low']);

  return parsed.contradictions
    .filter((c): c is RawContradiction =>
      typeof c.newClaimIndex === 'number' &&
      typeof c.existingClaimIndex === 'number' &&
      typeof c.reason === 'string',
    )
    .map(c => {
      const newClaimIdx = c.newClaimIndex as number;
      const existingClaimIdx = c.existingClaimIndex as number;

      const newClaim = limitedNew[newClaimIdx];
      const existingClaim = limitedExisting[existingClaimIdx];

      if (!newClaim || !existingClaim) return null;

      const severity: ContradictionSeverity = validSeverities.has(c.severity as ContradictionSeverity)
        ? (c.severity as ContradictionSeverity)
        : 'medium';

      return {
        newClaim,
        existingClaim,
        reason: c.reason as string,
        severity,
      };
    })
    .filter((c): c is Contradiction => c !== null);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ContradictionCheckOptions {
  /** Whether to use LLM-based semantic contradiction detection. Default: true. */
  useLlm?: boolean;
  /** Whether to use rule-based numeric contradiction detection. Default: true. */
  useRules?: boolean;
}

/**
 * Check for contradictions between new claims and existing claims.
 *
 * Runs both rule-based and LLM-based checks (by default) and merges results.
 * Deduplicates any contradictions caught by both methods.
 *
 * @param newClaims - Claims that were added or changed in the new version
 * @param existingClaims - Claims from the existing (before) version of the page
 * @param options - Configuration for which checks to run
 */
export async function checkContradictions(
  newClaims: ExtractedClaim[],
  existingClaims: ExtractedClaim[],
  options: ContradictionCheckOptions = {},
): Promise<ContradictionResult> {
  const { useLlm = true, useRules = true } = options;

  const allContradictions: Contradiction[] = [];

  // Rule-based checks (fast, free)
  if (useRules) {
    const numericContradictions = detectNumericContradictions(newClaims, existingClaims);
    const temporalContradictions = detectTemporalContradictions(newClaims, existingClaims);
    allContradictions.push(...numericContradictions, ...temporalContradictions);
  }

  // LLM-based checks (slower, costs Haiku tokens)
  if (useLlm) {
    try {
      const llmContradictions = await detectLlmContradictions(newClaims, existingClaims);

      // Deduplicate: skip LLM findings that already caught by rule-based
      for (const llmContra of llmContradictions) {
        const alreadyCaught = allContradictions.some(
          existing =>
            existing.newClaim.text === llmContra.newClaim.text &&
            existing.existingClaim.text === llmContra.existingClaim.text,
        );
        if (!alreadyCaught) {
          allContradictions.push(llmContra);
        }
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.warn(`[semantic-diff] LLM contradiction check failed: ${error.message}`);
      // Continue with rule-based results only
    }
  }

  const summary = {
    high: allContradictions.filter(c => c.severity === 'high').length,
    medium: allContradictions.filter(c => c.severity === 'medium').length,
    low: allContradictions.filter(c => c.severity === 'low').length,
  };

  return {
    contradictions: allContradictions,
    hasHighSeverity: summary.high > 0,
    summary,
  };
}
