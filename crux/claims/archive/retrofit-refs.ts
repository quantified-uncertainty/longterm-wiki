/**
 * Retrofit References — Insert [^rc-XXXX] footnote markers for extracted claims.
 *
 * For pages that have claims in the DB but no (or incomplete) inline footnote
 * references, this tool uses an LLM to identify where each claim is asserted
 * in the prose and inserts [^rc-XXXX] markers at those locations.
 *
 * The tool does NOT rewrite any prose — it only inserts footnote markers.
 *
 * Usage:
 *   pnpm crux claims retrofit-refs <page-id>           # dry-run
 *   pnpm crux claims retrofit-refs <page-id> --apply   # write changes
 *   pnpm crux claims retrofit-refs <page-id> --model=M # override LLM model
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { parseCliArgs, parseIntOpt } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { findPageFile } from '../lib/file-utils.ts';
import { stripFrontmatter } from '../lib/patterns.ts';
import {
  callOpenRouter,
  stripCodeFences,
  parseJsonWithRepair,
  DEFAULT_CITATION_MODEL,
} from '../lib/quote-extractor.ts';
import {
  getClaimsByEntity,
  type ClaimRow,
} from '../lib/wiki-server/claims.ts';
import { getPageReferences, createCitationsBatch } from '../lib/wiki-server/references.ts';
import { generateReferenceId } from './migrate-footnotes.ts';
import { splitIntoSections, cleanMdxForExtraction } from './extract.ts';
import type { PageCitationInsert } from '../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClaimPlacement {
  claimId: number;
  claimText: string;
  section: string;
  /** Verbatim text snippet immediately before the insertion point */
  insertAfterText: string;
  /** Source URL from claim sources, if any */
  sourceUrl: string | null;
  /** Source title from claim sources, if any */
  sourceTitle: string | null;
}

interface SectionMatchResult {
  sectionHeading: string;
  placements: ClaimPlacement[];
  unmatchedCount: number;
}

export interface RetrofitResult {
  pageId: string;
  totalClaims: number;
  eligibleClaims: number;
  placed: number;
  unmatched: number;
  skippedNoMatch: number;
  refsCreated: number;
  applied: boolean;
}

// ---------------------------------------------------------------------------
// LLM Prompt
// ---------------------------------------------------------------------------

const RETROFIT_SYSTEM_PROMPT = `You are a citation placement assistant. Given a section of wiki text and a numbered list of claims extracted from it, identify where each claim is asserted.

For each claim you can match, return:
- "claimId": the claim's numeric ID
- "insertAfterText": the EXACT 30-60 character substring that ends the sentence where the claim is asserted, INCLUDING the final period

Rules:
1. insertAfterText MUST be a verbatim substring of the section text — character-for-character
2. Choose sentence endings (last ~50 chars including the period) as insertion points
3. If multiple claims map to the same sentence, return each with the same insertAfterText
4. SKIP claims that are not clearly asserted in the text — omit them entirely
5. SKIP claims that are vague editorial assessments with no single assertion point
6. Prefer the most SPECIFIC sentence for each claim (not introductory summaries)
7. Do NOT modify, rephrase, or add to the text — only identify positions

Respond ONLY with JSON: {"placements": [{"claimId": N, "insertAfterText": "..."}]}
If no claims can be placed, return: {"placements": []}`;

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Call LLM to find insertion points for claims within a section.
 */
