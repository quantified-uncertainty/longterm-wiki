/**
 * Shared sourcing prompt guidelines.
 *
 * These guidelines are used by all sourcing commands and handlers to reduce
 * false-positive "contradicted" verdicts. Extracted from duplicated prompt blocks
 * in factbase-sourcing, sourcing-orchestrate, sourcing-wiki-pages,
 * and claim-sourcing.
 *
 * When updating these guidelines, all sourcing prompts pick up the change.
 */

/**
 * Common false-positive avoidance guidelines for sourcing LLM prompts.
 * Append this block after the main sourcing question in any sourcing prompt.
 */
export const SOURCE_CHECK_FALSE_POSITIVE_GUIDELINES = `IMPORTANT — avoid these common false-positive errors:
- **Range vs. point**: If the source gives a range (e.g., "51-200 employees") and the claimed value falls within that range (e.g., 91), that is "confirmed", NOT contradicted.
- **Temporal mismatch**: Only compare values from the same time period. If the claim is "as of 2024" but the source discusses 2025 projections (or vice versa), that is "unverifiable" or "outdated", NOT contradicted.
- **Source has been updated since claim was made**: If the claim has an \`asOf\` date older than the source's current data, and the source no longer shows the historical figure, that is "outdated" (source has newer information) — NOT "contradicted". Example: claim is "revenue = $0.1B as of 2023" but source now shows "$19B as of 2026". This is outdated — the source was updated, not the claim was wrong.
- **Wrong source relevance**: The source must actually discuss the specific claim. If the source is about entity X's own page but the claim is about a person's prior employment at entity Y, the source cannot contradict that — it's "unverifiable".
- **Approximate values**: A claimed value within 10% of the source value is "partial" or "confirmed", not "contradicted". Only use "contradicted" when values clearly conflict (e.g., source says 500, claim says 2000).
- **Rounded display values**: The claim may show a rounded display format (e.g., "$19B") with an exact stored value in parentheses (e.g., "exact stored value: 19000000000"). Compare against the exact stored value, not the rounded display. "$19B" and "$19,000,000,000" and "19 billion" are all equivalent — use "confirmed".
- **URL format**: "example.com", "https://www.example.com", and "http://example.com" all refer to the same website. Differences in protocol (http/https), "www" prefix, or trailing slashes are NOT contradictions — use "confirmed".
- **Date precision**: "2016-08" and "30 August 2016" are equivalent. Month-level vs day-level dates for the same month are NOT contradictions — use "confirmed".
- **Archive URLs**: A web.archive.org URL for a defunct/dissolved organization is intentional — not a contradiction with the original URL. Use "confirmed".
- **Opaque identifiers**: If a field contains an opaque ID (e.g., "sid_xxxx", "pjaXzBneWf") you cannot resolve, that is "unverifiable" — never "contradicted".
- **Partial listings**: Listing one founder/member when the source lists multiple is "partial", not "contradicted". The claim is incomplete, not wrong.
- **NaN/null values**: If the claimed value is "$NaN", "NaN", null, or undefined, that is a data bug — mark "unverifiable", not "contradicted".

Reserve "contradicted" ONLY for cases where the source clearly and directly states a value that is genuinely incompatible with the claim for the same time period — not just formatted differently or incomplete.`;

/**
 * Additional considerations block for sourcing prompts.
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
 * Standard JSON response format instruction for single-claim sourcing prompts.
 */
export const SOURCE_CHECK_RESPONSE_FORMAT = `Respond with ONLY a JSON object (no markdown code fences):
{
  "verdict": "confirmed|contradicted|unverifiable|outdated|partial",
  "confidence": 0.0 to 1.0,
  "extracted_value": "What the source actually says about this data point (quote or paraphrase)",
  "reasoning": "Brief explanation of your verdict"
}`;
