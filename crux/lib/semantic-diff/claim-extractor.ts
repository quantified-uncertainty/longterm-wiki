/**
 * Claim Extractor
 *
 * Uses Haiku (lightweight, fast) to extract structured factual claims
 * from MDX page content. Claims are the atomic factual assertions
 * that can be verified, contradicted, or tracked across versions.
 *
 * This is intentionally kept cheap and fast — Haiku is ~20x cheaper
 * than Sonnet and fast enough for real-time use during the improve pipeline.
 */

import { createLlmClient, callLlm, MODELS } from '../llm.ts';
import { parseJsonFromLlm } from '../json-parsing.ts';
import type { ExtractedClaim, ClaimType, ExtractionConfidence } from './types.ts';

// ---------------------------------------------------------------------------
// MDX content preprocessing
// ---------------------------------------------------------------------------

/**
 * Strip MDX frontmatter, JSX components, and markdown formatting from content
 * to produce cleaner prose for claim extraction.
 *
 * We strip:
 * - YAML frontmatter (--- ... ---)
 * - JSX/MDX component tags (<Component ... />)
 * - Footnote definitions ([^N]: ...)
 * - Import/export statements
 * - Markdown headings (# ## ###)
 * - Code blocks
 */
export function preprocessMdxForExtraction(content: string): string {
  let text = content;

  // Strip frontmatter
  text = text.replace(/^---[\s\S]*?---\n/, '');

  // Strip code blocks (they contain code, not prose claims)
  text = text.replace(/```[\s\S]*?```/g, '');

  // Strip inline code
  text = text.replace(/`[^`]+`/g, '');

  // Strip import/export statements
  text = text.replace(/^(?:import|export)\s+.*$/gm, '');

  // Strip JSX/MDX component tags (self-closing and opening)
  text = text.replace(/<[A-Z][a-zA-Z]*[^>]*\/>/g, '');
  text = text.replace(/<[A-Z][a-zA-Z]*[^>]*>/g, '');
  text = text.replace(/<\/[A-Z][a-zA-Z]*>/g, '');

  // Strip HTML comments
  text = text.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

  // Strip footnote definitions (we want claims from prose, not references)
  text = text.replace(/^\[\^\d+\]:.*$/gm, '');

  // Strip footnote references inline (keep the surrounding text)
  text = text.replace(/\[\^(\d+)\]/g, '');

  // Strip markdown link syntax, keep text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Strip heading markers (keep the text)
  text = text.replace(/^#{1,6}\s+/gm, '');

  // Strip bold/italic
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/_([^_]+)_/g, '$1');

  // Collapse multiple blank lines
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

/**
 * Split content into chunks of approximately maxChars characters,
 * breaking on paragraph boundaries to preserve context.
 */
export function splitIntoChunks(text: string, maxChars = 3000): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// LLM extraction
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM_PROMPT = `You are a factual claim extractor for an AI safety wiki. Your job is to identify discrete, verifiable factual claims from wiki page content.

Extract only concrete, assertable facts — not opinions, speculation, or general descriptions. Focus on:
- Numbers, statistics, percentages
- Dates, years, founding dates, event timings
- Attributions ("X said Y", "X founded Y", "X employs N people")
- Causal relationships with specific evidence
- Comparisons with specific values
- Existence claims ("X was created", "X published Y")

Do NOT extract:
- Vague descriptions ("X is an important organization")
- Opinions or evaluations ("X is considered excellent")
- Future predictions
- Hypothetical statements

Output must be valid JSON with this exact structure:
{
  "claims": [
    {
      "text": "One-sentence assertable factual claim",
      "type": "numeric|temporal|causal|attribution|existence|comparison|definition|other",
      "confidence": "high|medium|low",
      "sourceContext": "The sentence or phrase this was extracted from",
      "keyValue": "The specific value (number, date, name) that is the core of this claim, if applicable"
    }
  ]
}

Extract only claims you can clearly identify. Quality over quantity. Return an empty claims array if there are no clear factual claims.`;

interface RawClaimData {
  text?: unknown;
  type?: unknown;
  confidence?: unknown;
  sourceContext?: unknown;
  keyValue?: unknown;
}

interface LlmExtractionResult {
  claims: RawClaimData[];
}

/**
 * Extract claims from a single chunk of text using Haiku.
 */
async function extractClaimsFromChunk(
  chunk: string,
): Promise<ExtractedClaim[]> {
  const client = createLlmClient();

  const prompt = `Extract all verifiable factual claims from this wiki page content:

${chunk}

Return the claims as a JSON object with a "claims" array.`;

  const result = await callLlm(client, {
    system: EXTRACTION_SYSTEM_PROMPT,
    user: prompt,
  }, {
    model: MODELS.haiku,
    maxTokens: 2000,
    retryLabel: 'claim-extraction',
  });

  const parsed = parseJsonFromLlm<LlmExtractionResult>(
    result.text,
    'claim-extraction',
    (raw, err) => {
      // Log the parse failure with context for debugging
      console.warn(
        `[semantic-diff] Failed to parse claim extraction response: ${err ?? 'unknown error'}. Raw (first 200): ${raw.slice(0, 200)}`
      );
      return { claims: [] };
    },
  );

  if (!parsed.claims || !Array.isArray(parsed.claims)) {
    return [];
  }

  const validTypes = new Set<ClaimType>([
    'numeric', 'temporal', 'causal', 'attribution',
    'existence', 'comparison', 'definition', 'other',
  ]);
  const validConfidence = new Set<ExtractionConfidence>(['high', 'medium', 'low']);

  return parsed.claims
    .filter((c): c is RawClaimData => c !== null && typeof c === 'object')
    .map(c => ({
      text: typeof c.text === 'string' ? c.text.trim() : '',
      type: (validTypes.has(c.type as ClaimType) ? c.type : 'other') as ClaimType,
      confidence: (validConfidence.has(c.confidence as ExtractionConfidence)
        ? c.confidence : 'low') as ExtractionConfidence,
      sourceContext: typeof c.sourceContext === 'string' ? c.sourceContext.trim() : '',
      keyValue: typeof c.keyValue === 'string' ? c.keyValue.trim() : undefined,
    }))
    .filter(c => c.text.length > 0);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract factual claims from MDX page content.
 *
 * Preprocesses the content, splits into chunks, and runs Haiku extraction
 * on each chunk. Deduplicates the resulting claims.
 *
 * @param content - Raw MDX page content (including frontmatter)
 * @param maxChunkChars - Max characters per chunk for LLM calls (default: 3000)
 * @returns Array of extracted factual claims
 */
export async function extractClaims(
  content: string,
  maxChunkChars = 3000,
): Promise<ExtractedClaim[]> {
  const prose = preprocessMdxForExtraction(content);

  if (prose.length < 50) {
    // Too little content to extract claims from
    return [];
  }

  const chunks = splitIntoChunks(prose, maxChunkChars);
  const allClaims: ExtractedClaim[] = [];

  for (const chunk of chunks) {
    if (chunk.trim().length < 20) continue;
    try {
      const claims = await extractClaimsFromChunk(chunk);
      allClaims.push(...claims);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.warn(`[semantic-diff] Claim extraction failed for chunk: ${error.message}`);
      // Continue with other chunks — partial extraction is better than none
    }
  }

  return deduplicateExtractedClaims(allClaims);
}

/**
 * Remove duplicate claims from an array.
 * Uses normalized text comparison to identify near-duplicates.
 */
function deduplicateExtractedClaims(claims: ExtractedClaim[]): ExtractedClaim[] {
  const seen = new Set<string>();
  const unique: ExtractedClaim[] = [];

  for (const claim of claims) {
    const normalized = claim.text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(claim);
    }
  }

  return unique;
}