async function matchClaimsToSection(
  sectionHeading: string,
  sectionText: string,
  claims: Array<{ id: number; claimText: string; sourceUrl: string | null; sourceTitle: string | null }>,
  model: string,
): Promise<SectionMatchResult> {
  const claimList = claims
    .map((c) => `  [${c.id}] ${c.claimText}`)
    .join('\n');

  const userPrompt = `SECTION: ${sectionHeading}

TEXT:
${sectionText}

CLAIMS TO PLACE:
${claimList}

Find where each claim is asserted in the text above. Return JSON only.`;

  try {
    const raw = await callOpenRouter(RETROFIT_SYSTEM_PROMPT, userPrompt, {
      model,
      maxTokens: 1500,
      title: 'LongtermWiki Retrofit Refs',
    });

    const json = stripCodeFences(raw);
    const parsed = parseJsonWithRepair<{ placements?: unknown[] }>(json);

    if (!Array.isArray(parsed.placements)) {
      return { sectionHeading, placements: [], unmatchedCount: claims.length };
    }

    const placements: ClaimPlacement[] = [];
    const matchedIds = new Set<number>();

    for (const p of parsed.placements) {
      if (
        typeof p !== 'object' || p === null ||
        typeof (p as Record<string, unknown>).claimId !== 'number' ||
        typeof (p as Record<string, unknown>).insertAfterText !== 'string'
      ) continue;

      const record = p as { claimId: number; insertAfterText: string };
      const claim = claims.find((c) => c.id === record.claimId);
      if (!claim) continue;

      // Verify the text actually appears in the section
      if (!sectionText.includes(record.insertAfterText)) {
        // Try with normalized whitespace
        const normalized = record.insertAfterText.replace(/\s+/g, ' ').trim();
        if (!sectionText.includes(normalized)) continue;
        record.insertAfterText = normalized;
      }

      placements.push({
        claimId: claim.id,
        claimText: claim.claimText,
        section: sectionHeading,
        insertAfterText: record.insertAfterText,
        sourceUrl: claim.sourceUrl,
        sourceTitle: claim.sourceTitle,
      });
      matchedIds.add(claim.id);
    }

    return {
      sectionHeading,
      placements,
      unmatchedCount: claims.length - matchedIds.size,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [warn] Section "${sectionHeading}" — matching failed: ${msg.slice(0, 120)}`);
    return { sectionHeading, placements: [], unmatchedCount: claims.length };
  }
}

/**
 * Insert [^rc-XXXX] markers into page content at the specified locations.
 * Processes insertions in reverse order to preserve character offsets.
 */
function insertRefsIntoContent(
  content: string,
  placements: ClaimPlacement[],
  existingRefIds: Set<string>,
): { modified: string; insertedRefs: Array<{ refId: string; placement: ClaimPlacement }> } {
  // Find positions for all placements in the raw content
  const positionedPlacements: Array<{
    placement: ClaimPlacement;
    position: number; // character position where we insert AFTER
  }> = [];

  for (const placement of placements) {
    const idx = content.indexOf(placement.insertAfterText);
    if (idx === -1) continue;

    positionedPlacements.push({
      placement,
      position: idx + placement.insertAfterText.length,
    });
  }

  // Sort by position descending so we can insert without invalidating offsets
  positionedPlacements.sort((a, b) => b.position - a.position);

  // Deduplicate: if multiple placements have the exact same position, keep all
  // but generate unique ref IDs for each
  const insertedRefs: Array<{ refId: string; placement: ClaimPlacement }> = [];
  let modified = content;

  for (const { placement, position } of positionedPlacements) {
    const refId = generateReferenceId(
      'rc',
      `retrofit:${placement.claimId}:${placement.section}`,
      existingRefIds,
    );

    // Insert [^rc-XXXX] at the position
    modified = modified.slice(0, position) + `[^${refId}]` + modified.slice(position);
    insertedRefs.push({ refId, placement });
  }

  // Reverse to get insertion order (we built it in reverse)
  insertedRefs.reverse();

  return { modified, insertedRefs };
}

/**
 * Main retrofit function for a single page.
 */
export async function retrofitPageRefs(
  pageId: string,
  options: {
    apply?: boolean;
    model?: string;
    maxClaimsPerSection?: number;
  } = {},
): Promise<RetrofitResult> {
  const { apply = false, model = DEFAULT_CITATION_MODEL, maxClaimsPerSection = 15 } = options;

  const filePath = findPageFile(pageId);
  if (!filePath) {
    throw new Error(`Page file not found for: ${pageId}`);
  }

  const rawContent = readFileSync(filePath, 'utf-8');
  const body = stripFrontmatter(rawContent);

  // Load claims from DB
  const claimsResult = await getClaimsByEntity(pageId, { includeSources: true });
  if (!claimsResult.ok) {
    throw new Error(`Failed to load claims for ${pageId}: ${claimsResult.error}`);
  }
  const allClaims = claimsResult.data.claims;

  if (allClaims.length === 0) {
    return {
      pageId,
      totalClaims: 0,
      eligibleClaims: 0,
      placed: 0,
      unmatched: 0,
      skippedNoMatch: 0,
      refsCreated: 0,
      applied: false,
    };
  }

  // Load existing page references to find already-linked claims
  const refsResult = await getPageReferences(pageId);
  const linkedClaimIds = new Set<number>();
  if (refsResult.ok) {
    for (const ref of refsResult.data.references) {
      if (ref.type === 'claim') {
        linkedClaimIds.add(ref.claimId);
      }
    }
  }

  // Filter to claims not already linked to a page reference
  const eligibleClaims = allClaims.filter((c: ClaimRow) => !linkedClaimIds.has(c.id));

  if (eligibleClaims.length === 0) {
    return {
      pageId,
      totalClaims: allClaims.length,
      eligibleClaims: 0,
      placed: 0,
      unmatched: 0,
      skippedNoMatch: 0,
      refsCreated: 0,
      applied: false,
    };
  }

  // Split into sections for matching
  const cleanBody = cleanMdxForExtraction(body);
  const sections = splitIntoSections(cleanBody);

  // Group eligible claims by section
  const claimsBySection = new Map<string, typeof eligibleClaims>();
  const unmatchedSectionClaims: typeof eligibleClaims = [];

  for (const claim of eligibleClaims) {
    const sectionName = claim.section ?? '';
    const matchingSection = sections.find(
      (s) => s.heading.toLowerCase() === sectionName.toLowerCase(),
    );

    if (matchingSection) {
      const existing = claimsBySection.get(matchingSection.heading) ?? [];
      existing.push(claim);
      claimsBySection.set(matchingSection.heading, existing);
    } else {
      unmatchedSectionClaims.push(claim);
    }
  }

  // Collect existing ref IDs for dedup
  const existingRefIds = new Set<string>();
  const rcPattern = /\[\^(rc-[a-zA-Z0-9]+|cr-[a-zA-Z0-9]+)\]/g;
  let match;
  while ((match = rcPattern.exec(rawContent)) !== null) {
    existingRefIds.add(match[1]);
  }

  // Process each section with LLM
  const allPlacements: ClaimPlacement[] = [];
  let totalUnmatched = 0;

  for (const section of sections) {
    const sectionClaims = claimsBySection.get(section.heading);
    if (!sectionClaims || sectionClaims.length === 0) continue;

    // Cap claims per section
    const toProcess = sectionClaims.slice(0, maxClaimsPerSection);

    // Extract source info from claims (primary source URL from sources array)
    const claimsForLLM = toProcess.map((c: ClaimRow) => {
      const primarySource = c.sources?.find((s: { isPrimary: boolean }) => s.isPrimary) ?? c.sources?.[0];
      return {
        id: c.id,
        claimText: c.claimText,
        sourceUrl: primarySource?.url ?? null,
        sourceTitle: primarySource?.sourceTitle ?? null,
      };
    });

    process.stdout.write(`  Matching: ${section.heading.slice(0, 40)}... (${toProcess.length} claims) `);

    const result = await matchClaimsToSection(
      section.heading,
      section.content,
      claimsForLLM,
      model,
    );

    allPlacements.push(...result.placements);
    totalUnmatched += result.unmatchedCount;

    const c = getColors(false);
    console.log(`${c.green}${result.placements.length} placed${c.reset}${result.unmatchedCount > 0 ? `, ${c.dim}${result.unmatchedCount} unmatched${c.reset}` : ''}`);
  }

  // Also try matching unmatched-section claims against all sections
  if (unmatchedSectionClaims.length > 0) {
    // Try to find a home for claims whose section field doesn't match any heading
    // Use the Introduction or first section as fallback
    const introSection = sections.find((s) => s.heading === 'Introduction') ?? sections[0];
    if (introSection) {
      const toProcess = unmatchedSectionClaims.slice(0, maxClaimsPerSection);
      const claimsForLLM = toProcess.map((c: ClaimRow) => {
        const primarySource = c.sources?.find((s: { isPrimary: boolean }) => s.isPrimary) ?? c.sources?.[0];
        return {
          id: c.id,
          claimText: c.claimText,
          sourceUrl: primarySource?.url ?? null,
          sourceTitle: primarySource?.sourceTitle ?? null,
        };
      });

      process.stdout.write(`  Matching: (unmatched section claims, ${toProcess.length}) `);

      const result = await matchClaimsToSection(
        introSection.heading,
        introSection.content,
        claimsForLLM,
        model,
      );

      allPlacements.push(...result.placements);
      totalUnmatched += result.unmatchedCount;

      const c = getColors(false);
      console.log(`${c.green}${result.placements.length} placed${c.reset}`);
    }
  }

  if (allPlacements.length === 0) {
    return {
      pageId,
      totalClaims: allClaims.length,
      eligibleClaims: eligibleClaims.length,
      placed: 0,
      unmatched: totalUnmatched,
      skippedNoMatch: 0,
      refsCreated: 0,
      applied: false,
    };
  }

  // Insert references into the raw content
  // We need to search for the insertAfterText in the raw body (not cleaned)
  const { modified, insertedRefs } = insertRefsIntoContent(
    rawContent,
    allPlacements,
    existingRefIds,
  );

  let refsCreated = 0;

  if (apply && insertedRefs.length > 0) {
    // Write modified MDX
    writeFileSync(filePath, modified, 'utf-8');

    // Create page_citations DB entries
    const citations: PageCitationInsert[] = insertedRefs.map(({ refId, placement }) => {
      const note = placement.claimText.length > 200
        ? placement.claimText.slice(0, 197) + '...'
        : placement.claimText;

      return {
        referenceId: refId,
        pageId,
        title: placement.sourceTitle ?? undefined,
        url: placement.sourceUrl ?? undefined,
        note,
      };
    });

    // Batch insert in chunks of 200 (API limit)
    for (let i = 0; i < citations.length; i += 200) {
      const batch = citations.slice(i, i + 200);
      const result = await createCitationsBatch(batch);
      if (result.ok) {
        refsCreated += result.data.inserted;
      }
    }
  }

  return {
    pageId,
    totalClaims: allClaims.length,
    eligibleClaims: eligibleClaims.length,
    placed: insertedRefs.length,
    unmatched: totalUnmatched,
    skippedNoMatch: allPlacements.length - insertedRefs.length,
    refsCreated,
    applied: apply,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const c = getColors(false);
  const positional = (args._positional as string[]) || [];
  const pageId = positional[0];
  const apply = args.apply === true;
  const model = typeof args.model === 'string' ? args.model : DEFAULT_CITATION_MODEL;
  const maxClaims = parseIntOpt(args['max-claims'], 15);

  if (!pageId) {
    console.error(`${c.red}Error: provide a page ID${c.reset}`);
    console.error(`  Usage: pnpm crux claims retrofit-refs <page-id>`);
    console.error(`  Usage: pnpm crux claims retrofit-refs <page-id> --apply`);
    process.exit(1);
  }

  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.error(
      `${c.red}Wiki server not available. Set LONGTERMWIKI_SERVER_URL and LONGTERMWIKI_SERVER_API_KEY.${c.reset}`,
    );
    process.exit(1);
  }

  console.log(
    `\n${c.bold}${c.blue}Retrofit References: ${pageId}${c.reset}${apply ? '' : ` ${c.dim}(dry-run)${c.reset}`}\n`,
  );

  const result = await retrofitPageRefs(pageId, {
    apply,
    model,
    maxClaimsPerSection: maxClaims,
  });

  // Summary
  console.log();
  console.log(`${c.bold}Summary${c.reset}`);
  console.log(`  Total claims:     ${result.totalClaims}`);
  console.log(`  Eligible (unlinked): ${result.eligibleClaims}`);
  console.log(`  Placed:           ${c.green}${result.placed}${c.reset}`);
  console.log(`  Unmatched:        ${result.unmatched}`);
  if (result.skippedNoMatch > 0) {
    console.log(`  Skipped (no text match): ${result.skippedNoMatch}`);
  }

  if (apply) {
    console.log(`  Refs created:     ${c.green}${result.refsCreated}${c.reset}`);
    console.log(`\n${c.green}Applied!${c.reset}`);
  } else if (result.placed > 0) {
    console.log(`\n${c.yellow}Dry run — no changes written. Use --apply to write changes.${c.reset}`);
  }
  console.log();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Retrofit refs failed:', err);
    process.exit(1);
  });
}
