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
import { callOpenRouter, stripCodeFences, DEFAULT_CITATION_MODEL } from '../lib/quote-extractor.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import {
  insertClaimBatch,
  clearClaimsForEntity,
  type InsertClaimItem,
} from '../lib/wiki-server/claims.ts';
import { VALID_CLAIM_TYPES, claimTypeToCategory } from '../lib/claim-utils.ts';
import type { ClaimTypeValue } from '../lib/claim-utils.ts';

// ---------------------------------------------------------------------------
// MDX preprocessing — strip JSX components and get clean text
// ---------------------------------------------------------------------------

/** Strip MDX/JSX components and return plain text suitable for LLM analysis. */
function cleanMdxForExtraction(body: string): string {
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

interface Section {
  heading: string;
  content: string;
  level: number;
}

/** Split MDX body into sections by H2/H3 headings. */
function splitIntoSections(body: string): Section[] {
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
// LLM claim extraction
// ---------------------------------------------------------------------------

interface ExtractedClaim {
  claimText: string;
  claimType: ClaimTypeValue;
  footnoteRefs: string[];  // e.g. ["1", "3", "7"]
  relatedEntities?: string[];  // entity IDs mentioned in the claim
}

const EXTRACT_SYSTEM_PROMPT = `You are a fact-extraction assistant. Given a section of a wiki article, extract specific, verifiable claims.

For each claim, provide:
- "claimText": a single atomic, self-contained statement (not a question or heading)
- "claimType": one of:
    "factual" — specific facts, events, dates verifiable against a single source
    "numeric" — claims with specific numbers, dollar amounts, percentages, counts
    "historical" — historical events or timeline items
    "evaluative" — subjective assessments, value judgments, or opinions
    "causal" — cause-effect assertions or inferences
    "consensus" — claims about what is "widely believed" or "generally accepted" (need multiple sources)
    "speculative" — predictions, projections, or uncertain future claims
    "relational" — comparisons between entities or cross-entity assertions
- "footnoteRefs": array of citation references (as strings) — look for [^N] (e.g. [^1]) and [^R:HASH] (e.g. [^R:abc123]) patterns near the claim
- "relatedEntities": array of entity IDs or names mentioned in the claim other than the page's primary subject (e.g., if a claim on the Kalshi page mentions "Polymarket", include ["polymarket"])

Rules:
- Each claim must be atomic (one assertion per claim)
- Include specific numbers, names, dates when present
- Skip headings, navigation text, and pure descriptions
- Skip claims that are just definitions without verifiable content
- Use "numeric" for any claim containing specific dollar amounts, percentages, or counts
- Use "consensus" for claims using language like "widely", "generally", "most experts"
- Use "speculative" for claims with hedging language: "may", "might", "could", "expected to"
- Use "relational" for claims comparing two or more entities
- Extract 3-10 claims per section (skip trivial or duplicate content)
- Return only claims that appear in the given text

Respond ONLY with JSON:
{"claims": [{"claimText": "...", "claimType": "factual", "footnoteRefs": ["1"], "relatedEntities": ["entity-id"]}]}`;

async function extractClaimsFromSection(
  section: Section,
  opts: { model?: string } = {},
): Promise<ExtractedClaim[]> {
  const userPrompt = `SECTION: ${section.heading}

${section.content}

Extract atomic claims from this section. Return JSON only.`;

  try {
    const raw = await callOpenRouter(EXTRACT_SYSTEM_PROMPT, userPrompt, {
      model: opts.model ?? DEFAULT_CITATION_MODEL,
      maxTokens: 2000,
      title: 'LongtermWiki Claims Extraction',
    });

    const json = stripCodeFences(raw);
    const parsed = JSON.parse(json) as { claims?: unknown[] };

    if (!Array.isArray(parsed.claims)) return [];

    return parsed.claims
      .filter((c): c is ExtractedClaim =>
        typeof c === 'object' && c !== null &&
        typeof (c as ExtractedClaim).claimText === 'string' &&
        (c as ExtractedClaim).claimText.length > 10
      )
      .map(c => ({
        claimText: (c as ExtractedClaim).claimText,
        claimType: (VALID_CLAIM_TYPES.includes((c as ExtractedClaim).claimType as ClaimTypeValue)
          ? (c as ExtractedClaim).claimType
          : 'factual') as ClaimTypeValue,
        footnoteRefs: Array.isArray((c as ExtractedClaim).footnoteRefs)
          ? (c as ExtractedClaim).footnoteRefs.map(String)
          : [],
        relatedEntities: Array.isArray((c as ExtractedClaim).relatedEntities)
          ? (c as ExtractedClaim).relatedEntities!.map(String).filter(s => s.length > 0)
          : [],
      }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [warn] Section "${section.heading}" — extraction failed: ${msg.slice(0, 120)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === true;
  const model = typeof args.model === 'string' ? args.model : undefined;
  const c = getColors(false);
  const positional = (args._positional as string[]) || [];
  const pageId = positional[0];

  if (!pageId) {
    console.error(`${c.red}Error: provide a page ID${c.reset}`);
    console.error(`  Usage: pnpm crux claims extract <page-id>`);
    process.exit(1);
  }

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

  console.log(`\n${c.bold}${c.blue}Claims Extract: ${pageId}${c.reset}\n`);
  console.log(`  Sections found: ${sections.length}`);
  if (dryRun) {
    console.log(`  ${c.yellow}DRY RUN — claims will not be stored${c.reset}`);
  }
  console.log('');

  // Extract claims from each section
  const allClaims: Array<ExtractedClaim & { section: string }> = [];

  for (const section of sections) {
    process.stdout.write(`  ${c.dim}Extracting: ${section.heading.slice(0, 50)}...${c.reset}`);
    const claims = await extractClaimsFromSection(section, { model });
    allClaims.push(...claims.map(c => ({ ...c, section: section.heading })));
    console.log(` ${c.green}${claims.length} claims${c.reset}`);
  }

  console.log(`\n  Total extracted: ${c.bold}${allClaims.length}${c.reset} claims`);

  if (dryRun) {
    // Show type/category breakdown
    const typeCounts: Record<string, number> = {};
    const catCounts: Record<string, number> = {};
    for (const claim of allClaims) {
      typeCounts[claim.claimType] = (typeCounts[claim.claimType] ?? 0) + 1;
      const cat = claimTypeToCategory(claim.claimType);
      catCounts[cat] = (catCounts[cat] ?? 0) + 1;
    }
    console.log(`\n${c.bold}By type:${c.reset}`);
    for (const [type, cnt] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${type.padEnd(14)} ${cnt}`);
    }
    console.log(`\n${c.bold}By category:${c.reset}`);
    for (const [cat, cnt] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${cat.padEnd(14)} ${cnt}`);
    }

    const withEntities = allClaims.filter(c2 => c2.relatedEntities && c2.relatedEntities.length > 0);
    if (withEntities.length > 0) {
      console.log(`\n${c.bold}Multi-entity claims: ${withEntities.length}${c.reset}`);
      for (const claim of withEntities.slice(0, 5)) {
        console.log(`  [${claim.claimType}] ${claim.claimText.slice(0, 80)} → {${claim.relatedEntities!.join(', ')}}`);
      }
    }

    console.log(`\n${c.bold}Sample claims:${c.reset}`);
    for (const claim of allClaims.slice(0, 10)) {
      const refs = claim.footnoteRefs.length > 0 ? ` [^${claim.footnoteRefs.join(', ^')}]` : ' (unsourced)';
      const cat = claimTypeToCategory(claim.claimType);
      console.log(`  [${claim.claimType}/${cat}] ${claim.claimText.slice(0, 100)}${refs}`);
    }
    if (allClaims.length > 10) {
      console.log(`  ... and ${allClaims.length - 10} more`);
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

  for (let i = 0; i < allClaims.length; i += BATCH_SIZE) {
    const batch = allClaims.slice(i, i + BATCH_SIZE);
    const items: InsertClaimItem[] = batch.map(claim => ({
      entityId: pageId,
      entityType: 'wiki-page',
      claimType: claim.claimType,
      claimText: claim.claimText,
      // Legacy fields (kept for backward compat)
      value: claim.section,
      unit: claim.footnoteRefs.length > 0 ? claim.footnoteRefs.join(',') : null,
      confidence: 'unverified',
      sourceQuote: null,
      // Enhanced fields
      claimCategory: claimTypeToCategory(claim.claimType),
      relatedEntities: claim.relatedEntities && claim.relatedEntities.length > 0
        ? claim.relatedEntities
        : null,
      section: claim.section,
      footnoteRefs: claim.footnoteRefs.length > 0 ? claim.footnoteRefs.join(',') : null,
    }));

    const result = await insertClaimBatch(items);
    if (result.ok) {
      inserted += result.data.inserted;
    } else {
      failed += batch.length;
    }
  }

  console.log(`\n${c.bold}Done:${c.reset}`);
  console.log(`  Inserted: ${c.green}${inserted}${c.reset} claims`);
  if (failed > 0) {
    console.log(`  Failed:   ${c.red}${failed}${c.reset}`);
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
