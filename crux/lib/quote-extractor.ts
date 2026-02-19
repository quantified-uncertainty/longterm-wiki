/**
 * LLM Quote Extraction
 *
 * Given a wiki claim and the full text of a source, uses an LLM to identify
 * the specific passage in the source that supports the claim.
 *
 * Uses OpenRouter (Sonnet via OpenRouter or Gemini Flash) for cost efficiency.
 */

import { getApiKey } from './api-keys.ts';

const OPENROUTER_API_KEY = getApiKey('OPENROUTER_API_KEY');
const BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Default to a cheap but capable model
const DEFAULT_MODEL = 'google/gemini-2.0-flash-001';
const MAX_SOURCE_CHARS = 50_000;

export interface QuoteExtractionResult {
  quote: string;
  location: string;
  confidence: number;
}

export type AccuracyVerdict = 'accurate' | 'minor_issues' | 'inaccurate' | 'unsupported' | 'not_verifiable';

export interface AccuracyCheckResult {
  verdict: AccuracyVerdict;
  score: number;
  issues: string[];
  supportingQuotes: string[];
  /** How hard it was to verify — describes what level of source access is needed */
  verificationDifficulty: string;
}

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
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY not set — required for quote extraction');
  }

  // Truncate source text if too long
  const truncatedSource =
    sourceText.length > MAX_SOURCE_CHARS
      ? sourceText.slice(0, MAX_SOURCE_CHARS) + '\n\n[... truncated ...]'
      : sourceText;

  const model = opts?.model || DEFAULT_MODEL;

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

  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://www.longtermwiki.com',
      'X-Title': 'LongtermWiki Citation Quotes',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 1000,
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `OpenRouter API error (${response.status}): ${errorBody.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    error?: { message: string };
  };

  if (data.error) {
    throw new Error(`OpenRouter error: ${data.error.message}`);
  }

  const content = data.choices?.[0]?.message?.content || '';

  // Parse the JSON response — handle markdown code blocks
  const jsonStr = content
    .replace(/^```json\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

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
    // If JSON parsing fails, try to extract quote from the response
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
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY not set — required for accuracy checking');
  }

  const model = opts?.model || DEFAULT_MODEL;
  const sourceContext = opts?.sourceTitle ? `\nSource title: "${opts.sourceTitle}"` : '';

  // Truncate source if very long
  const truncatedSource =
    sourceText.length > MAX_SOURCE_CHARS
      ? sourceText.slice(0, MAX_SOURCE_CHARS) + '\n\n[... truncated ...]'
      : sourceText;

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
- For "verification_difficulty", write a brief description of how hard this was to verify and what kind of source access was needed. Examples: "Single sentence confirms the exact number", "Needed to combine author name from intro with statistic from results section", "Claim requires reading the entire methodology section to confirm no mention of X", "The specific date is stated once in a timeline table"

Respond in exactly this JSON format:
{"verdict": "accurate", "score": 0.95, "issues": [], "supporting_quotes": ["passage 1", "passage 2"], "verification_difficulty": "Single paragraph contains all claimed details"}`;

  const userPrompt = `WIKI CLAIM:
${claimText}
${sourceContext}
SOURCE TEXT:
${truncatedSource}

Search the entire source for all passages relevant to this claim, then check every factual detail. Return JSON only.`;

  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://www.longtermwiki.com',
      'X-Title': 'LongtermWiki Accuracy Check',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 2000,
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `OpenRouter API error (${response.status}): ${errorBody.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    error?: { message: string };
  };

  if (data.error) {
    throw new Error(`OpenRouter error: ${data.error.message}`);
  }

  const content = data.choices?.[0]?.message?.content || '';
  const jsonStr = content
    .replace(/^```json\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  try {
    const parsed = JSON.parse(jsonStr) as {
      verdict?: string;
      score?: number;
      issues?: string[];
      supporting_quotes?: string[];
      verification_difficulty?: string;
    };

    const validVerdicts: AccuracyVerdict[] = ['accurate', 'minor_issues', 'inaccurate', 'unsupported', 'not_verifiable'];
    const verdict = validVerdicts.includes(parsed.verdict as AccuracyVerdict)
      ? (parsed.verdict as AccuracyVerdict)
      : 'not_verifiable';

    return {
      verdict,
      score: typeof parsed.score === 'number' ? Math.max(0, Math.min(1, parsed.score)) : 0.5,
      issues: Array.isArray(parsed.issues) ? parsed.issues.filter((i) => typeof i === 'string' && i.length > 0) : [],
      supportingQuotes: Array.isArray(parsed.supporting_quotes) ? parsed.supporting_quotes.filter((q) => typeof q === 'string' && q.length > 0) : [],
      verificationDifficulty: typeof parsed.verification_difficulty === 'string' ? parsed.verification_difficulty : '',
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
