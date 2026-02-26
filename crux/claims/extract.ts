/**
 * Claims Extract — extract atomic claims from a wiki page
 *
 * Uses LLM to extract factual claims from each section of a wiki page,
 * then stores them in PostgreSQL for verification and display.
 *
 * Claims are stored in the `claims` table with:
 *   entityId       = page slug (e.g., "kalshi")
 *   entityType     = "wiki-page"
 *   claimType      = "factual" | "evaluative" | "causal" | "historical" | "numeric" | "consensus" | "speculative" | "relational"
 *   claimCategory  = "factual" | "opinion" | "analytical" | "speculative" | "relational"
 *   claimText      = the atomic claim
 *   section        = section name where claim appears (also stored in legacy 'value')
 *   footnoteRefs   = footnote refs as comma-separated string (also stored in legacy 'unit')
 *   confidence     = "unverified" (initial) | "verified" | "unsourced"
 *   relatedEntities = JSON array of entity IDs mentioned in the claim
 *
 * Usage:
 *   pnpm crux claims extract <page-id>
 *   pnpm crux claims extract <page-id> --model=google/gemini-2.0-flash-001
 *   pnpm crux claims extract <page-id> --dry-run
 *
 * Requires: OPENROUTER_API_KEY or ANTHROPIC_API_KEY
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { findPageFile } from '../lib/file-utils.ts';
import { stripFrontmatter } from '../lib/patterns.ts';
import { callOpenRouter, stripCodeFences, parseJsonWithRepair, DEFAULT_CITATION_MODEL } from '../lib/quote-extractor.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import {
  insertClaimBatch,
  clearClaimsForEntity,
  type InsertClaimItem,
} from '../lib/wiki-server/claims.ts';
import { VALID_CLAIM_TYPES, claimTypeToCategory, parseNumericValue } from '../lib/claim-utils.ts';
import type { ClaimTypeValue } from '../lib/claim-utils.ts';
import { getVariantPrompt, VARIANT_NAMES, type VariantName, type PageType } from './experiment-variants.ts';
import { validateClaimBatch } from './validate-claim.ts';

// ---------------------------------------------------------------------------
// MDX preprocessing — strip JSX components and get clean text
// ---------------------------------------------------------------------------

/** Strip MDX/JSX components and return plain text suitable for LLM analysis. */
export function cleanMdxForExtraction(body: string): string {
  return body
    // Remove import/export statements
    .replace(/^(import|export)\s+.*$/gm, '')
    // Convert <R id="HASH">Text</R> to [^R:HASH] citation markers before stripping JSX
    .replace(/<R\s+id="([^"]+)">[^<]*<\/R>/g, '[^R:$1]')
    // Remove JSX self-closing tags: <EntityLink id="..." />, <F id="..." />, etc.
    .replace(/<\w[\w.]*[^>]*\/>/g, ' ')
    // Remove JSX block components: <InfoBox>...</InfoBox>, <Callout>...</Callout>
    .replace(/<(\w[\w.]*)[^>]*>[\s\S]*?<\/\1>/g, ' ')
    // Remove remaining JSX open/close tags
    .replace(/<[/]?\w[\w.]*[^>]*>/g, ' ')
    // Remove MDX-style curly expressions: {/* ... */}, {someVar}
    .replace(/\{[^}]*\}/g, ' ')
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Section splitting
// ---------------------------------------------------------------------------

export interface Section {
  heading: string;
  content: string;
  level: number;
}

