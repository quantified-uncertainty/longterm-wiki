/**
 * Sprint 2 Experiment Variants — prompt variations for claims extraction
 *
 * Each variant modifies the system prompt used during extraction.
 * Used by extract.ts when --variant=<name> is passed.
 *
 * Variants:
 *   baseline         — current production prompt (no change)
 *   page-type        — specialized prompts for person/org/concept pages (Experiment 2B)
 *   quantitative     — focus on quantitative/factual claims, skip vague (Experiment 2D)
 *   top-n            — extract only the 5-10 most important claims per section (Experiment 2D)
 */

export type VariantName = 'baseline' | 'page-type' | 'quantitative' | 'top-n';
export type PageType = 'person' | 'organization' | 'concept';

export const VARIANT_NAMES: VariantName[] = ['baseline', 'page-type', 'quantitative', 'top-n'];

/**
 * Infer page type from the page config type string used in evaluate-baseline.
 */
export function inferPageType(configType: string): PageType {
  if (configType.includes('person')) return 'person';
  if (configType.includes('org')) return 'organization';
  return 'concept';
}

// ---------------------------------------------------------------------------
// Shared prompt fragments
// ---------------------------------------------------------------------------

const CLAIM_TYPE_SPEC = `- "claimType": one of:
    "factual" — specific facts, events, dates verifiable against a single source
    "numeric" — claims with specific numbers, dollar amounts, percentages, counts
    "historical" — historical events or timeline items
    "evaluative" — subjective assessments, value judgments, or opinions
    "causal" — cause-effect assertions or inferences
    "consensus" — claims about what is "widely believed" or "generally accepted"
    "speculative" — predictions, projections, or uncertain future claims
    "relational" — comparisons between entities or cross-entity assertions`;

const PHASE2_FIELDS = `- "claimMode": one of:
    "endorsed" — the wiki article itself asserts this claim (most claims)
    "attributed" — the article is reporting what someone ELSE claims (e.g. "CEO X said...", "According to OpenAI...", "Researchers believe...")
- "attributedTo": (only when claimMode="attributed") the entity_id or name of who is making the claim (e.g. "sam-altman", "openai", "researchers")
- "asOf": (optional) the date this claim was true, in YYYY-MM or YYYY-MM-DD format (e.g. "2024-03" for "as of March 2024")
- "measure": (optional, only for numeric claims) a snake_case identifier for what is being measured:
    Use "valuation" for company valuations, "funding_total" for total funding raised,
    "employee_count" for headcount, "revenue" for revenue, "parameters" for model parameter counts,
    "benchmark_score" for benchmark scores. Leave null if no standard measure applies.
- "valueNumeric": (optional, only for numeric claims) the central numeric value as a plain number (e.g. 7300000000 for $7.3B, 0.92 for 92%)
- "valueLow": (optional) lower bound if a range is given
- "valueHigh": (optional) upper bound if a range is given`;

const SOURCE_FIELDS = `- "sourceQuote": a SHORT verbatim excerpt (max 200 chars) copied exactly from the wiki text that contains or directly supports this claim. Must be an exact substring of the input text.
- "footnoteRefs": array of citation references (as strings) — look for [^N] (e.g. [^1]) and [^R:HASH] patterns near the claim
- "relatedEntities": array of entity IDs or names mentioned in the claim other than the page's primary subject`;

const SELF_CONTAINMENT_RULES = `SELF-CONTAINMENT (critical):
- Every claim MUST be a complete, self-contained assertion. A reader seeing ONLY this claim — with no other context — must understand what it asserts and about whom.
- Always include the full entity name (e.g., "Anthropic" not "the company", "Kalshi" not "the platform", "GPT-4" not "the model"). Never use "the company", "the model", "the platform", "the organization", "it", "they", or similar pronouns without the entity name.
- Each claim must contain exactly ONE verifiable assertion. If a sentence has multiple facts, split into separate claims.
- Never start a claim with "The ", "This ", "However", "Additionally", "Furthermore", "Moreover", "In contrast" — rewrite to be independent.
- Skip claims that merely define what the entity is (e.g., "Kalshi is a prediction market" on the Kalshi page).
- Skip vague claims using words like "significant", "various", "several" without specific numbers or names.
- Every claim must end with a period.`;

const SHARED_RULES = `Rules:
- Each claim must be atomic (one assertion per claim)
- Include specific numbers, names, dates when present
- Skip headings, navigation text, and pure descriptions
- Use "endorsed" for most claims — the wiki is making the assertion
- Use "attributed" when the text uses phrases like "X says", "according to Y", "Y believes", "Y announced"
- Use "numeric" for any claim with specific dollar amounts, percentages, counts, or model sizes
- Always include valueNumeric for numeric claims — extract the number even if written out (e.g. "$7.3 billion" → 7300000000)
- Include asOf whenever the text specifies a date or "as of" qualifier for the claim
- Return only claims that appear in the given text

${SELF_CONTAINMENT_RULES}`;

const JSON_FORMAT = `Respond ONLY with JSON:
{"claims": [{"claimText": "...", "claimType": "factual", "claimMode": "endorsed", "sourceQuote": "exact text from the wiki section", "footnoteRefs": ["1"], "relatedEntities": ["entity-id"]}]}`;

// ---------------------------------------------------------------------------
// Variant-specific prompt builders
// ---------------------------------------------------------------------------

