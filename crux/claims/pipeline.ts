/**
 * Unified Claims Pipeline — 4-step orchestrator for claim extraction,
 * linking, and verification.
 *
 * Runs in sequence:
 *   Step 1: Extract claims from page content → claims records
 *   Step 2: Link citation_quotes to claims → claim_id FK + claim_page_references
 *   Step 3: Verify claims against sources → verdict fields (delegates to crux claims verify)
 *
 * Usage:
 *   pnpm crux claims pipeline <page-id>
 *   pnpm crux claims pipeline <page-id> --dry-run
 *   pnpm crux claims pipeline <page-id> --steps=extract,link
 *   pnpm crux claims pipeline <page-id> --steps=link,verify --model=google/gemini-2.0-flash-001
 *
 * Requires: OPENROUTER_API_KEY or ANTHROPIC_API_KEY
 * Optional: LONGTERMWIKI_SERVER_URL (for DB writes)
 */

import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { findPageFile } from '../lib/file-utils.ts';
import { stripFrontmatter } from '../lib/patterns.ts';
import { isServerAvailable, apiRequest } from '../lib/wiki-server/client.ts';
import {
  insertClaimBatch,
  getClaimsByEntity,
  addClaimPageReferencesBatch,
  type InsertClaimItem,
} from '../lib/wiki-server/claims.ts';
import { linkCitationsToClaimsBatch, propagateClaimVerdictsToPage } from '../lib/wiki-server/citations.ts';
import {
  isClaimDuplicate,
  claimTypeToCategory,
  jaccardWordSimilarity,
} from '../lib/claim-utils.ts';
import {
  cleanMdxForExtraction,
  splitIntoSections,
  extractClaimsFromSection,
  EXTRACT_SYSTEM_PROMPT,
} from './extract.ts';
import { validateClaimBatch } from './validate-claim.ts';

// ---------------------------------------------------------------------------
// Step type
// ---------------------------------------------------------------------------

const ALL_STEPS = ['extract', 'link', 'verify'] as const;
type Step = (typeof ALL_STEPS)[number];

// ---------------------------------------------------------------------------
// Citation quote shape (from /api/citations/quotes endpoint)
// ---------------------------------------------------------------------------

interface CitationQuote {
  id: number;
  pageId: string;
  footnote: number | null;
  claimText: string;
  claimContext: string | null;
  sourceQuote: string | null;
  url: string | null;
  resourceId: string | null;
  accuracyVerdict: string | null;
  claimId: number | null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === true;
  const strict = args['strict'] === true;
  const model = typeof args.model === 'string' ? args.model : undefined;
  const c = getColors(false);
  const positional = (args._positional as string[]) || [];
  const pageId = positional[0];

  if (!pageId) {
    console.error(`${c.red}Error: provide a page ID${c.reset}`);
    console.error(`  Usage: pnpm crux claims pipeline <page-id> [--dry-run] [--steps=extract,link,verify] [--model=X]`);
    process.exit(1);
  }

  // Parse steps
  const stepsArg = typeof args.steps === 'string' ? args.steps : null;
  const steps: Step[] = stepsArg
    ? (stepsArg.split(',').map(s => s.trim()).filter(s => ALL_STEPS.includes(s as Step)) as Step[])
    : [...ALL_STEPS];

  if (steps.length === 0) {
    console.error(`${c.red}Error: no valid steps provided. Valid steps: ${ALL_STEPS.join(', ')}${c.reset}`);
    process.exit(1);
  }

  // Check server availability (unless dry-run and verify-only)
  if (!dryRun || steps.some(s => s !== 'verify')) {
    if (!dryRun) {
      const serverAvailable = await isServerAvailable();
      if (!serverAvailable) {
        console.error(`${c.red}Wiki server not available. Set LONGTERMWIKI_SERVER_URL and LONGTERMWIKI_SERVER_API_KEY.${c.reset}`);
        console.error(`  Use --dry-run to preview without storing.`);
        process.exit(1);
      }
    }
  }

  // Find page file
  const filePath = findPageFile(pageId);
  if (!filePath) {
    console.error(`${c.red}Error: page "${pageId}" not found${c.reset}`);
    process.exit(1);
  }

  console.log(`\n${c.bold}${c.blue}Claims Pipeline: ${pageId}${c.reset}`);
  console.log(`  Steps: ${steps.join(', ')}`);
  if (model) console.log(`  Model: ${model}`);
  if (strict) console.log(`  ${c.yellow}STRICT MODE — claims failing validation will be rejected${c.reset}`);
  if (dryRun) console.log(`  ${c.yellow}DRY RUN — no DB writes${c.reset}`);
  console.log('');