/** Split MDX body into sections by H2/H3 headings. */
export function splitIntoSections(body: string): Section[] {
  const lines = body.split('\n');
  const sections: Section[] = [];
  let currentHeading = 'Introduction';
  let currentLevel = 1;
  let currentLines: string[] = [];

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)/);
    const h3 = line.match(/^###\s+(.+)/);

    if (h2 || h3) {
      // Save previous section if it has content
      const content = currentLines.join('\n').trim();
      if (content.length > 50) {
        sections.push({ heading: currentHeading, content, level: currentLevel });
      }
      currentHeading = (h2 || h3)![1].trim();
      currentLevel = h2 ? 2 : 3;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Last section
  const content = currentLines.join('\n').trim();
  if (content.length > 50) {
    sections.push({ heading: currentHeading, content, level: currentLevel });
  }

  return sections;
}

// ---------------------------------------------------------------------------
// LLM claim extraction — Phase 2
// ---------------------------------------------------------------------------

interface ExtractedClaim {
  claimText: string;
  claimType: ClaimTypeValue;
  claimMode: 'endorsed' | 'attributed';  // Phase 2
  attributedTo?: string;                  // Phase 2: entity_id of claim author
  asOf?: string;                          // Phase 2: YYYY-MM or YYYY-MM-DD
  measure?: string;                       // Phase 2: measure ID (e.g. "valuation", "employee_count")
  valueNumeric?: number;                  // Phase 2: central numeric value
  valueLow?: number;                      // Phase 2: lower bound
  valueHigh?: number;                     // Phase 2: upper bound
  sourceQuote?: string;                   // Verbatim excerpt from wiki text supporting the claim
  footnoteRefs: string[];
  relatedEntities?: string[];
}

/**
 * Default extraction prompt — "top-n" variant (Sprint 2 winner).
 *
 * Sprint 2 tested 4 prompt variants across 10 pages:
 *   baseline:      81% usefulness, 1711 claims
 *   page-type:     82% usefulness, 1537 claims
 *   quantitative:  84% usefulness, 991 claims (but 93% accuracy — entity confusion)
 *   top-n:         91% usefulness, 1329 claims ← winner
 *
 * Key improvements over the Sprint 1 baseline (84% usefulness, 69% on concepts):
 *   - Concept pages: 96% usefulness (was 69%)
 *   - Org pages: 100% usefulness (was 93%)
 *   - Overall: 91% usefulness (was 84%)
 *   - 22% fewer claims with higher quality
 */
export const EXTRACT_SYSTEM_PROMPT = `You are a fact-extraction assistant. Given a section of a wiki article, extract ONLY the 5-10 most important and distinctive claims.

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
- Merely define what the entity is (e.g., "Kalshi is a prediction market" on the Kalshi page)
- Use vague words like "significant", "various", "several" without specific numbers or names

SELF-CONTAINMENT (critical):
- Every claim MUST be a complete, self-contained assertion. A reader seeing ONLY this claim — with no other context — must understand what it asserts and about whom.
- Always include the full entity name (e.g., "Anthropic" not "the company", "Kalshi" not "the platform", "GPT-4" not "the model"). Never use "the company", "the model", "the platform", "the organization", "it", "they", or similar pronouns without the entity name.
- Each claim must contain exactly ONE verifiable assertion. If a sentence has multiple facts, split into separate claims.
- Never start a claim with "The ", "This ", "However", "Additionally", "Furthermore", "Moreover", "In contrast" — rewrite to be independent.
- Every claim must end with a period.

For each claim, provide:
- "claimText": a single atomic, self-contained statement (not a question or heading)
- "claimType": one of:
    "factual" — specific facts, events, dates verifiable against a single source
    "numeric" — claims with specific numbers, dollar amounts, percentages, counts
    "historical" — historical events or timeline items
    "evaluative" — subjective assessments, value judgments, or opinions
    "causal" — cause-effect assertions or inferences
    "consensus" — claims about what is "widely believed" or "generally accepted"
    "speculative" — predictions, projections, or uncertain future claims
    "relational" — comparisons between entities or cross-entity assertions
- "claimMode": one of:
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
- "valueHigh": (optional) upper bound if a range is given
- "sourceQuote": a SHORT verbatim excerpt (max 200 chars) copied exactly from the wiki text that contains or directly supports this claim. Must be an exact substring of the input text.
- "footnoteRefs": array of citation references (as strings) — look for [^N] (e.g. [^1]) and [^R:HASH] patterns near the claim
- "relatedEntities": array of entity IDs or names mentioned in the claim other than the page's primary subject

Rules:
- Each claim must be atomic (one assertion per claim)
- Include specific numbers, names, dates when present
- Skip headings, navigation text, and pure descriptions
- Use "endorsed" for most claims — the wiki is making the assertion
- Use "attributed" when the text uses phrases like "X says", "according to Y", "Y believes", "Y announced"
- Use "numeric" for any claim with specific dollar amounts, percentages, counts, or model sizes
- Always include valueNumeric for numeric claims — extract the number even if written out (e.g. "$7.3 billion" → 7300000000)
- Include asOf whenever the text specifies a date or "as of" qualifier for the claim
- Extract EXACTLY 5-10 claims per section — no more, prioritize quality
- Each claim should pass the "would a knowledgeable reader find this interesting?" test
- Return only claims that appear in the given text

Respond ONLY with JSON:
{"claims": [{"claimText": "...", "claimType": "factual", "claimMode": "endorsed", "sourceQuote": "exact text from the wiki section", "footnoteRefs": ["1"], "relatedEntities": ["entity-id"]}]}`;

export async function extractClaimsFromSection(
  section: Section,
  opts: { model?: string; systemPrompt?: string } = {},
): Promise<ExtractedClaim[]> {
  const userPrompt = `SECTION: ${section.heading}

${section.content}

Extract atomic claims from this section. Return JSON only.`;

  try {
    const raw = await callOpenRouter(opts.systemPrompt ?? EXTRACT_SYSTEM_PROMPT, userPrompt, {
      model: opts.model ?? DEFAULT_CITATION_MODEL,
      maxTokens: 2500,
      title: 'LongtermWiki Claims Extraction',
    });

    const json = stripCodeFences(raw);
    const parsed = parseJsonWithRepair<{ claims?: unknown[] }>(json);

    if (!Array.isArray(parsed.claims)) return [];

    return parsed.claims
      .filter((c): c is Record<string, unknown> =>
        typeof c === 'object' && c !== null &&
        typeof (c as Record<string, unknown>).claimText === 'string' &&
        ((c as Record<string, unknown>).claimText as string).length > 10
      )
      .map(c => ({
        claimText: c.claimText as string,
        claimType: (VALID_CLAIM_TYPES.includes(c.claimType as ClaimTypeValue)
          ? c.claimType
          : 'factual') as ClaimTypeValue,
        claimMode: (c.claimMode === 'attributed' ? 'attributed' : 'endorsed') as 'endorsed' | 'attributed',
        attributedTo: typeof c.attributedTo === 'string' && c.attributedTo.length > 0
          ? c.attributedTo
          : undefined,
        asOf: typeof c.asOf === 'string' && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(c.asOf)
          ? c.asOf
          : undefined,
        measure: typeof c.measure === 'string' && c.measure.length > 0
          ? c.measure
          : undefined,
        valueNumeric: parseNumericValue(c.valueNumeric),
        valueLow: parseNumericValue(c.valueLow),
        valueHigh: parseNumericValue(c.valueHigh),
        sourceQuote: typeof c.sourceQuote === 'string' && c.sourceQuote.length > 5
          ? c.sourceQuote.slice(0, 500)
          : undefined,
        footnoteRefs: Array.isArray(c.footnoteRefs)
          ? (c.footnoteRefs as unknown[]).map(String)
          : [],
        relatedEntities: Array.isArray(c.relatedEntities)
          ? (c.relatedEntities as unknown[]).map(String).filter(s => s.length > 0).map(s => s.toLowerCase())
          : [],
      }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [warn] Section "${section.heading}" — extraction failed: ${msg.slice(0, 120)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Frontmatter title extraction
// ---------------------------------------------------------------------------

/** Extract the title field from YAML frontmatter. */
function extractFrontmatterTitle(raw: string): string | undefined {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return undefined;
  const titleMatch = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
  return titleMatch ? titleMatch[1] : undefined;
}

/** Convert a slug like "sam-altman" to a display name like "Sam Altman". */
function slugToDisplayName(slug: string): string {
  return slug
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === true;
  const strict = args['strict'] === true;
  const model = typeof args.model === 'string' ? args.model : undefined;
  const variantArg = typeof args.variant === 'string' ? args.variant : 'baseline';
  const pageTypeArg = typeof args['page-type'] === 'string' ? args['page-type'] as PageType : undefined;
  const c = getColors(false);
  const positional = (args._positional as string[]) || [];
  const pageId = positional[0];

  if (!pageId) {
    console.error(`${c.red}Error: provide a page ID${c.reset}`);
    console.error(`  Usage: pnpm crux claims extract <page-id>`);
    console.error(`  Variants: ${VARIANT_NAMES.join(', ')}`);
    process.exit(1);
  }

  // Validate variant
  if (!VARIANT_NAMES.includes(variantArg as VariantName)) {
    console.error(`${c.red}Error: unknown variant "${variantArg}". Valid: ${VARIANT_NAMES.join(', ')}${c.reset}`);
    process.exit(1);
  }
  const variant = variantArg as VariantName;

  // Get variant system prompt
  const systemPrompt = getVariantPrompt(variant, pageTypeArg);

  // Check server availability (unless dry-run)
  if (!dryRun) {
    const serverAvailable = await isServerAvailable();
    if (!serverAvailable) {
      console.error(`${c.red}Wiki server not available. Set LONGTERMWIKI_SERVER_URL and LONGTERMWIKI_SERVER_API_KEY.${c.reset}`);
      console.error(`  Use --dry-run to extract without storing.`);
      process.exit(1);
    }
  }

  // Find and read page
  const filePath = findPageFile(pageId);
  if (!filePath) {
    console.error(`${c.red}Error: page "${pageId}" not found${c.reset}`);
    process.exit(1);
  }

  const raw = readFileSync(filePath, 'utf-8');
  const body = stripFrontmatter(raw);
  const cleanBody = cleanMdxForExtraction(body);
  const sections = splitIntoSections(cleanBody);

  // Resolve entity display name for validation
  const entityName = extractFrontmatterTitle(raw) ?? slugToDisplayName(pageId);

  console.log(`\n${c.bold}${c.blue}Claims Extract: ${pageId}${c.reset}\n`);
  console.log(`  Sections found: ${sections.length}`);
  console.log(`  Entity name: ${entityName}`);
  if (variant !== 'baseline') {
    console.log(`  Variant: ${c.bold}${variant}${c.reset}${pageTypeArg ? ` (page-type: ${pageTypeArg})` : ''}`);
  }
  if (model) {
    console.log(`  Model: ${model}`);
  }
  if (strict) {
    console.log(`  ${c.yellow}STRICT MODE — claims failing validation will be rejected${c.reset}`);
  }
  if (dryRun) {
    console.log(`  ${c.yellow}DRY RUN — claims will not be stored${c.reset}`);
  }
  console.log('');

  // Extract claims from each section
  const allClaims: Array<ExtractedClaim & { section: string }> = [];

  for (const section of sections) {
    process.stdout.write(`  ${c.dim}Extracting: ${section.heading.slice(0, 50)}...${c.reset}`);
    const claims = await extractClaimsFromSection(section, { model, systemPrompt });
    allClaims.push(...claims.map(c => ({ ...c, section: section.heading })));
    console.log(` ${c.green}${claims.length} claims${c.reset}`);
  }

  console.log(`\n  Total extracted: ${c.bold}${allClaims.length}${c.reset} claims`);

  // Post-extraction validation
  const { accepted, rejected, stats } = validateClaimBatch(allClaims, pageId, entityName, strict);

  if (stats.total > 0 && (stats.warned > 0 || stats.rejected > 0)) {
    console.log(`\n${c.bold}Validation:${c.reset}`);
    console.log(`  ${c.green}${stats.valid}${c.reset} valid, ${c.yellow}${stats.warned}${c.reset} warned, ${c.red}${stats.rejected}${c.reset} rejected`);
    if (Object.keys(stats.issueBreakdown).length > 0) {
      console.log(`  ${c.dim}Issues:${c.reset}`);
      for (const [issue, cnt] of Object.entries(stats.issueBreakdown).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${issue.padEnd(28)} ${cnt}`);
      }
    }
    if (strict && rejected.length > 0) {
      console.log(`\n  ${c.yellow}Rejected claims (--strict):${c.reset}`);
      for (const r of rejected.slice(0, 5)) {
        console.log(`    ${c.red}x${c.reset} ${r.claimText.slice(0, 80)}`);
        console.log(`      ${c.dim}${r.validationIssues.join('; ')}${c.reset}`);
      }
      if (rejected.length > 5) {
        console.log(`    ... and ${rejected.length - 5} more`);
      }
    }
  }

  // Use validated claims going forward
  const validatedClaims = accepted;

  if (dryRun) {
    // Show type/category/mode breakdown
    const typeCounts: Record<string, number> = {};
    const catCounts: Record<string, number> = {};
    const modeCounts: Record<string, number> = {};
    let numericCount = 0;
    let attributedCount = 0;

    for (const claim of validatedClaims) {
      typeCounts[claim.claimType] = (typeCounts[claim.claimType] ?? 0) + 1;
      const cat = claimTypeToCategory(claim.claimType);
      catCounts[cat] = (catCounts[cat] ?? 0) + 1;
      modeCounts[claim.claimMode] = (modeCounts[claim.claimMode] ?? 0) + 1;
      if (claim.valueNumeric !== undefined) numericCount++;
      if (claim.claimMode === 'attributed') attributedCount++;
    }

    console.log(`\n${c.bold}By type:${c.reset}`);
    for (const [type, cnt] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${type.padEnd(14)} ${cnt}`);
    }
    console.log(`\n${c.bold}By category:${c.reset}`);
    for (const [cat, cnt] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${cat.padEnd(14)} ${cnt}`);
    }
    console.log(`\n${c.bold}By mode:${c.reset}`);
    for (const [mode, cnt] of Object.entries(modeCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${mode.padEnd(14)} ${cnt}`);
    }
    if (numericCount > 0) {
      console.log(`\n  ${c.green}${numericCount}${c.reset} numeric claims with extracted values`);
    }
    if (attributedCount > 0) {
      console.log(`  ${c.yellow}${attributedCount}${c.reset} attributed claims (reported speech)`);
    }

    const withEntities = validatedClaims.filter(c2 => c2.relatedEntities && c2.relatedEntities.length > 0);
    if (withEntities.length > 0) {
      console.log(`\n${c.bold}Multi-entity claims: ${withEntities.length}${c.reset}`);
      for (const claim of withEntities.slice(0, 5)) {
        console.log(`  [${claim.claimType}] ${claim.claimText.slice(0, 80)} → {${claim.relatedEntities!.join(', ')}}`);
      }
    }

    console.log(`\n${c.bold}Sample claims:${c.reset}`);
    for (const claim of validatedClaims.slice(0, 10)) {
      const refs = claim.footnoteRefs.length > 0 ? ` [^${claim.footnoteRefs.join(', ^')}]` : ' (unsourced)';
      const cat = claimTypeToCategory(claim.claimType);
      const modeTag = claim.claimMode === 'attributed' ? ` [by:${claim.attributedTo ?? '?'}]` : '';
      const numTag = claim.valueNumeric !== undefined ? ` [=${claim.valueNumeric}]` : '';
      const asOfTag = claim.asOf ? ` [${claim.asOf}]` : '';
      console.log(`  [${claim.claimType}/${cat}${modeTag}${asOfTag}${numTag}] ${claim.claimText.slice(0, 90)}${refs}`);
    }
    if (validatedClaims.length > 10) {
      console.log(`  ... and ${validatedClaims.length - 10} more`);
    }
    console.log(`\n${c.green}Dry run complete. Remove --dry-run to store.${c.reset}\n`);
    return;
  }

  // Store in PostgreSQL
  console.log(`\n  Storing in PostgreSQL...`);

  // Clear existing claims for this page
  const cleared = await clearClaimsForEntity(pageId);
  if (cleared.ok) {
    console.log(`  ${c.dim}Cleared ${cleared.data.deleted} existing claims${c.reset}`);
  }

  // Batch insert
  const BATCH_SIZE = 50;
  let inserted = 0;
  let failed = 0;

  for (let i = 0; i < validatedClaims.length; i += BATCH_SIZE) {
    const batch = validatedClaims.slice(i, i + BATCH_SIZE);
    const items: InsertClaimItem[] = batch.map(claim => ({
      entityId: pageId,
      entityType: 'wiki-page',
      claimType: claim.claimType,
      claimText: claim.claimText,
      // Legacy fields (kept for backward compat)
      value: claim.section,
      unit: claim.footnoteRefs.length > 0 ? claim.footnoteRefs.join(',') : null,
      confidence: 'unverified',
      sourceQuote: claim.sourceQuote ?? null,
      // Enhanced fields (migration 0028)
      claimCategory: claimTypeToCategory(claim.claimType),
      relatedEntities: claim.relatedEntities && claim.relatedEntities.length > 0
        ? claim.relatedEntities
        : null,
      section: claim.section,
      footnoteRefs: claim.footnoteRefs.length > 0 ? claim.footnoteRefs.join(',') : null,
      // Phase 2 fields (migration 0029)
      claimMode: claim.claimMode,
      attributedTo: claim.attributedTo ?? null,
      asOf: claim.asOf ?? null,
      measure: claim.measure ?? null,
      valueNumeric: claim.valueNumeric ?? null,
      valueLow: claim.valueLow ?? null,
      valueHigh: claim.valueHigh ?? null,
    }));

    const result = await insertClaimBatch(items);
    if (result.ok) {
      inserted += result.data.inserted;
    } else {
      failed += batch.length;
    }
  }

  const attributedCount = validatedClaims.filter(c2 => c2.claimMode === 'attributed').length;
  const numericCount = validatedClaims.filter(c2 => c2.valueNumeric !== undefined).length;

  console.log(`\n${c.bold}Done:${c.reset}`);
  console.log(`  Inserted:  ${c.green}${inserted}${c.reset} claims`);
  if (attributedCount > 0) console.log(`  Attributed: ${c.yellow}${attributedCount}${c.reset} claims with attribution`);
  if (numericCount > 0) console.log(`  Numeric:    ${c.green}${numericCount}${c.reset} claims with extracted values`);
  if (failed > 0) {
    console.log(`  Failed:    ${c.red}${failed}${c.reset}`);
  }
  console.log(`\n  Next steps:`);
  console.log(`    pnpm crux claims verify ${pageId}    # Verify claims against source text`);
  console.log(`    pnpm crux claims status ${pageId}    # Show claim breakdown`);
  console.log('');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Claims extract failed:', err);
    process.exit(1);
  });
}
