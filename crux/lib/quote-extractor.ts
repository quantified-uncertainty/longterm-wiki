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
const DEFAULT_MODEL = 'google/gemini-flash-1.5';
const MAX_SOURCE_CHARS = 50_000;

export interface QuoteExtractionResult {
  quote: string;
  location: string;
  confidence: number;
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