  // Read page content once — shared across steps
  const raw = readFileSync(filePath, 'utf-8');
  const body = stripFrontmatter(raw);

  // Resolve entity display name for validation
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  const titleMatch = fmMatch ? fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m) : null;
  const entityName = titleMatch
    ? titleMatch[1]
    : pageId.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  // ------------------------------------------------------------------
  // Step 1: Extract claims from page content
  // ------------------------------------------------------------------
  if (steps.includes('extract')) {
    console.log(`\n${c.bold}Step 1: Extract claims${c.reset}`);

    const cleaned = cleanMdxForExtraction(body);
    const sections = splitIntoSections(cleaned);
    console.log(`  Sections found: ${sections.length}`);

    const allExtracted: Array<{
      claimText: string;
      claimType: string;
      claimMode: 'endorsed' | 'attributed';
      attributedTo?: string;
      asOf?: string;
      measure?: string;
      valueNumeric?: number;
      valueLow?: number;
      valueHigh?: number;
      sourceQuote?: string;
      footnoteRefs: string[];
      relatedEntities?: string[];
      section: string;
    }> = [];

    for (const section of sections) {
      if (section.content.trim().length < 50) continue;
      process.stdout.write(`  ${c.dim}Extracting: ${section.heading.slice(0, 50)}...${c.reset}`);
      try {
        const extracted = await extractClaimsFromSection(section, {
          model,
          systemPrompt: EXTRACT_SYSTEM_PROMPT,
          entityName,
        });
        for (const e of extracted) {
          allExtracted.push({ ...e, section: section.heading });
        }
        console.log(` ${c.green}${extracted.length} claims${c.reset}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(` ${c.red}error: ${msg.slice(0, 80)}${c.reset}`);
      }
    }

    console.log(`\n  Total extracted: ${c.bold}${allExtracted.length}${c.reset} claims`);

    // Post-extraction validation
    const { accepted: validatedExtracted, rejected: rejectedExtracted, stats: extractStats } =
      validateClaimBatch(allExtracted, pageId, entityName, strict);

    if (extractStats.total > 0 && (extractStats.warned > 0 || extractStats.rejected > 0)) {
      console.log(`\n  ${c.bold}Validation:${c.reset}`);
      console.log(`    ${c.green}${extractStats.valid}${c.reset} valid, ${c.yellow}${extractStats.warned}${c.reset} warned, ${c.red}${extractStats.rejected}${c.reset} rejected`);
      if (Object.keys(extractStats.issueBreakdown).length > 0) {
        for (const [issue, cnt] of Object.entries(extractStats.issueBreakdown).sort((a, b) => b[1] - a[1])) {
          console.log(`    ${c.dim}${issue.padEnd(28)} ${cnt}${c.reset}`);
        }
      }
      if (strict && rejectedExtracted.length > 0) {
        console.log(`\n    ${c.yellow}Rejected ${rejectedExtracted.length} claims (--strict)${c.reset}`);
      }
    }

    // Use validated claims going forward
    const allValidated = validatedExtracted;

    if (dryRun) {
      console.log(`\n  ${c.bold}Sample claims (first 5):${c.reset}`);
      for (const clm of allValidated.slice(0, 5)) {
        const refs = clm.footnoteRefs.length > 0 ? ` [^${clm.footnoteRefs.join(', ^')}]` : ' (unsourced)';
        console.log(`    [${clm.claimType}] ${clm.claimText.slice(0, 90)}${refs}`);
      }
      if (allValidated.length > 5) {
        console.log(`    ... and ${allValidated.length - 5} more`);
      }
    } else if (allValidated.length > 0) {
      // Get existing claims to deduplicate
      const existingResult = await getClaimsByEntity(pageId);
      const existingTexts = existingResult.ok
        ? existingResult.data.claims
            .filter(cl => cl.entityId === pageId)
            .map(cl => cl.claimText)
        : [];

      // Deduplicate against existing
      const unique = allValidated.filter(
        clm => !existingTexts.some(t => isClaimDuplicate(clm.claimText, t, 0.75)),
      );
      const dupCount = allValidated.length - unique.length;
      if (dupCount > 0) {
        console.log(`  ${c.dim}Skipped ${dupCount} duplicates of existing claims${c.reset}`);
      }
      console.log(`  ${unique.length} unique claims to insert`);

      // Batch insert in chunks of 50
      const BATCH_SIZE = 50;
      let inserted = 0;
      let failed = 0;

      for (let i = 0; i < unique.length; i += BATCH_SIZE) {
        const batch = unique.slice(i, i + BATCH_SIZE);
        const items: InsertClaimItem[] = batch.map(clm => ({
          entityId: pageId,
          entityType: 'wiki-page',
          claimType: clm.claimType as InsertClaimItem['claimType'],
          claimText: clm.claimText,
          // Legacy fields (kept for backward compat)
          value: clm.section,
          unit: clm.footnoteRefs.length > 0 ? clm.footnoteRefs.join(',') : null,
          confidence: 'unverified', // @deprecated Use claimVerdict instead. Kept for backward compatibility.
          sourceQuote: clm.sourceQuote ?? null,
          // Extraction doesn't verify — leave claimVerdict null (will be set by verify step)
          claimVerdict: null,
          // Enhanced fields
          claimCategory: claimTypeToCategory(clm.claimType as Parameters<typeof claimTypeToCategory>[0]),
          relatedEntities: clm.relatedEntities && clm.relatedEntities.length > 0
            ? clm.relatedEntities
            : null,
          section: clm.section,
          footnoteRefs: clm.footnoteRefs.length > 0 ? clm.footnoteRefs.join(',') : null,
          // Phase 2 fields
          claimMode: clm.claimMode,
          attributedTo: clm.attributedTo ?? null,
          asOf: clm.asOf ?? null,
          measure: clm.measure ?? null,
          valueNumeric: clm.valueNumeric ?? null,
          valueLow: clm.valueLow ?? null,
          valueHigh: clm.valueHigh ?? null,
        }));

        const result = await insertClaimBatch(items);
        if (result.ok) {
          inserted += result.data.inserted;

          // Create claim_page_references for claims with footnoteRefs
          for (let j = 0; j < batch.length; j++) {
            const clm = batch[j];
            const claimId = result.data.results[j]?.id;
            if (!claimId || clm.footnoteRefs.length === 0) continue;

            const refs = clm.footnoteRefs.map(fn => ({
              pageId,
              footnote: parseInt(fn, 10) || null,
              section: clm.section ?? null,
            }));
            await addClaimPageReferencesBatch(claimId, refs);
          }
        } else {
          failed += batch.length;
          console.error(`  ${c.red}Batch insert failed: ${result.message}${c.reset}`);
        }
      }

      console.log(`  ${c.green}Inserted ${inserted} claims${c.reset}`);
      if (failed > 0) {
        console.log(`  ${c.red}Failed ${failed} claims${c.reset}`);
      }
    }
  }

  // ------------------------------------------------------------------
  // Step 2: Link citation_quotes to claims
  // ------------------------------------------------------------------
  if (steps.includes('link')) {
    console.log(`\n${c.bold}Step 2: Link citation_quotes to claims${c.reset}`);

    // Fetch citation quotes for this page
    const quotesResult = await apiRequest<{ quotes: CitationQuote[] }>(
      'GET',
      `/api/citations/quotes?page_id=${encodeURIComponent(pageId)}&limit=500`,
      undefined,
      30_000,
    );

    if (!quotesResult.ok) {
      console.error(`  ${c.red}Failed to fetch citation quotes: ${quotesResult.message}${c.reset}`);
    } else {
      const quotes = quotesResult.data.quotes;
      const unlinked = quotes.filter(q => q.claimId == null);
      console.log(`  ${quotes.length} total quotes, ${unlinked.length} unlinked`);

      if (unlinked.length === 0) {
        console.log(`  ${c.green}All quotes already linked${c.reset}`);
      } else {
        // Fetch claims for this entity
        const claimsResult = await getClaimsByEntity(pageId);
        if (!claimsResult.ok) {
          console.error(`  ${c.red}Failed to fetch claims: ${claimsResult.message}${c.reset}`);
        } else {
          const existingClaims = claimsResult.data.claims.filter(cl => cl.entityId === pageId);
          console.log(`  ${existingClaims.length} claims to match against`);

          const linkItems: Array<{ quoteId: number; claimId: number }> = [];

          for (const q of unlinked) {
            // Find best matching claim by text similarity using Jaccard word similarity
            let bestMatch: { id: number; score: number } | null = null;

            for (const claim of existingClaims) {
              if (isClaimDuplicate(q.claimText, claim.claimText, 0.5)) {
                const score = jaccardWordSimilarity(q.claimText, claim.claimText);
                if (!bestMatch || score > bestMatch.score) {
                  bestMatch = { id: claim.id, score };
                }
              }
            }

            if (bestMatch) {
              linkItems.push({ quoteId: q.id, claimId: bestMatch.id });
            }
          }

          console.log(`  Matched ${linkItems.length} of ${unlinked.length} unlinked quotes`);

          if (dryRun) {
            console.log(`\n  ${c.bold}Sample links (first 3):${c.reset}`);
            for (const item of linkItems.slice(0, 3)) {
              const q = unlinked.find(uq => uq.id === item.quoteId);
              console.log(`    Quote #${item.quoteId} → Claim #${item.claimId}: "${q?.claimText.slice(0, 60)}..."`);
            }
            if (linkItems.length > 3) {
              console.log(`    ... and ${linkItems.length - 3} more`);
            }
          } else if (linkItems.length > 0) {
            // Batch link in chunks of 200
            const LINK_BATCH_SIZE = 200;
            let totalLinked = 0;

            for (let i = 0; i < linkItems.length; i += LINK_BATCH_SIZE) {
              const batch = linkItems.slice(i, i + LINK_BATCH_SIZE);
              const result = await linkCitationsToClaimsBatch(batch);
              if (result.ok) {
                totalLinked += result.data.linked;
              } else {
                console.error(`  ${c.red}Batch link failed: ${result.message}${c.reset}`);
              }
            }

            console.log(`  ${c.green}Linked ${totalLinked} quotes to claims${c.reset}`);

            // Create claim_page_references for each newly linked claim
            const claimPageRefMap = new Map<number, Array<{ pageId: string; footnote: number | null; section: string | null }>>();
            for (const item of linkItems) {
              const quote = unlinked.find(q => q.id === item.quoteId);
              if (!quote) continue;
              if (!claimPageRefMap.has(item.claimId)) {
                claimPageRefMap.set(item.claimId, []);
              }
              claimPageRefMap.get(item.claimId)!.push({
                pageId: quote.pageId,
                footnote: quote.footnote,
                section: quote.claimContext ?? null,
              });
            }

            let totalRefs = 0;
            for (const [claimId, refs] of claimPageRefMap) {
              const result = await addClaimPageReferencesBatch(claimId, refs);
              if (result.ok) {
                totalRefs += result.data.inserted;
              }
            }

            if (totalRefs > 0) {
              console.log(`  ${c.green}Created ${totalRefs} claim_page_references${c.reset}`);
            }
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Step 3: Verify claims against sources
  // ------------------------------------------------------------------
  if (steps.includes('verify')) {
    console.log(`\n${c.bold}Step 3: Verify & propagate verdicts${c.reset}`);

    if (dryRun) {
      console.log(`  ${c.yellow}[DRY RUN] Would run claim verification and propagate to citation_quotes${c.reset}`);
    } else {
      // Propagate any existing claim verdicts to citation_quotes
      const propResult = await propagateClaimVerdictsToPage(pageId);
      if (propResult.ok) {
        const { propagated, skipped } = propResult.data;
        if (propagated > 0) {
          console.log(`  ${c.green}Propagated ${propagated} claim verdicts to citation_quotes${c.reset}`);
        }
        if (skipped > 0) {
          console.log(`  ${c.dim}Skipped ${skipped} (unverified claims)${c.reset}`);
        }
        if (propagated === 0 && skipped === 0) {
          console.log(`  ${c.dim}No linked claims found to propagate${c.reset}`);
        }
      } else {
        console.log(`  ${c.yellow}Propagation failed: ${propResult.message}${c.reset}`);
      }

      console.log(`\n  For full LLM-based verification, run separately:`);
      console.log(`    ${c.bold}pnpm crux claims verify ${pageId}${c.reset}`);
    }
  }

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  console.log(`\n${c.green}${c.bold}Pipeline complete.${c.reset}`);
  console.log(`  Next steps:`);
  if (!steps.includes('verify')) {
    console.log(`    pnpm crux claims verify ${pageId}    # Verify claims against source text`);
  }
  console.log(`    pnpm crux claims status ${pageId}    # Show claim breakdown`);
  console.log('');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Claims pipeline failed:', err);
    process.exit(1);
  });
}