function buildBaselinePrompt(): string {
  return `You are a fact-extraction assistant. Given a section of a wiki article, extract specific, verifiable claims.

For each claim, provide:
- "claimText": a single atomic, self-contained statement (not a question or heading)
${CLAIM_TYPE_SPEC}
${PHASE2_FIELDS}
${SOURCE_FIELDS}

${SHARED_RULES}
- Skip claims that are just definitions without verifiable content
- Extract 3-10 claims per section (skip trivial or duplicate content)

${JSON_FORMAT}`;
}

function buildPageTypePrompt(pageType: PageType): string {
  const typeGuidance: Record<PageType, string> = {
    person: `You are extracting claims from a PERSON wiki page. Focus on:
- Biographical facts: birth year, education, career positions with dates
- Stated positions and public statements on AI safety topics
- Research contributions: specific papers, findings, citations
- Track record: predictions made, outcomes
- Professional affiliations and roles

SKIP these low-value patterns:
- Vague career descriptions ("has worked extensively in the field")
- Generic praise or reputation claims without specifics ("is widely respected")
- Obvious role descriptions ("works on AI research")`,

    organization: `You are extracting claims from an ORGANIZATION wiki page. Focus on:
- Financial data: revenue, valuation, funding rounds with amounts and dates
- Personnel: key hires, headcount, leadership changes
- Strategic decisions: partnerships, product launches, policy positions
- Safety commitments: specific policies, benchmarks, evaluations
- Competitive positioning: market share, product comparisons with data

SKIP these low-value patterns:
- Generic mission statements ("aims to build safe AI")
- Vague strategic claims without specifics ("has a strong safety culture")
- Restatements of publicly obvious facts ("is a technology company")`,

    concept: `You are extracting claims from a CONCEPT wiki page. Focus on:
- Precise definitions with distinguishing criteria
- Key empirical evidence: specific experiments, results with numbers
- Quantitative findings: benchmark scores, effect sizes, success rates
- Consensus views with explicit attribution ("Most researchers agree that...")
- Timeline of key developments with dates
- Comparisons between approaches with specific metrics

SKIP these low-value patterns:
- Vague qualitative assessments ("Research investment is high")
- Tautological definitions ("X is the study of X")
- Obvious background statements ("AI is a rapidly growing field")
- Hedged speculation without evidence ("This could potentially be important")`,
  };

  return `${typeGuidance[pageType]}

For each claim, provide:
- "claimText": a single atomic, self-contained statement (not a question or heading)
${CLAIM_TYPE_SPEC}
${PHASE2_FIELDS}
${SOURCE_FIELDS}

${SHARED_RULES}
- Extract 3-10 claims per section (skip trivial or duplicate content)

${JSON_FORMAT}`;
}

function buildQuantitativePrompt(): string {
  return `You are a fact-extraction assistant specializing in QUANTITATIVE and SPECIFIC FACTUAL claims. Given a section of a wiki article, extract only claims that are concretely verifiable.

PRIORITIZE these claim types (in order):
1. Claims with specific numbers (dollar amounts, percentages, counts, dates, sizes)
2. Claims about specific events with dates
3. Claims with named entities and verifiable relationships
4. Claims about specific policies, decisions, or positions with attribution

SKIP these claim types entirely:
- Vague qualitative assessments ("Research is progressing rapidly")
- Generic descriptions without specifics ("The organization works on safety")
- Obvious or trivially true statements
- Hedged speculation without evidence
- Redundant restatements of the same fact

For each claim, provide:
- "claimText": a single atomic, self-contained statement (not a question or heading)
${CLAIM_TYPE_SPEC}
${PHASE2_FIELDS}
${SOURCE_FIELDS}

${SHARED_RULES}
- Extract 3-8 claims per section — fewer but higher quality
- Every claim MUST contain at least one specific fact (a number, date, name, or verifiable event)

${JSON_FORMAT}`;
}

function buildTopNPrompt(): string {
  return `You are a fact-extraction assistant. Given a section of a wiki article, extract ONLY the 5-10 most important and distinctive claims.

For "most important", prioritize claims that:
1. A reader would be MOST surprised to learn (high information value)
2. Contain specific, hard-to-guess facts (not common knowledge)
3. Distinguish this subject from similar subjects
4. Have significant implications for understanding the topic

Do NOT include claims that:
- State commonly known facts about the subject
- Are vague or could apply to many similar subjects
- Are trivially obvious from the page title alone
- Repeat information already captured in another claim

For each claim, provide:
- "claimText": a single atomic, self-contained statement (not a question or heading)
${CLAIM_TYPE_SPEC}
${PHASE2_FIELDS}
${SOURCE_FIELDS}

${SHARED_RULES}
- Extract EXACTLY 5-10 claims per section — no more, prioritize quality
- Each claim should pass the "would a knowledgeable reader find this interesting?" test

${JSON_FORMAT}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the system prompt for a given experiment variant.
 */
export function getVariantPrompt(variant: VariantName, pageType?: PageType): string {
  switch (variant) {
    case 'baseline':
      return buildBaselinePrompt();
    case 'page-type':
      return buildPageTypePrompt(pageType ?? 'concept');
    case 'quantitative':
      return buildQuantitativePrompt();
    case 'top-n':
      return buildTopNPrompt();
  }
}
