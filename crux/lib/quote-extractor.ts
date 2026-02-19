/**
 * LLM Quote Extraction
 *
 * Given a wiki claim and the full text of a source, uses an LLM to identify
 * the specific passage in the source that supports the claim.
 *
 * Uses OpenRouter (Gemini Flash) for cost efficiency.
 */

import { getApiKey } from './api-keys.ts';
import { withRetry } from './resilience.ts';

const OPENROUTER_API_KEY = getApiKey('OPENROUTER_API_KEY');
const BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** Default LLM model for citation operations. Exported so other modules can reference it. */
export const DEFAULT_CITATION_MODEL = 'google/gemini-2.0-flash-001';
const MAX_SOURCE_CHARS = 50_000;

export interface QuoteExtractionResult {
  quote: string;
  location: string;
  confidence: number;
}

export type AccuracyVerdict = 'accurate' | 'minor_issues' | 'inaccurate' | 'unsupported' | 'not_verifiable';

export const VALID_ACCURACY_VERDICTS: readonly AccuracyVerdict[] = [
  'accurate', 'minor_issues', 'inaccurate', 'unsupported', 'not_verifiable',
] as const;

export interface AccuracyCheckResult {
  verdict: AccuracyVerdict;
  score: number;
  issues: string[];
  supportingQuotes: string[];
  /** How hard it was to verify — describes what level of source access is needed */
  verificationDifficulty: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const VALID_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;

/** Normalize LLM difficulty output to one of the valid categories. */
function normalizeDifficulty(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return '';
  const lower = raw.toLowerCase().trim();
  // Exact match
  if (VALID_DIFFICULTIES.includes(lower as typeof VALID_DIFFICULTIES[number])) return lower;
  // Fuzzy match — look for keyword in longer descriptions
  if (lower.includes('easy') || lower.includes('single sentence') || lower.includes('directly stated')) return 'easy';
  if (lower.includes('hard') || lower.includes('entire') || lower.includes('multiple sections')) return 'hard';
  if (lower.includes('medium') || lower.includes('combine') || lower.includes('several')) return 'medium';
  return 'medium'; // default if unrecognizable
}

/** Truncate source text to MAX_SOURCE_CHARS, adding a truncation marker. */
export function truncateSource(text: string): string {
  return text.length > MAX_SOURCE_CHARS
    ? text.slice(0, MAX_SOURCE_CHARS) + '\n\n[... truncated ...]'
    : text;
}

/** Strip markdown code fences from LLM JSON responses. */
export function stripCodeFences(content: string): string {
  return content
    .replace(/^```json\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

interface OpenRouterChatResponse {
  choices: Array<{ message: { content: string } }>;
  error?: { message: string };
}

/**
 * Call OpenRouter chat completions API. Shared by both quote extraction and
 * accuracy checking to avoid duplicating request/error handling logic.
 */
export async function callOpenRouter(
  systemPrompt: string,
  userPrompt: string,
  opts: { model?: string; maxTokens?: number; title?: string } = {},
): Promise<string> {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY not set — required for citation operations');
  }

  const model = opts.model || DEFAULT_CITATION_MODEL;

  return withRetry(
    async () => {
      const response = await fetch(BASE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://www.longtermwiki.com',
          'X-Title': opts.title || 'LongtermWiki Citations',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: opts.maxTokens || 2000,
          temperature: 0,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `OpenRouter API error (${response.status}): ${errorBody.slice(0, 200)}`,
        );
      }

      const data = (await response.json()) as OpenRouterChatResponse;

      if (data.error) {
        throw new Error(`OpenRouter error: ${data.error.message}`);
      }

      return data.choices?.[0]?.message?.content || '';
    },
    { maxRetries: 2, label: `OpenRouter ${opts.title || ''}` },
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract the specific supporting quote from a source for a given wiki claim.
 *
 * @param claimText - The claim from the wiki page (sentence containing the footnote)
 * @param sourceText - The full text content of the cited source
 * @param opts - Optional model override
 * @returns The extracted quote, its approximate location, and a confidence score
 */
export async function extractSupportingQuote(
  claimText: string,
  sourceText: string,
  opts?: { model?: string },
): Promise<QuoteExtractionResult> {
  const truncatedSource = truncateSource(sourceText);

  const systemPrompt = `You are a citation verification assistant. Given a claim from a wiki article and the full text of a cited source, find the specific passage in the source that most directly supports the claim.

Rules:
- Return the EXACT quote from the source text (copy it verbatim, do not paraphrase)
- The quote should be the most specific, relevant passage — typically 1-3 sentences
- If the source doesn't support the claim, return an empty quote
- For "location", describe where in the source the quote appears (e.g., "Introduction", "Section 3", "paragraph 5", "near the beginning")
- For "confidence", rate 0.0-1.0 how well the quote supports the claim (0.0 = no support, 1.0 = exact match)

Respond in exactly this JSON format:
{"quote": "exact text from source", "location": "where in document", "confidence": 0.85}`;

  const userPrompt = `WIKI CLAIM:
${claimText}

SOURCE TEXT:
${truncatedSource}

Find the specific passage in the source that supports this claim. Return JSON only.`;

  const content = await callOpenRouter(systemPrompt, userPrompt, {
    model: opts?.model,
    maxTokens: 1000,
    title: 'LongtermWiki Citation Quotes',
  });

  return parseQuoteExtractionResponse(content);
}

/** Parse the LLM response for quote extraction. Exported for testing. */
export function parseQuoteExtractionResponse(content: string): QuoteExtractionResult {
  const jsonStr = stripCodeFences(content);

  try {
    const parsed = JSON.parse(jsonStr) as {
      quote?: string;
      location?: string;
      confidence?: number;
    };
    return {
      quote: parsed.quote || '',
      location: parsed.location || 'unknown',
      confidence:
        typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0,
    };
  } catch {
    return {
      quote: '',
      location: 'unknown',
      confidence: 0,
    };
  }
}

/**
 * Check whether a wiki claim accurately represents what the cited source says.
 *
 * This is the "second pass" — given the full source text, the LLM finds ALL
 * relevant passages (could be multiple paragraphs from different sections)
 * and checks the wiki claim's factual accuracy against everything the source contains.
 *
 * @param claimText - The wiki claim to check
 * @param sourceText - Full text of the cited source (or the extracted quote as fallback)
 * @param opts.sourceTitle - Title of the source for context
 * @param opts.model - LLM model override
 */
export async function checkClaimAccuracy(
  claimText: string,
  sourceText: string,
  opts?: { model?: string; sourceTitle?: string },
): Promise<AccuracyCheckResult> {
  const truncatedSource = truncateSource(sourceText);
  const sourceContext = opts?.sourceTitle ? `\nSource title: "${opts.sourceTitle}"` : '';

  const systemPrompt = `You are a fact-checking assistant. Given a claim from a wiki article and the full text of the cited source, determine whether the wiki claim ACCURATELY represents what the source says.

Your task:
1. First, search the ENTIRE source for ALL passages relevant to the claim. The supporting evidence may be spread across multiple paragraphs or sections. Collect every relevant passage.
2. Then, check every specific factual detail in the wiki claim against those passages.

Check for these specific issues:
1. WRONG NUMBERS: dates, percentages, dollar amounts, counts that differ between claim and source
2. WRONG ATTRIBUTION: claim attributes a statement to the wrong person/organization
3. MISLEADING PARAPHRASE: claim distorts the meaning or emphasis of the source
4. OVERCLAIMS: claim states something more definitively than the source supports
5. FABRICATED DETAILS: claim includes specific details not in the source at all

Rules:
- Search the FULL source text thoroughly — relevant info may be in different sections
- Only flag an issue if you've checked the entire source and the detail truly isn't there
- Be strict about numbers, dates, and names — even small discrepancies matter
- "accurate" = claim faithfully represents the source (minor wording differences are OK)
- "minor_issues" = small discrepancies that don't change the core meaning (e.g., rounding)
- "inaccurate" = claim misrepresents what the source says in a meaningful way
- "unsupported" = the source genuinely doesn't contain information supporting this claim
- "not_verifiable" = source is too short or ambiguous to check
- For "score", rate 0.0-1.0 (1.0 = perfectly accurate, 0.0 = completely wrong)
- For "issues", list each specific discrepancy found. Be concise but precise.
- For "supporting_quotes", include the key passages from the source that you used to verify the claim. Include enough context to confirm each factual detail. Multiple quotes are encouraged.
- For "verification_difficulty", use exactly one of these categories: "easy" (single sentence/paragraph confirms the claim), "medium" (need to combine info from multiple sections), "hard" (need to read most/all of the source, or claim involves subtle interpretation)

Respond in exactly this JSON format:
{"verdict": "accurate", "score": 0.95, "issues": [], "supporting_quotes": ["passage 1", "passage 2"], "verification_difficulty": "easy"}`;

  const userPrompt = `WIKI CLAIM:
${claimText}
${sourceContext}
SOURCE TEXT:
${truncatedSource}

Search the entire source for all passages relevant to this claim, then check every factual detail. Return JSON only.`;

  const content = await callOpenRouter(systemPrompt, userPrompt, {
    model: opts?.model,
    maxTokens: 2000,
    title: 'LongtermWiki Accuracy Check',
  });

  return parseAccuracyCheckResponse(content);
}

/** Parse the LLM response for accuracy checking. Exported for testing. */
export function parseAccuracyCheckResponse(content: string): AccuracyCheckResult {
  const jsonStr = stripCodeFences(content);

  try {
    const parsed = JSON.parse(jsonStr) as {
      verdict?: string;
      score?: number;
      issues?: string[];
      supporting_quotes?: string[];
      verification_difficulty?: string;
    };

    const verdict = VALID_ACCURACY_VERDICTS.includes(parsed.verdict as AccuracyVerdict)
      ? (parsed.verdict as AccuracyVerdict)
      : 'not_verifiable';

    return {
      verdict,
      score: typeof parsed.score === 'number' ? Math.max(0, Math.min(1, parsed.score)) : 0.5,
      issues: Array.isArray(parsed.issues) ? parsed.issues.filter((i) => typeof i === 'string' && i.length > 0) : [],
      supportingQuotes: Array.isArray(parsed.supporting_quotes) ? parsed.supporting_quotes.filter((q) => typeof q === 'string' && q.length > 0) : [],
      verificationDifficulty: normalizeDifficulty(parsed.verification_difficulty),
    };
  } catch {
    return {
      verdict: 'not_verifiable',
      score: 0.5,
      issues: ['Failed to parse LLM response'],
      supportingQuotes: [],
      verificationDifficulty: '',
    };
  }
}
