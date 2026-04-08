/**
 * Shared source-check prompt guidelines.
 *
 * These guidelines are used by all source-check commands and handlers to reduce
 * false-positive "contradicted" verdicts. Extracted from duplicated prompt blocks
 * in factbase-source-check, source-check-orchestrate, source-check-wiki-pages,
 * and claim-source-check.
 *
 * When updating these guidelines, all source-check prompts pick up the change.
 */

/**
 * Common false-positive avoidance guidelines for source-check LLM prompts.
 * Append this block after the main source-check question in any source-check prompt.
 */
export const SOURCE_CHECK_FALSE_POSITIVE_GUIDELINES = `IMPORTANT — avoid these common false-positive errors:
- **Range vs. point**: If the source gives a range (e.g., "51-200 employees") and the claimed value falls within that range (e.g., 91), that is "confirmed", NOT contradicted.
- **Temporal mismatch**: Only compare values from the same time period. If the claim is "as of 2024" but the source discusses 2025 projections (or vice versa), that is "unverifiable" or "outdated", NOT contradicted.
- **Wrong source relevance**: The source must actually discuss the specific claim. If the source is about entity X's own page but the claim is about a person's prior employment at entity Y, the source cannot contradict that — it's "unverifiable".
- **Approximate values**: A claimed value within 10% of the source value is "partial" or "confirmed", not "contradicted". Only use "contradicted" when values clearly conflict (e.g., source says 500, claim says 2000).
- **URL format**: "example.com", "https://www.example.com", and "http://example.com" all refer to the same website. Differences in protocol (http/https), "www" prefix, or trailing slashes are NOT contradictions — use "confirmed".
- **Date precision**: "2016-08" and "30 August 2016" are equivalent. Month-level vs day-level dates for the same month are NOT contradictions — use "confirmed".
- **Archive URLs**: A web.archive.org URL for a defunct/dissolved organization is intentional — not a contradiction with the original URL. Use "confirmed".
- **Opaque identifiers**: If a field contains an opaque ID (e.g., "sid_xxxx", "pjaXzBneWf") you cannot resolve, that is "unverifiable" — never "contradicted".
- **Partial listings**: Listing one founder/member when the source lists multiple is "partial", not "contradicted". The claim is incomplete, not wrong.
- **NaN/null values**: If the claimed value is "$NaN", "NaN", null, or undefined, that is a data bug — mark "unverifiable", not "contradicted".

Reserve "contradicted" ONLY for cases where the source clearly and directly states a value that is genuinely incompatible with the claim for the same time period — not just formatted differently or incomplete.`;

/**
 * Additional considerations block for source-check prompts.
 * Provides softer guidance on edge cases.
 */
export const SOURCE_CHECK_ADDITIONAL_CONSIDERATIONS = `Other considerations:
- Numbers may be expressed differently (e.g., "1 billion" vs "1e9" vs "$1B")
- Names may differ slightly (abbreviations, legal names vs common names)
- Dates may be approximate
- If the source discusses the topic but the specific data point isn't mentioned, that's "unverifiable"
- If the source has a newer value that supersedes the claimed value, that's "outdated"
- If the source partially confirms (e.g., confirms the ballpark but not the exact figure), that's "partial"`;

/**
 * Standard JSON response format instruction for single-claim source-check prompts.
 */
export const SOURCE_CHECK_RESPONSE_FORMAT = `Respond with ONLY a JSON object (no markdown code fences):
{
  "verdict": "confirmed|contradicted|unverifiable|outdated|partial",
  "confidence": 0.0 to 1.0,
  "extracted_value": "What the source actually says about this data point (quote or paraphrase)",
  "reasoning": "Brief explanation of your verdict"
}`;
