/**
 * Claim Extractor — Extract structured claims from source content.
 *
 * Takes fetched source content + a list of unverifiable records and uses
 * Haiku to extract claims that could verify those records. Returns
 * structured claims ready for proposeClaims().
 *
 * Part of the claims-first source-discover agent (QUA-210).
 */

import { z } from 'zod';
import { createLlmClient, streamingCreate, extractText, MODELS } from '../lib/llm.ts';
import { escapeXml } from '../lib/prompt-utils.ts';
import { MODEL_PRICING } from '../lib/pricing.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UnverifiableRecord {
  recordType: string;
  recordId: string;
  fieldName: string | null;
  displayName: string | null;
  reasoning: string | null;
  entityId: string | null;
}

export interface ExtractedClaim {
  claimText: string;
  targetField: string | null;
  proposedValue: string | null;
  /** Which record(s) this claim is relevant to */
  matchedRecordIds: string[];
}

export interface ClaimExtractionResult {
  claims: ExtractedClaim[];
  cost: number;
  inputTokens: number;
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// Zod schema for LLM output validation
// ---------------------------------------------------------------------------

const LlmClaimSchema = z.object({
  claimText: z.string().min(1),
  targetField: z.string().nullable().optional(),
  proposedValue: z.string().nullable().optional(),
  recordIds: z.array(z.string()).min(1),
});

const LlmClaimsResponseSchema = z.array(LlmClaimSchema);

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the extraction prompt. Exported for testing.
 */
export function buildExtractionPrompt(
  sourceContent: string,
  sourceUrl: string,
  records: UnverifiableRecord[],
): string {
  const maxContentLength = 8_000;
  const truncatedContent = sourceContent.length > maxContentLength
    ? sourceContent.slice(0, maxContentLength) + '\n[... truncated]'
    : sourceContent;

  const recordsXml = records.map(r => {
    // Values placed inside double-quoted attributes must also escape `"` so a
    // crafted value can't break out of the attribute (escapeXml only handles
    // & < >). Element text below doesn't need the quote escape.
    const displayPart = r.displayName ? ` displayName="${escapeXml(r.displayName).replace(/"/g, '&quot;')}"` : '';
    const fieldPart = r.fieldName ? ` fieldName="${escapeXml(r.fieldName).replace(/"/g, '&quot;')}"` : '';
    const reasoningPart = r.reasoning
      ? `\n    <reasoning>${escapeXml(r.reasoning)}</reasoning>`
      : '';
    return `  <record id="${escapeXml(r.recordId).replace(/"/g, '&quot;')}" type="${escapeXml(r.recordType).replace(/"/g, '&quot;')}"${displayPart}${fieldPart}>${reasoningPart}\n  </record>`;
  }).join('\n');

  return `You are a structured data extraction assistant. Given a source document and a list of database records that need verification, extract factual claims from the source that could verify or update those records.

<source url="${escapeXml(sourceUrl).replace(/"/g, '&quot;')}">
${escapeXml(truncatedContent)}
</source>

<records_needing_verification>
${recordsXml}
</records_needing_verification>

Instructions:
- Extract ONLY claims that are explicitly stated in the source content.
- Each claim must reference at least one record ID from the list above.
- Include a proposedValue when the source states a concrete value (number, date, name, title).
- Include targetField when you can identify which specific field the claim updates (e.g., "title", "startDate", "source").
- Do NOT fabricate information not present in the source.
- Return at most 20 claims.

Return a JSON array of objects with these fields:
- claimText (string): A clear factual statement from the source.
- targetField (string | null): The database field this claim updates, if identifiable.
- proposedValue (string | null): The concrete value from the source, if applicable.
- recordIds (string[]): Which record IDs from the list this claim is relevant to.

Return ONLY the JSON array. No prose, no markdown fences.`;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse LLM response into validated claims. Exported for testing.
 */
export function parseClaimsResponse(raw: string): ExtractedClaim[] {
  // Try to extract a JSON array from the response
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }

  const result = LlmClaimsResponseSchema.safeParse(parsed);
  if (!result.success) {
    // Try partial extraction: validate each item individually
    if (!Array.isArray(parsed)) return [];
    const claims: ExtractedClaim[] = [];
    for (const item of parsed) {
      const single = LlmClaimSchema.safeParse(item);
      if (single.success) {
        claims.push({
          claimText: single.data.claimText,
          targetField: single.data.targetField ?? null,
          proposedValue: single.data.proposedValue ?? null,
          matchedRecordIds: single.data.recordIds,
        });
      }
    }
    return claims;
  }

  return result.data.map(c => ({
    claimText: c.claimText,
    targetField: c.targetField ?? null,
    proposedValue: c.proposedValue ?? null,
    matchedRecordIds: c.recordIds,
  }));
}

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

const HAIKU_PRICING = MODEL_PRICING['claude-haiku-4-5-20251001'];

let _llmClient: ReturnType<typeof createLlmClient> | null = null;
function getLlmClient() {
  if (!_llmClient) _llmClient = createLlmClient();
  return _llmClient;
}

/**
 * Extract structured claims from source content using Haiku.
 *
 * @param sourceContent - The fetched text content of the source
 * @param sourceUrl - The URL of the source (for context)
 * @param records - Unverifiable records to match claims against
 * @returns Extracted claims with cost info
 */
export async function extractClaims(
  sourceContent: string,
  sourceUrl: string,
  records: UnverifiableRecord[],
): Promise<ClaimExtractionResult> {
  if (!sourceContent.trim() || records.length === 0) {
    return { claims: [], cost: 0, inputTokens: 0, outputTokens: 0 };
  }

  const prompt = buildExtractionPrompt(sourceContent, sourceUrl, records);

  let raw: string;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const response = await streamingCreate(getLlmClient(), {
      model: MODELS.haiku,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });
    raw = extractText(response);
    inputTokens = response.usage?.input_tokens ?? 0;
    outputTokens = response.usage?.output_tokens ?? 0;
  } catch (err: unknown) {
    console.warn(
      `[claim-extractor] Haiku call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { claims: [], cost: 0, inputTokens: 0, outputTokens: 0 };
  }

  const cost =
    (inputTokens / 1_000_000) * HAIKU_PRICING.inputPerM +
    (outputTokens / 1_000_000) * HAIKU_PRICING.outputPerM;

  const claims = parseClaimsResponse(raw);

  // Filter claims to only reference valid record IDs from the input
  const validRecordIds = new Set(records.map(r => r.recordId));
  const filteredClaims = claims
    .map(c => ({
      ...c,
      matchedRecordIds: c.matchedRecordIds.filter(id => validRecordIds.has(id)),
    }))
    .filter(c => c.matchedRecordIds.length > 0);

  return { claims: filteredClaims, cost, inputTokens, outputTokens };
}
