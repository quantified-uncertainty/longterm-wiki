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
 * Check whether a wiki claim accurately represents what the source quote says.
 *
 * This is the "second pass" — after extracting a supporting quote,
 * compare the wiki's specific factual claims against the source.
 */
export async function checkClaimAccuracy(
  claimText: string,
  sourceQuote: string,
  opts?: { model?: string; sourceTitle?: string },
): Promise<AccuracyCheckResult> {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY not set — required for accuracy checking');
  }

  const model = opts?.model || DEFAULT_MODEL;
  const sourceContext = opts?.sourceTitle ? `\nSource title: "${opts.sourceTitle}"` : '';

  const systemPrompt = `You are a fact-checking assistant. Given a claim from a wiki article and the supporting quote from the cited source, determine whether the wiki claim ACCURATELY represents what the source says.

Check for these specific issues:
1. WRONG NUMBERS: dates, percentages, dollar amounts, counts that differ between claim and source
2. WRONG ATTRIBUTION: claim attributes a statement to the wrong person/organization
3. MISLEADING PARAPHRASE: claim distorts the meaning or emphasis of the source
4. OVERCLAIMS: claim states something more definitively than the source supports
5. FABRICATED DETAILS: claim includes specific details not present in the source quote

Rules:
- Compare the claim against the source quote carefully, word by word for factual details
- Be strict about numbers, dates, and names — even small discrepancies matter
- "accurate" = claim faithfully represents the source (minor wording differences are OK)
- "minor_issues" = small discrepancies that don't change the core meaning (e.g., rounding)
- "inaccurate" = claim misrepresents what the source says in a meaningful way
- "unsupported" = source quote doesn't actually support this specific claim
- "not_verifiable" = not enough information in the quote to check the claim
- For "score", rate 0.0-1.0 (1.0 = perfectly accurate, 0.0 = completely wrong)
- For "issues", list each specific discrepancy found. Be concise but precise.

Respond in exactly this JSON format:
{"verdict": "accurate", "score": 0.95, "issues": ["optional issue description"]}`;

  const userPrompt = `WIKI CLAIM:
${claimText}
${sourceContext}
SOURCE QUOTE:
"${sourceQuote}"

Does the wiki claim accurately represent what the source says? Check all facts, numbers, dates, and attributions. Return JSON only.`;

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
  const jsonStr = content
    .replace(/^```json\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  try {
    const parsed = JSON.parse(jsonStr) as {
      verdict?: string;
      score?: number;
      issues?: string[];
    };

    const validVerdicts: AccuracyVerdict[] = ['accurate', 'minor_issues', 'inaccurate', 'unsupported', 'not_verifiable'];
    const verdict = validVerdicts.includes(parsed.verdict as AccuracyVerdict)
      ? (parsed.verdict as AccuracyVerdict)
      : 'not_verifiable';

    return {
      verdict,
      score: typeof parsed.score === 'number' ? Math.max(0, Math.min(1, parsed.score)) : 0.5,
      issues: Array.isArray(parsed.issues) ? parsed.issues.filter((i) => typeof i === 'string' && i.length > 0) : [],
    };
  } catch {
    return {
      verdict: 'not_verifiable',
      score: 0.5,
      issues: ['Failed to parse LLM response'],
    };
  }
}
